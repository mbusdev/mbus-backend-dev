import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prd, predictionChunk, pattern } from './helpers/mockBusApi';

// The walking module loads the full street graph at import time and the API
// modules talk to the real feeds; both are replaced before graphBuilder loads.
vi.mock('../src/walking/walkingMap', () => ({
    buildStopNodeMap: vi.fn(),
    ensureCacheForStops: vi.fn().mockResolvedValue(undefined),
    getCachedWalk: vi.fn().mockReturnValue(undefined),
    getWalkingDistancesFrom: vi.fn().mockReturnValue([]),
    getWalkingResponse: vi.fn().mockResolvedValue({ duration: 0, distance: 0, path_coords: [] }),
}));
vi.mock('../src/services/mbus', () => ({
    fetchVehicles: vi.fn().mockResolvedValue([]),
    fetchRoutes: vi.fn().mockResolvedValue([]),
    fetchPatterns: vi.fn().mockResolvedValue([]),
    fetchPredictions: vi.fn().mockResolvedValue([]),
}));
vi.mock('../src/services/ride', () => ({
    fetchVehicles: vi.fn().mockResolvedValue([]),
    fetchRoutes: vi.fn().mockResolvedValue([]),
    fetchPatterns: vi.fn().mockResolvedValue([]),
    fetchPredictions: vi.fn().mockResolvedValue([]),
}));

import * as state from '../src/state/transitState';
import * as mbus from '../src/services/mbus';
import * as rideBus from '../src/services/ride';
import { hasBusTimeSystemError } from '../src/services/bustimeClient';
import {
    processPredictions, processRidePredictions, convertToTrips, rebuildGraph,
    findNearestStops, updateBusPositions, initializeRoutes, currentGraphTimeSeconds,
} from '../src/services/graphBuilder';

const TT_STOPS = [
    { stpid: 'T1', stpnm: 'Central Campus Transit Center', lat: 42.2783, lon: -83.7354 },
    { stpid: 'T2', stpnm: 'Rackham Bldg', lat: 42.2801, lon: -83.7382 },
    { stpid: 'T3', stpnm: 'Pierpont Commons', lat: 42.2910, lon: -83.7176 },
];

function clearRecord(record: Record<string, unknown>) {
    for (const key of Object.keys(record)) delete record[key];
}

beforeEach(() => {
    clearRecord(state.cachedRoutes);
    clearRecord(state.cachedRideRoutes);
    clearRecord(state.routeTimingCache);
    clearRecord(state.stopIdToName);
    clearRecord(state.tatripidToRt);
    clearRecord(state.cachedPredsByVid);
    clearRecord(state.cachedPredsByStopId);
    state.setCachedGraph({ trips: [], transfers: {}, interchange: {} });
    state.setCachedGraphTimeBase(0);
    state.setCachedStopLocations({});
    state.validRoutes.clear();
    state.validRideRoutes.clear();
    state.curBusPositions.buses = [];
    state.curRidePositions.buses = [];

    state.cachedRoutes['TT'] = [pattern('NORTHBOUND', TT_STOPS)];
});

afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
});

function ttPrd(stpid: string, prdctdn: string, overrides: Record<string, unknown> = {}) {
    const stop = TT_STOPS.find(s => s.stpid === stpid)!;
    return prd({
        stpid, stpnm: stop.stpnm, rt: 'TT', rtdir: 'NORTHBOUND', prdctdn,
        vid: '4001', tatripid: '888001', des: 'Northbound', ...overrides,
    });
}

