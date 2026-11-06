import { describe, it, expect, beforeEach } from 'vitest';

import * as onBus from '@/services/onBus';
import * as state from '@/state/transitState';
import { adjustDueTripsAtStop } from '@/services/journey';
import { LocationSample, Trip } from '@/raptor/types';

const BASE_LAT = 42.27;
const BASE_LON = -83.73;
const M_PER_DEG_LAT = 111320;

/** Converts a northward offset in meters to degrees of latitude. */
function offsetLat(meters: number): number {
    return meters / M_PER_DEG_LAT;
}

function resetState() {
    state.curBusPositions.buses = [];
    for (const key of Object.keys(state.busPositionHistory)) delete state.busPositionHistory[key];
    for (const key of Object.keys(state.cachedPredsByVid)) delete state.cachedPredsByVid[key];
    state.setCachedStopLocations({});
    state.setCachedGraph({ trips: [], transfers: {}, interchange: {} });
}

/** Seeds a bus's history and live position. The last sample is the live position. */
function seedBus(vid: string, samples: { lat: number, lon: number, timestamp: number }[], extra: any = {}) {
    state.busPositionHistory[vid] = samples.map(s => ({ ...s }));
    const last = samples[samples.length - 1];
    state.curBusPositions.buses.push({
        vid,
        lat: String(last.lat),
        lon: String(last.lon),
        ...extra,
    });
}

