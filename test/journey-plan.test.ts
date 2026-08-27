import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTrip } from './helpers/network';

// Replace the walking layer: the real module loads the Ann Arbor street graph
// at import time and its durations would make expected values opaque.
vi.mock('../src/walking/walkingMap', () => ({
    buildStopNodeMap: vi.fn(),
    ensureCacheForStops: vi.fn().mockResolvedValue(undefined),
    getCachedWalk: vi.fn().mockReturnValue(undefined),
    getWalkingDistancesFrom: vi.fn().mockReturnValue([]),
    getWalkingResponse: vi.fn().mockResolvedValue({ duration: 77, distance: 100, path_coords: [{ lat: 42.28, lon: -83.73 }] }),
}));

import * as walking from '../src/walking/walkingMap';
import * as state from '../src/state/transitState';
import { planJourney } from '../src/services/journey';

const ORIGIN = { lat: 42.2645, lon: -83.7443 };
const DEST = { lat: 42.2910, lon: -83.7176 };
const TIME = 36000; // 10:00

// planJourney's return type includes the nulls it filters out; the tests
// assert on the actual shape.
async function plan(time: number, options: { walkingPenalty?: number, range?: number }): Promise<any[]> {
    return await planJourney(ORIGIN.lat, ORIGIN.lon, DEST.lat, DEST.lon, time, options) as any[];
}

function setWalks(
    fromOrigin: { stopId: string, duration: number }[],
    toDest: { stopId: string, duration: number }[]
) {
    vi.mocked(walking.getWalkingDistancesFrom).mockImplementation(
        (_lat, _lon, destLat) => destLat === undefined ? toDest : fromOrigin
    );
}

function setGraph(trips: ReturnType<typeof makeTrip>[]) {
    state.setCachedGraph({
        trips: [
            ...trips,
            makeTrip('VIRTUAL_ORIGIN_TRIP', null, [{ stop: 'VIRTUAL_ORIGIN', arr: 0 }]),
            makeTrip('VIRTUAL_DESTINATION_TRIP', null, [{ stop: 'VIRTUAL_DESTINATION', arr: 0 }]),
        ],
        transfers: {},
        interchange: { C250: 30, N551: 30 },
    });
}

beforeEach(() => {
    setGraph([]);
    state.setCachedStopLocations({
        C250: { name: 'Central Campus Transit Center', lat: 42.2783, lon: -83.7354 },
        N551: { name: 'Pierpont Commons', lat: 42.2910, lon: -83.7176 },
    });
    state.stopIdToName['C250'] = 'Central Campus Transit Center';
    state.stopIdToName['N551'] = 'Pierpont Commons';
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('planJourney end-to-end (mocked walking layer)', () => {
    it('plans walk -> bus -> walk and a direct-walk alternative, formatted for the frontend', async () => {
        setGraph([makeTrip('trip_bb', '4001', [
            { stop: 'C250', arr: TIME + 300, rt: 'BB' },
            { stop: 'N551', arr: TIME + 600, rt: 'BB' },
        ])]);
        setWalks(
            [{ stopId: 'C250', duration: 120 }, { stopId: 'DIRECT_WALK', duration: 3600 }],
            [{ stopId: 'N551', duration: 60 }]
        );

        const journeys = await plan(TIME, {});
        expect(journeys).toHaveLength(2);

        const [bus, walkOnly] = journeys;
        expect(bus.criteria).toEqual({ arrivalTime: TIME + 660, walkingDistance: 180, transferCount: 1 });
        expect(bus.legs.map((l: any) => l.mode)).toEqual(['walk', 'bus', 'walk']);
        expect(bus.legs[0]).toMatchObject({
            origin: 'Start',
            origin_id: 'VIRTUAL_ORIGIN',
            destination: 'Central Campus Transit Center',
            destination_id: 'C250',
            startTime: TIME,
            endTime: TIME + 120,
        });
        expect(bus.legs[1]).toMatchObject({
            tripId: 'trip_bb',
            vid: '4001',
            rt: 'BB',
            startTime: TIME + 300,
            endTime: TIME + 600,
        });
        expect(bus.legs[2]).toMatchObject({ destination: 'End', destination_id: 'VIRTUAL_DESTINATION' });

        expect(walkOnly.legs).toHaveLength(1);
        expect(walkOnly.legs[0].mode).toBe('walk');
        expect(walkOnly.criteria).toEqual({ arrivalTime: TIME + 3600, walkingDistance: 3600, transferCount: 0 });
    });

    it('reports the true departure time even when there is wait time before boarding', async () => {
        setGraph([makeTrip('trip_bb', '4001', [
            { stop: 'C250', arr: TIME + 300, rt: 'BB' },
            { stop: 'N551', arr: TIME + 600, rt: 'BB' },
        ])]);
        setWalks([{ stopId: 'C250', duration: 120 }], [{ stopId: 'N551', duration: 60 }]);

        const journeys = await plan(TIME, {});
        // The walk ends at TIME+120 but the bus leaves at TIME+300: the journey
        // still starts at TIME. The old arrival-minus-durations math reported a
        // departure inside the waiting gap.
        expect(journeys[0].departureTime).toBe(TIME);
        expect(journeys[0].arrivalTime).toBe(TIME + 660);
    });

    it('returns only the direct walk when no bus is available', async () => {
        setWalks([{ stopId: 'DIRECT_WALK', duration: 3600 }], []);

        const journeys = await plan(TIME, {});
        expect(journeys).toHaveLength(1);
        expect(journeys[0].legs).toHaveLength(1);
        expect(journeys[0].legs[0]).toMatchObject({ mode: 'walk', origin: 'Start', destination: 'End' });
        expect(journeys[0].departureTime).toBe(TIME);
    });

    it('applies the walkingPenalty option to the walking criterion', async () => {
        setGraph([makeTrip('trip_bb', '4001', [
            { stop: 'C250', arr: TIME + 300, rt: 'BB' },
            { stop: 'N551', arr: TIME + 600, rt: 'BB' },
        ])]);
        setWalks([{ stopId: 'C250', duration: 120 }], [{ stopId: 'N551', duration: 60 }]);

        const journeys = await plan(TIME, { walkingPenalty: 8 });
        expect(journeys[0].criteria.walkingDistance).toBe((120 + 60) * 8);
        expect(journeys[0].criteria.arrivalTime).toBe(TIME + 660); // penalty never slows the clock
    });

    it('returns one journey per catchable departure when a range is given', async () => {
        setGraph([
            makeTrip('run0', '4001', [
                { stop: 'C250', arr: TIME + 300, rt: 'BB' },
                { stop: 'N551', arr: TIME + 600, rt: 'BB' },
            ]),
            makeTrip('run1', '4002', [
                { stop: 'C250', arr: TIME + 1500, rt: 'BB' },
                { stop: 'N551', arr: TIME + 1800, rt: 'BB' },
            ]),
        ]);
        setWalks(
            [{ stopId: 'C250', duration: 120 }, { stopId: 'DIRECT_WALK', duration: 3600 }],
            [{ stopId: 'N551', duration: 60 }]
        );

        const journeys = await plan(TIME, { range: 3600 });
        expect(journeys.map((j: any) => j.arrivalTime)).toEqual([TIME + 660, TIME + 1860, TIME + 3600]);
        const tripIds = journeys.flatMap((j: any) => j.legs.filter((l: any) => l.mode === 'bus').map((l: any) => l.tripId));
        expect(tripIds).toEqual(['run0', 'run1']);
    });
});