describe('processPredictions with realistic BusTime payloads', () => {
    it('groups predictions into trips, converts DUE to 1 minute, and matches missing tatripid by vid', () => {
        const chunks = [predictionChunk([
            ttPrd('T1', 'DUE'),
            ttPrd('T2', '4'),
            // Real feed sometimes omits tatripid; the entry must fold into the same vehicle.
            ttPrd('T3', '9', { tatripid: undefined }),
        ])];

        const trips = processPredictions(chunks);
        expect(trips).toHaveLength(1);
        expect(trips[0].tatripid).toBe('888001');
        expect(trips[0].vid).toBe('4001');
        expect(trips[0].stops.map((s: any) => [s.stpid, s.prdctdn])).toEqual([
            ['T1', '1'], // DUE -> 1
            ['T2', '4'],
            ['T3', '9'],
        ]);
    });

    it('sorts stops by countdown, breaking ties by position along the route pattern', () => {
        // T1 and T2 both at 2 minutes; the pattern order (T1 before T2) decides.
        const chunks = [predictionChunk([
            ttPrd('T3', '7'),
            ttPrd('T2', '2'),
            ttPrd('T1', '2'),
        ])];

        const trips = processPredictions(chunks);
        expect(trips[0].stops.map((s: any) => s.stpid)).toEqual(['T1', 'T2', 'T3']);
    });

    it('learns stop-to-stop timing diffs into the route timing cache', () => {
        processPredictions([predictionChunk([
            ttPrd('T1', '1'),
            ttPrd('T2', '4'),
            ttPrd('T3', '9'),
        ])]);

        expect(state.routeTimingCache['TT']['T1NORTHBOUND']).toEqual({
            T2: { diff: 3, rtdir: 'NORTHBOUND', rtNext: 'TT' },
        });
        expect(state.routeTimingCache['TT']['T2NORTHBOUND']).toEqual({
            T3: { diff: 5, rtdir: 'NORTHBOUND', rtNext: 'TT' },
        });
    });

    it('extrapolates future stops from the timing cache, capped at 20 added stops', () => {
        state.setCachedStopLocations(Object.fromEntries(
            TT_STOPS.map(s => [s.stpid, { name: s.stpnm, lat: s.lat, lon: s.lon }])
        ));
        // Close the loop so extrapolation can continue T3 -> T1 like a circulating bus.
        state.routeTimingCache['TT'] = {
            T3NORTHBOUND: { T1: { diff: 4, rtdir: 'NORTHBOUND', rtNext: 'TT' } },
        };

        const trips = processPredictions([predictionChunk([
            ttPrd('T1', '1'),
            ttPrd('T2', '4'),
            ttPrd('T3', '9'),
        ])]);

        const stops = trips[0].stops;
        expect(stops).toHaveLength(3 + 20); // hard cap of 20 extrapolated stops
        expect(stops.slice(3).every((s: any) => s.isExtrapolated)).toBe(true);
        // First extrapolated hop: T3 at 9 min + learned diff 4 -> T1 at 13 min, with the cached name.
        expect(stops[3]).toMatchObject({ stpid: 'T1', prdctdn: '13', stpnm: 'Central Campus Transit Center' });
        // The cycle continues with the diffs learned from this very payload (T1->T2: 3, T2->T3: 5).
        expect(stops[4]).toMatchObject({ stpid: 'T2', prdctdn: '16' });
        expect(stops[5]).toMatchObject({ stpid: 'T3', prdctdn: '21' });
    });

    it('keeps each pass of a looping bus as a separate stop event', () => {
        // A looping bus reports T1 twice (in 1 min and again in 11 min after
        // the loop); both passes must survive, in countdown order.
        const trips = processPredictions([predictionChunk([
            ttPrd('T1', '1'),
            ttPrd('T2', '5'),
            ttPrd('T1', '11'),
        ])]);

        expect(trips[0].stops.map((s: any) => [s.stpid, s.prdctdn, !!s.isExtrapolated])).toEqual([
            ['T1', '1', false],
            ['T2', '5', false],
            ['T1', '11', false],
            // Extrapolation continues the loop using the T1->T2 timing (diff 4)
            // learned from this very payload.
            ['T2', '15', true],
        ]);
    });

    it('still merges duplicate reports of the same pass', () => {
        // Same stop, same pass ("DUE" normalizes to "1"): one stop event.
        const trips = processPredictions([predictionChunk([
            ttPrd('T1', 'DUE'),
            ttPrd('T1', '1'),
            ttPrd('T2', '5'),
        ])]);

        expect(trips[0].stops.map((s: any) => [s.stpid, s.prdctdn])).toEqual([
            ['T1', '1'],
            ['T2', '5'],
        ]);
    });

    it('learns the loop-closure timing from a looping bus (last pattern stop back to first)', () => {
        processPredictions([predictionChunk([
            ttPrd('T1', '2'),
            ttPrd('T2', '5'),
            ttPrd('T3', '9'),
            ttPrd('T1', '15'),
        ])]);

        expect(state.routeTimingCache['TT']['T3NORTHBOUND']).toEqual({
            T1: { diff: 6, rtdir: 'NORTHBOUND', rtNext: 'TT' },
        });
    });

    it('does not merge tatripid-less predictions from different vehicles', () => {
        // Matching undefined === undefined used to fold every tatripid-less
        // prediction into the first such vehicle's trip.
        const trips = processPredictions([predictionChunk([
            ttPrd('T1', '2', { tatripid: undefined, vid: '4001' }),
            ttPrd('T2', '5', { tatripid: undefined, vid: '4002' }),
        ])]);

        expect(trips).toHaveLength(2);
        expect(trips.map((t: any) => [t.vid, t.stops.length])).toEqual([
            ['4001', 1],
            ['4002', 1],
        ]);
    });

    it('sorts delayed ("DLY") stops last and never learns timing from them', () => {
        const trips = processPredictions([predictionChunk([
            ttPrd('T2', 'DLY'),
            ttPrd('T1', '2'),
            ttPrd('T3', '8'),
        ])]);

        expect(trips[0].stops.map((s: any) => s.stpid)).toEqual(['T1', 'T3', 'T2']);
        // T1->T3 is not consecutive in the pattern and T3->T2 has no countdown,
        // so nothing valid can be learned.
        expect(state.routeTimingCache['TT']).toBeUndefined();
    });
});

