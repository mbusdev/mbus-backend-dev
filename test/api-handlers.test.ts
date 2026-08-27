import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type express from 'express';

// Heavy modules replaced before the router module loads. startBackgroundJobs
// itself is skipped by api.ts under vitest (process.env.VITEST === 'true').
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

import * as api from '../src/routes/api';
import * as state from '../src/state/transitState';
import * as reminderService from '../src/services/reminder';
import { makeTrip } from './helpers/network';

function mockRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status(code: number) { this.statusCode = code; return this; },
        sendStatus(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
        send(payload: unknown) { this.body = payload; return this; },
    };
    return res as express.Response & { statusCode: number, body: any };
}

const req = (query: Record<string, string> = {}, body: unknown = {}) =>
    ({ query, body, params: {} }) as unknown as express.Request;

beforeEach(() => {
    state.setCachedGraph({ trips: [], transfers: {}, interchange: {} });
    state.setCachedGraphTimeBase(0);
    state.setCachedStopLocations({});
    state.validRoutes.clear();
    state.validRideRoutes.clear();
    reminderService.universityReminderSubscriptions.subscriptions = [];
    reminderService.rideReminderSubscriptions.subscriptions = [];
});

afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
});

describe('/plan-journey parameter validation', () => {
    const goodCoords = { originLat: '42.27', originLon: '-83.74', destLat: '42.29', destLon: '-83.71' };

    it('rejects missing coordinates with 400', async () => {
        const res = mockRes();
        await api.planJourney(req({ originLat: '42.27' }), res);
        expect(res.statusCode).toBe(400);
    });

    it('rejects non-numeric coordinates with 400 instead of a 500', async () => {
        const res = mockRes();
        await api.planJourney(req({ ...goodCoords, originLat: 'abc' }), res);
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/numeric/);
    });

    it('rejects a negative or non-numeric walkingPenalty with 400', async () => {
        const negative = mockRes();
        await api.planJourney(req({ ...goodCoords, walkingPenalty: '-1' }), negative);
        expect(negative.statusCode).toBe(400);

        const garbage = mockRes();
        await api.planJourney(req({ ...goodCoords, walkingPenalty: 'fast' }), garbage);
        expect(garbage.statusCode).toBe(400);
    });

    it('rejects a non-numeric range with 400', async () => {
        const res = mockRes();
        await api.planJourney(req({ ...goodCoords, range: 'soon' }), res);
        expect(res.statusCode).toBe(400);
    });

    it('accepts walkingPenalty=0 (free walking) and returns 200', async () => {
        const res = mockRes();
        await api.planJourney(req({ ...goodCoords, walkingPenalty: '0' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ journeys: [] });
    });
});

describe('/getAllPredictions time frame', () => {
    it('computes countdowns in the graph frame after the clock crosses UTC midnight', () => {
        vi.useFakeTimers();
        // Graph built just before midnight: bus due at 86670s in that frame.
        state.setCachedGraphTimeBase(Date.UTC(2026, 7, 26));
        state.setCachedGraph({
            trips: [makeTrip('888001', '4001', [{ stop: 'T1', arr: 86670, rt: 'TT' }])],
            transfers: {}, interchange: {},
        });
        state.stopIdToName['T1'] = 'Central Campus Transit Center';

        // Request 30s after midnight: (86670 - 86430) / 60 = 4 minutes, not ~1444.
        vi.setSystemTime(new Date('2026-08-27T00:00:30Z'));
        const res = mockRes();
        api.getAllPredictions(req(), res);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].stops[0].prdctdn).toBe('4');
    });
});

describe('/modifyReminders atomicity', () => {
    it('applies nothing when any modification names an invalid route', () => {
        state.validRoutes.add('BB');
        state.validRideRoutes.add('4'); // both feeds loaded -> a miss is a real 400
        const res = mockRes();
        api.modifyReminders(req({}, {
            token: 'tok1',
            modifications: [
                { action: 'set', stpid: 'C250', rtid: 'BB', thresh: 3 },
                { action: 'set', stpid: 'C250', rtid: 'NOPE', thresh: 3 },
            ],
        }), res);

        expect(res.statusCode).toBe(400);
        // The valid first entry must NOT have been applied before the abort.
        const active = reminderService.universityReminderSubscriptions
            .activeRemindersFor(reminderService.registrationToken('tok1'));
        expect(active).toHaveLength(0);
    });
});

describe('reminder endpoint validation', () => {
    it('rejects out-of-range thresh values with 400', () => {
        state.validRoutes.add('BB');
        for (const thresh of [-1, 0, 1e12]) {
            const res = mockRes();
            api.setReminder(req({}, { token: 'tok1', stpid: 'C250', rtid: 'BB', thresh }), res);
            expect(res.statusCode).toBe(400);
        }
        expect(reminderService.universityReminderSubscriptions.subscriptions).toHaveLength(0);
    });

    it('answers 503 (retryable) instead of 400 while route data is still loading', () => {
        // validRoutes/validRideRoutes are empty until the first getroutes
        // fetch completes; a 400 would make clients discard valid reminders.
        const res = mockRes();
        api.setReminder(req({}, { token: 'tok1', stpid: 'C250', rtid: 'BB', thresh: 5 }), res);
        expect(res.statusCode).toBe(503);

        // Same when only ONE feed is down: an unknown rtid could belong to it.
        state.validRoutes.add('BB');
        const oneFeedDown = mockRes();
        api.setReminder(req({}, { token: 'tok1', stpid: 'X', rtid: '4', thresh: 5 }), oneFeedDown);
        expect(oneFeedDown.statusCode).toBe(503);
    });

    it('startup info restores the 2.0.2 minimum supported version gate', () => {
        const res = mockRes();
        api.getStartupInfo(req(), res);
        expect(res.body.min_supported_version).toBe('2.0.2');
    });
});

describe('prototype-key robustness', () => {
    it('returns an empty prediction list for prototype-named IDs', () => {
        for (const key of ['constructor', '__proto__', 'hasOwnProperty']) {
            const res = mockRes();
            api.getBusPredictions({ params: { busId: key }, query: {}, body: {} } as any, res);
            expect(res.body).toEqual({ 'bustime-response': { prd: [] } });

            const res2 = mockRes();
            api.getStopPredictions({ params: { stopId: key }, query: {}, body: {} } as any, res2);
            expect(res2.body).toEqual({ 'bustime-response': { prd: [] } });
        }
    });
});

describe('misc endpoint fixes', () => {
    it('notifyMeLater returns HTTP 400 (not 200) when the token is missing', () => {
        const res = mockRes();
        api.notifyMeLater(req({}, {}), res);
        expect(res.statusCode).toBe(400);
    });

    it('nearest-stops falls back to k=2 for garbage k instead of returning nothing', () => {
        state.setCachedStopLocations({
            A: { name: 'A', lat: 42.28, lon: -83.73 },
            B: { name: 'B', lat: 42.28, lon: -83.72 },
            C: { name: 'C', lat: 42.28, lon: -83.70 },
        });
        const res = mockRes();
        api.getNearestStops(req({ lat: '42.28', lon: '-83.735', k: 'abc' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.nearestStops.map((s: any) => s.stpid)).toEqual(['A', 'B']);
    });
});