describe('classifyOnBusStatus', () => {
    beforeEach(resetState);

    it('confirms on_bus when user moves with a moving bus', () => {
        const t0 = Date.now();
        // Bus heading north at 8 m/s (60m per 7.5s poll)
        seedBus('341', [
            { lat: BASE_LAT, lon: BASE_LON, timestamp: t0 - 15000 },
            { lat: BASE_LAT + offsetLat(60), lon: BASE_LON, timestamp: t0 - 7500 },
            { lat: BASE_LAT + offsetLat(120), lon: BASE_LON, timestamp: t0 },
        ], { rt: 'CN' });

        // User co-located (5m east offset), same northward speed
        const lonOffset = 5 / (M_PER_DEG_LAT * Math.cos(BASE_LAT * Math.PI / 180));
        const trail: LocationSample[] = [0, 5000, 10000, 15000].map(dt => ({
            lat: BASE_LAT + offsetLat(8 * dt / 1000),
            lon: BASE_LON + lonOffset,
            timestamp: t0 - 15000 + dt,
        }));

        const result = onBus.classifyOnBusStatus(
            BASE_LAT + offsetLat(120), BASE_LON + lonOffset, trail
        );
        expect(result.status).toBe('on_bus');
        expect(result.vid).toBe('341');
        expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('classifies waiting_at_stop when user and bus are both stationary at a stop', () => {
        const t0 = Date.now();
        state.setCachedStopLocations({
            'C250': { name: 'Central Campus Transit Center', lat: BASE_LAT, lon: BASE_LON },
        });
        // Bus parked 20m north of the stop
        const busLat = BASE_LAT + offsetLat(20);
        seedBus('341', [
            { lat: busLat, lon: BASE_LON, timestamp: t0 - 15000 },
            { lat: busLat, lon: BASE_LON, timestamp: t0 - 7500 },
            { lat: busLat, lon: BASE_LON, timestamp: t0 },
        ]);

        // User stationary at the stop
        const trail: LocationSample[] = [0, 5000, 10000, 15000].map(dt => ({
            lat: BASE_LAT, lon: BASE_LON, timestamp: t0 - 15000 + dt,
        }));

        const result = onBus.classifyOnBusStatus(BASE_LAT, BASE_LON, trail);
        expect(result.status).toBe('waiting_at_stop');
    });

    it('classifies near_bus when a moving bus passes a stationary user', () => {
        const t0 = Date.now();
        seedBus('341', [
            { lat: BASE_LAT - offsetLat(110), lon: BASE_LON, timestamp: t0 - 15000 },
            { lat: BASE_LAT - offsetLat(50), lon: BASE_LON, timestamp: t0 - 7500 },
            { lat: BASE_LAT + offsetLat(10), lon: BASE_LON, timestamp: t0 },
        ]);

        const trail: LocationSample[] = [0, 5000, 10000, 15000].map(dt => ({
            lat: BASE_LAT, lon: BASE_LON, timestamp: t0 - 15000 + dt,
        }));

        const result = onBus.classifyOnBusStatus(BASE_LAT, BASE_LON, trail);
        expect(result.status).toBe('near_bus');
    });

    it('classifies not_near_bus when no bus is within proximity', () => {
        const t0 = Date.now();
        seedBus('341', [
            { lat: BASE_LAT + offsetLat(500), lon: BASE_LON, timestamp: t0 - 7500 },
            { lat: BASE_LAT + offsetLat(500), lon: BASE_LON, timestamp: t0 },
        ]);

        const trail: LocationSample[] = [0, 5000, 10000, 15000].map(dt => ({
            lat: BASE_LAT, lon: BASE_LON, timestamp: t0 - 15000 + dt,
        }));

        const result = onBus.classifyOnBusStatus(BASE_LAT, BASE_LON, trail);
        expect(result.status).toBe('not_near_bus');
    });

    it('keeps on_bus when the bus stops at a stop after co-movement (rider aboard)', () => {
        const t0 = Date.now();
        const stopLat = BASE_LAT + offsetLat(120);
        state.setCachedStopLocations({
            'C250': { name: 'Central Campus Transit Center', lat: stopLat, lon: BASE_LON },
        });
        // Bus drives north then dwells at the stop
        seedBus('341', [
            { lat: BASE_LAT, lon: BASE_LON, timestamp: t0 - 30000 },
            { lat: BASE_LAT + offsetLat(60), lon: BASE_LON, timestamp: t0 - 22500 },
            { lat: stopLat, lon: BASE_LON, timestamp: t0 - 15000 },
            { lat: stopLat, lon: BASE_LON, timestamp: t0 - 7500 },
            { lat: stopLat, lon: BASE_LON, timestamp: t0 },
        ]);

        // User rode along, then stayed aboard while the bus dwells
        const trail: LocationSample[] = [
            { lat: BASE_LAT, lon: BASE_LON, timestamp: t0 - 30000 },
            { lat: BASE_LAT + offsetLat(40), lon: BASE_LON, timestamp: t0 - 25000 },
            { lat: BASE_LAT + offsetLat(80), lon: BASE_LON, timestamp: t0 - 20000 },
            { lat: stopLat, lon: BASE_LON, timestamp: t0 - 15000 },
            { lat: stopLat, lon: BASE_LON, timestamp: t0 - 10000 },
            { lat: stopLat, lon: BASE_LON, timestamp: t0 - 5000 },
            { lat: stopLat, lon: BASE_LON, timestamp: t0 },
        ];

        const result = onBus.classifyOnBusStatus(stopLat, BASE_LON, trail);
        expect(result.status).toBe('on_bus');
        expect(result.vid).toBe('341');
    });

    it('never confirms on_bus from a trail that is too short', () => {
        const t0 = Date.now();
        seedBus('341', [
            { lat: BASE_LAT, lon: BASE_LON, timestamp: t0 - 7500 },
            { lat: BASE_LAT + offsetLat(60), lon: BASE_LON, timestamp: t0 },
        ]);

        const trail: LocationSample[] = [
            { lat: BASE_LAT + offsetLat(60), lon: BASE_LON, timestamp: t0 - 2000 },
            { lat: BASE_LAT + offsetLat(60), lon: BASE_LON, timestamp: t0 },
        ];

        const result = onBus.classifyOnBusStatus(BASE_LAT + offsetLat(60), BASE_LON, trail);
        expect(result.status).not.toBe('on_bus');
    });

    it('returns not_near_bus when the candidate vid is not nearby', () => {
        const t0 = Date.now();
        seedBus('341', [
            { lat: BASE_LAT, lon: BASE_LON, timestamp: t0 - 7500 },
            { lat: BASE_LAT, lon: BASE_LON, timestamp: t0 },
        ]);

        const trail: LocationSample[] = [0, 5000, 10000, 15000].map(dt => ({
            lat: BASE_LAT, lon: BASE_LON, timestamp: t0 - 15000 + dt,
        }));

        const result = onBus.classifyOnBusStatus(BASE_LAT, BASE_LON, trail, '999');
        expect(result.status).toBe('not_near_bus');
        expect(result.reason).toBe('candidate_bus_not_nearby');
    });
});

describe('detectAtStopContext', () => {
    beforeEach(resetState);

    it('detects the stop when the user is within the proximity threshold', () => {
        state.setCachedStopLocations({
            'C250': { name: 'Central Campus Transit Center', lat: BASE_LAT, lon: BASE_LON },
        });
        const ctx = onBus.detectAtStopContext(BASE_LAT + offsetLat(10), BASE_LON);
        expect(ctx).not.toBeNull();
        expect(ctx!.stopId).toBe('C250');
        expect(ctx!.walkTimeSeconds).toBe(0);
    });

    it('returns null when no stop is close enough', () => {
        state.setCachedStopLocations({
            'C250': { name: 'Central Campus Transit Center', lat: BASE_LAT, lon: BASE_LON },
        });
        const ctx = onBus.detectAtStopContext(BASE_LAT + offsetLat(100), BASE_LON);
        expect(ctx).toBeNull();
    });
});

describe('resolveOnBusContext', () => {
    beforeEach(resetState);

    const classification = { status: 'on_bus' as const, vid: '341', confidence: 0.8, reason: 'co_movement_matched' };

    it('builds a trimmed trip from the next predicted stop with a virtual on-bus stop', () => {
        const t0 = Date.now();
        const now = 50000; // seconds since midnight
        state.setCachedStopLocations({
            'S1': { name: 'Stop 1', lat: BASE_LAT - offsetLat(500), lon: BASE_LON },
            'S2': { name: 'Stop 2', lat: BASE_LAT, lon: BASE_LON },
            'S3': { name: 'Stop 3', lat: BASE_LAT + offsetLat(500), lon: BASE_LON },
        });
        state.setCachedGraph({
            trips: [{
                tripId: 'T1', vid: '341',
                stopTimes: [
                    { stop: 'S1', arrivalTime: now + 60, departureTime: now + 60, pickUp: true, dropOff: true, rt: 'CN' },
                    { stop: 'S2', arrivalTime: now + 120, departureTime: now + 120, pickUp: true, dropOff: true, rt: 'CN' },
                    { stop: 'S3', arrivalTime: now + 240, departureTime: now + 240, pickUp: true, dropOff: true, rt: 'CN' },
                ],
            }],
            transfers: {}, interchange: {},
        });
        state.cachedPredsByVid['341'] = [
            { rt: 'CN', vid: '341', stpid: 'S2', prdtm: t0 + 120_000, prdctdn: '2' },
        ];
        // Bus stationary right at S2
        seedBus('341', [
            { lat: BASE_LAT, lon: BASE_LON, timestamp: t0 - 7500 },
            { lat: BASE_LAT, lon: BASE_LON, timestamp: t0 },
        ], { rt: 'CN' });

        const ctx = onBus.resolveOnBusContext('341', BASE_LAT, BASE_LON, now, classification);
        expect(ctx).not.toBeNull();
        expect(ctx!.virtualStopId).toBe('ON_BUS_341');
        expect(ctx!.boardStopIndex).toBe(1);
        expect(ctx!.rt).toBe('CN');

        const stops = ctx!.trimmedTrip.stopTimes;
        expect(stops[0].stop).toBe('ON_BUS_341');
        expect(stops[0].pickUp).toBe(true);
        expect(stops[0].dropOff).toBe(false);
        expect(stops[0].departureTime).toBe(now);
        expect(stops.slice(1).map(s => s.stop)).toEqual(['S2', 'S3']);

        // Bus is stationary at S2, so the physical stop is resolved for transfers
        expect(ctx!.isStoppedAtStop).toBe(true);
        expect(ctx!.currentStopId).toBe('S2');
    });

    it('does not resolve a physical stop when the bus is moving', () => {
        const t0 = Date.now();
        const now = 50000;
        state.setCachedStopLocations({
            'S2': { name: 'Stop 2', lat: BASE_LAT, lon: BASE_LON },
        });
        state.setCachedGraph({
            trips: [{
                tripId: 'T1', vid: '341',
                stopTimes: [
                    { stop: 'S2', arrivalTime: now + 120, departureTime: now + 120, pickUp: true, dropOff: true, rt: 'CN' },
                ],
            }],
            transfers: {}, interchange: {},
        });
        // Bus moving north at 8 m/s near S2
        seedBus('341', [
            { lat: BASE_LAT - offsetLat(60), lon: BASE_LON, timestamp: t0 - 7500 },
            { lat: BASE_LAT, lon: BASE_LON, timestamp: t0 },
        ]);

        const ctx = onBus.resolveOnBusContext('341', BASE_LAT, BASE_LON, now, classification);
        expect(ctx).not.toBeNull();
        expect(ctx!.isStoppedAtStop).toBe(false);
        expect(ctx!.currentStopId).toBeUndefined();
    });

    it('returns null when the vehicle has no active trip in the graph', () => {
        const t0 = Date.now();
        seedBus('999', [
            { lat: BASE_LAT, lon: BASE_LON, timestamp: t0 },
        ]);
        const ctx = onBus.resolveOnBusContext('999', BASE_LAT, BASE_LON, 50000, classification);
        expect(ctx).toBeNull();
    });
});

describe('adjustDueTripsAtStop', () => {
    it('makes DUE departures at the stop boardable now and leaves others unchanged', () => {
        const now = 50000;
        const trips: Trip[] = [
            {
                tripId: 'T1', vid: '341',
                stopTimes: [
                    { stop: 'S1', arrivalTime: now + 60, departureTime: now + 60, pickUp: true, dropOff: true },
                    { stop: 'S2', arrivalTime: now + 120, departureTime: now + 120, pickUp: true, dropOff: true },
                ],
            },
            {
                tripId: 'T2', vid: '342',
                stopTimes: [
                    { stop: 'S1', arrivalTime: now + 300, departureTime: now + 300, pickUp: true, dropOff: true },
                ],
            },
            {
                tripId: 'VIRTUAL_ORIGIN_TRIP', vid: null,
                stopTimes: [
                    { stop: 'VIRTUAL_ORIGIN', arrivalTime: 0, departureTime: 0, pickUp: true, dropOff: true },
                ],
            },
        ];

        const adjusted = adjustDueTripsAtStop(trips, 'S1', now);

        // DUE bus (60s out) at S1 is boardable immediately
        expect(adjusted[0].stopTimes[0].arrivalTime).toBe(now);
        expect(adjusted[0].stopTimes[0].departureTime).toBe(now);
        // Later stop on the same trip is untouched
        expect(adjusted[0].stopTimes[1].arrivalTime).toBe(now + 120);
        // A bus 5 minutes out is not pulled forward
        expect(adjusted[1].stopTimes[0].arrivalTime).toBe(now + 300);
        // Virtual trips are untouched
        expect(adjusted[2].stopTimes[0].arrivalTime).toBe(0);

        // Original trips are not mutated
        expect(trips[0].stopTimes[0].arrivalTime).toBe(now + 60);
    });
});

describe('recordBusPositionHistory', () => {
    beforeEach(resetState);

    it('appends samples per vid and prunes entries older than 60 seconds', () => {
        const t0 = Date.now();
        state.recordBusPositionHistory(
            [{ vid: '7', lat: String(BASE_LAT), lon: String(BASE_LON), hdg: '90' }], t0
        );
        state.recordBusPositionHistory(
            [{ vid: '7', lat: String(BASE_LAT + offsetLat(60)), lon: String(BASE_LON), hdg: '0' }], t0 + 7500
        );

        expect(state.busPositionHistory['7']).toHaveLength(2);
        expect(state.busPositionHistory['7'][0].heading).toBe(90);

        // A poll 70s later prunes the old samples
        state.recordBusPositionHistory(
            [{ vid: '7', lat: String(BASE_LAT + offsetLat(120)), lon: String(BASE_LON) }], t0 + 70000
        );
        expect(state.busPositionHistory['7']).toHaveLength(1);
        expect(state.busPositionHistory['7'][0].timestamp).toBe(t0 + 70000);
    });

    it('drops history for vehicles that stop reporting', () => {
        const t0 = Date.now();
        state.recordBusPositionHistory(
            [{ vid: '7', lat: String(BASE_LAT), lon: String(BASE_LON) }], t0
        );
        // 70s later the vehicle is gone from the feed
        state.recordBusPositionHistory([], t0 + 70000);
        expect(state.busPositionHistory['7']).toBeUndefined();
    });
});