describe('convertToTrips', () => {
    it('converts countdowns to seconds-since-UTC-midnight stop times and appends virtual trips', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-26T12:00:00Z')); // 43200s since midnight UTC

        const trips = convertToTrips([{
            tatripid: '888001', vid: '4001',
            stops: [
                { stpid: 'T2', prdctdn: '5', rt: 'TT' },
                { stpid: 'T1', prdctdn: '2', rt: 'TT' },
                { stpid: 'T3', prdctdn: '9', rt: 'TT' },
            ],
        }]);

        expect(trips).toHaveLength(3); // 1 real + 2 virtual
        const real = trips[0];
        expect(real.tripId).toBe('888001');
        // Sorted by arrival time regardless of input order.
        expect(real.stopTimes.map(st => [st.stop, st.arrivalTime])).toEqual([
            ['T1', 43200 + 120],
            ['T2', 43200 + 300],
            ['T3', 43200 + 540],
        ]);
        expect(real.stopTimes.every(st => st.pickUp && st.dropOff)).toBe(true);
        expect(real.stopTimes.every(st => st.arrivalTime === st.departureTime)).toBe(true);

        expect(trips[1].tripId).toBe('VIRTUAL_ORIGIN_TRIP');
        expect(trips[2].tripId).toBe('VIRTUAL_DESTINATION_TRIP');
    });

    it('produces a loop trip whose stop appears twice in the routing graph', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-26T12:00:00Z'));

        const preds = processPredictions([predictionChunk([
            ttPrd('T1', '1'),
            ttPrd('T2', '5'),
            ttPrd('T1', '11'),
        ])]);
        const trips = convertToTrips(preds);

        expect(trips[0].stopTimes.map(st => [st.stop, st.arrivalTime])).toEqual([
            ['T1', 43200 + 60],
            ['T2', 43200 + 300],
            ['T1', 43200 + 660],
            ['T2', 43200 + 900], // extrapolated continuation of the loop
        ]);
    });

    it('excludes delayed stops from routing trips and drops fully delayed vehicles', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-26T12:00:00Z'));

        const preds = processPredictions([predictionChunk([
            ttPrd('T1', '2'),
            ttPrd('T2', 'DLY'),
            ttPrd('T3', '8'),
            ttPrd('T1', 'DLY', { vid: '4002', tatripid: '888002' }),
        ])]);
        const trips = convertToTrips(preds);

        // The delayed stop is dropped from the schedule; the delayed stop still
        // surfaces in the prediction lists shown to users.
        expect(trips[0].stopTimes.map(st => st.stop)).toEqual(['T1', 'T3']);
        expect(trips[0].stopTimes.every(st => Number.isFinite(st.arrivalTime))).toBe(true);
        expect(preds[0].stops.some((s: any) => s.prdctdn === 'DLY')).toBe(true);

        // The all-delayed vehicle contributes no trip at all (only virtuals follow).
        expect(trips.map(t => t.tripId)).toEqual(['888001', 'VIRTUAL_ORIGIN_TRIP', 'VIRTUAL_DESTINATION_TRIP']);
    });
});

describe('delayed ("DLY") predictions surface to the frontend', () => {
    it('keeps DLY entries in the prediction caches, sorted last, but out of the routing graph', async () => {
        vi.mocked(mbus.fetchPredictions).mockResolvedValue([predictionChunk([
            ttPrd('T1', '3'),
            ttPrd('T2', 'DLY'),
        ])]);
        await rebuildGraph();

        // Surfaced to the prediction endpoints with a finite far-future prdtm.
        expect(state.cachedPredsByStopId['T2']).toHaveLength(1);
        expect(state.cachedPredsByStopId['T2'][0].prdctdn).toBe('DLY');
        expect(Number.isFinite(state.cachedPredsByStopId['T2'][0].prdtm)).toBe(true);
        // Sorted after real countdowns in the per-vehicle list.
        expect(state.cachedPredsByVid['4001'].map((p: any) => p.prdctdn)).toEqual(['3', 'DLY']);
        // Routing still cannot use a stop with no usable time.
        expect(state.cachedGraph.trips[0].stopTimes.map(st => st.stop)).toEqual(['T1']);
    });
});

describe('graph time frame across UTC midnight', () => {
    it('keeps request time in the graph frame after the clock wraps', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-26T23:59:30Z'));

        const trips = convertToTrips([{
            tatripid: '888001', vid: '4001',
            stops: [{ stpid: 'T1', prdctdn: '5', rt: 'TT' }],
        }]);
        // 23:59:30 = 86370s into the day; bus due 5 min later.
        expect(trips[0].stopTimes[0].arrivalTime).toBe(86370 + 300);

        // 60s later the wall clock has crossed UTC midnight, but the graph has
        // not been rebuilt: request time must stay in the graph's frame
        // instead of wrapping to ~30 while trip times sit near 86400.
        vi.setSystemTime(new Date('2026-08-27T00:00:30Z'));
        expect(currentGraphTimeSeconds()).toBe(86430);
    });
});

describe('resilience to transient feed failures', () => {
    it('keeps the previous graph and predictions when a prediction chunk fails', async () => {
        vi.mocked(mbus.fetchPredictions).mockResolvedValue([predictionChunk([ttPrd('T1', '2')])]);
        await rebuildGraph();
        const goodTrips = state.cachedGraph.trips;
        expect(state.cachedPredsByStopId['T1']).toBeDefined();

        // One chunk errored: everything from the previous cycle must survive.
        vi.mocked(mbus.fetchPredictions).mockResolvedValue([null]);
        await rebuildGraph();
        expect(state.cachedGraph.trips).toBe(goodTrips);
        expect(state.cachedPredsByStopId['T1']).toBeDefined();
    });

    it('keeps previous bus positions when the vehicles fetch fails, but accepts a real empty result', async () => {
        state.curBusPositions.buses = [{ vid: '4001' }];

        vi.mocked(mbus.fetchVehicles).mockResolvedValue(null);
        vi.mocked(rideBus.fetchVehicles).mockResolvedValue(null);
        await updateBusPositions();
        expect(state.curBusPositions.buses).toEqual([{ vid: '4001' }]);

        vi.mocked(mbus.fetchVehicles).mockResolvedValue([]);
        vi.mocked(rideBus.fetchVehicles).mockResolvedValue([]);
        await updateBusPositions();
        expect(state.curBusPositions.buses).toEqual([]);
    });

    it('keeps existing valid routes and patterns when the routes fetch fails', async () => {
        state.validRoutes.add('TT');

        vi.mocked(mbus.fetchRoutes).mockResolvedValue([]);
        vi.mocked(rideBus.fetchRoutes).mockResolvedValue([]);
        await initializeRoutes();

        expect(state.validRoutes.has('TT')).toBe(true);
        expect(state.cachedRoutes['TT']).toHaveLength(1);
    });

    it('keeps previously cached patterns when a pattern fetch fails', async () => {
        vi.mocked(mbus.fetchRoutes).mockResolvedValue([{ rt: 'TT' }]);
        vi.mocked(rideBus.fetchRoutes).mockResolvedValue([]);
        vi.mocked(mbus.fetchPatterns).mockResolvedValue([]); // what a failed fetch returns

        await initializeRoutes();

        expect(state.validRoutes.has('TT')).toBe(true);
        expect(state.cachedRoutes['TT']).toHaveLength(1); // pre-existing pattern kept
    });
});

describe('processRidePredictions', () => {
    function ridePrd(stpid: string, prdctdn: string, overrides: Record<string, unknown> = {}) {
        return prd({ stpid, stpnm: stpid, rt: '4', rtdir: 'EASTBOUND', prdctdn, vid: '2201', tatripid: '77001', ...overrides });
    }

    it('keeps ride "DLY" prdtm finite so sorted prediction lists stay valid', () => {
        const trips = processRidePredictions([predictionChunk([
            ridePrd('R1', '4'),
            ridePrd('R2', 'DLY'),
        ])]);

        const stops = trips[0].stops;
        expect(stops.every((s: any) => Number.isFinite(s.prdtm))).toBe(true);
        const delayed = stops.find((s: any) => s.prdctdn === 'DLY');
        const normal = stops.find((s: any) => s.prdctdn === '4');
        expect(delayed.prdtm).toBeGreaterThan(normal.prdtm); // sorts after real predictions
    });

    it('keeps loop passes separate and does not merge tatripid-less vehicles (ride)', () => {
        const trips = processRidePredictions([predictionChunk([
            ridePrd('R1', '1'),
            ridePrd('R1', '11'),
            ridePrd('R2', '3', { tatripid: undefined, vid: '2202' }),
            ridePrd('R3', '6', { tatripid: undefined, vid: '2203' }),
        ])]);

        expect(trips).toHaveLength(3);
        expect(trips[0].stops.map((s: any) => [s.stpid, s.prdctdn])).toEqual([['R1', '1'], ['R1', '11']]);
        expect(trips.slice(1).map((t: any) => t.vid)).toEqual(['2202', '2203']);
    });
});

describe('hasBusTimeSystemError', () => {
    it('flags system errors and out-of-protocol bodies, but not per-stop errors', () => {
        // Benign: per-stop/per-route "no data" entries are part of a healthy response.
        expect(hasBusTimeSystemError({ 'bustime-response': { error: [{ stpid: 'C250', msg: 'No arrival times' }] } })).toBe(false);
        expect(hasBusTimeSystemError({ 'bustime-response': { error: [{ rt: 'BB', msg: 'No data found for parameter' }] } })).toBe(false);
        expect(hasBusTimeSystemError({ 'bustime-response': { prd: [] } })).toBe(false);

        // System errors: whole request failed despite the HTTP 200.
        expect(hasBusTimeSystemError({ 'bustime-response': { error: [{ msg: 'Transaction limit for current day has been exceeded.' }] } })).toBe(true);

        // Out-of-protocol 200 bodies (proxy maintenance page, junk) must be
        // failures too, or they would wipe live caches as "no buses".
        expect(hasBusTimeSystemError('<html>maintenance</html>')).toBe(true);
        expect(hasBusTimeSystemError({})).toBe(true);
        expect(hasBusTimeSystemError({ 'bustime-response': { error: { msg: 'non-array error' } } })).toBe(true);
        expect(hasBusTimeSystemError(undefined)).toBe(true);
    });
});

describe('findNearestStops', () => {
    it('returns the k nearest stops sorted by distance regardless of iteration order', () => {
        // Listed farthest-first to exercise the heap eviction path.
        state.setCachedStopLocations({
            FAR: { name: 'Far', lat: 42.28, lon: -83.70 },
            MID: { name: 'Mid', lat: 42.28, lon: -83.72 },
            NEAR: { name: 'Near', lat: 42.28, lon: -83.73 },
            NEAREST: { name: 'Nearest', lat: 42.28, lon: -83.735 },
        });

        const result = findNearestStops(42.28, -83.7354, 2);
        expect(result.map(r => r.stpid)).toEqual(['NEAREST', 'NEAR']);
        expect(result[0].distance).toBeLessThan(result[1].distance);
    });

    it('returns all stops when k exceeds the stop count', () => {
        state.setCachedStopLocations({
            A: { name: 'A', lat: 42.28, lon: -83.73 },
            B: { name: 'B', lat: 42.28, lon: -83.72 },
        });

        expect(findNearestStops(42.28, -83.7354, 5).map(r => r.stpid)).toEqual(['A', 'B']);
    });

    it('rejects invalid coordinates', () => {
        expect(() => findNearestStops(NaN, -83.7, 2)).toThrow();
    });
});

describe('rebuildGraph end-to-end with a mocked feed', () => {
    it('builds the routing graph and lookup maps from raw prediction chunks', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-26T12:00:00Z'));

        vi.mocked(mbus.fetchPredictions).mockResolvedValue([predictionChunk([
            ttPrd('T1', '2'),
            ttPrd('T2', '6'),
        ])]);

        await rebuildGraph();

        // Predictions were requested for exactly the stops in the cached patterns.
        const [stopIds] = vi.mocked(mbus.fetchPredictions).mock.calls[0];
        expect([...stopIds].sort()).toEqual(['T1', 'T2', 'T3']);

        const graphTrips = state.cachedGraph.trips;
        expect(graphTrips.map(t => t.tripId)).toEqual(['888001', 'VIRTUAL_ORIGIN_TRIP', 'VIRTUAL_DESTINATION_TRIP']);
        expect(graphTrips[0].stopTimes.map(st => [st.stop, st.arrivalTime])).toEqual([
            ['T1', 43200 + 120],
            ['T2', 43200 + 360],
        ]);

        // Lookup maps used by journey formatting and the prediction endpoints.
        expect(state.stopIdToName['T1']).toBe('Central Campus Transit Center');
        expect(state.stopIdToName['T3']).toBe('Pierpont Commons');
        expect(state.tatripidToRt['888001']).toBe('TT');
        expect(state.cachedPredsByVid['4001']).toHaveLength(2);
        expect(state.cachedPredsByStopId['T1'][0]).toMatchObject({ vid: '4001', rt: 'TT' });
    });
});
