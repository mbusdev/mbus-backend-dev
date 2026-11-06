/**
 * Live integration tests for on-bus detection and routing.
 *
 * These tests run against a RUNNING server (`npm start`) and use whatever
 * buses are actually in service right now. User location data is synthesized
 * from the real-time bus positions the server itself reports, so the suite
 * adapts to live conditions:
 *
 * - If no buses are running, bus-dependent tests are skipped with a warning.
 * - If no bus is currently moving / dwelling at a stop, the tests that need
 *   that condition are skipped with a warning.
 * - Transient live-data races (a bus stopping or turning mid-test) downgrade
 *   to warnings instead of failures; hard invariants (e.g. a stationary user
 *   is NEVER classified on_bus) are always asserted strictly.
 *
 * Run with: npx vitest run test/onBusLive.test.ts
 * (Optionally MBUS_TEST_PORT=#### to target a non-default port.)
 */
import axios from 'axios';
import { describe, it, expect, beforeAll } from 'vitest';

const SERVER_PORT = process.env.MBUS_TEST_PORT || 3000;
const BASE_URL = `http://localhost:${SERVER_PORT}/mbus/api/v3`;

const M_PER_DEG_LAT = 111320;
const mPerDegLon = (lat: number) => M_PER_DEG_LAT * Math.cos(lat * Math.PI / 180);

/** Number of position polls in the shared observation window. */
const OBSERVE_POLLS = 4;
/** Interval between polls (server refreshes its cache every ~7.5s). */
const OBSERVE_INTERVAL_MS = 6000;

/** Displacement over the window above which a bus counts as moving. */
const MOVING_DISPLACEMENT_M = 50;
/** Displacement below which a bus counts as stationary. */
const STATIONARY_DISPLACEMENT_M = 10;

type UserSample = { lat: number, lon: number, timestamp: number };
type BusTrack = {
    vid: string,
    rt?: string,
    samples: { lat: number, lon: number, timestamp: number }[],
};
type Stop = { stpid: string, name: string, lat: number, lon: number };

function haversineM(aLat: number, aLon: number, bLat: number, bLon: number): number {
    const R = 6371000;
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLon - aLon);
    const sinDlat = Math.sin(dLat / 2);
    const sinDlon = Math.sin(dLon / 2);
    const a = sinDlat * sinDlat + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * sinDlon * sinDlon;
    return 2 * R * Math.asin(Math.sqrt(a));
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function warnSkip(test: string, why: string) {
    console.warn(`\n⚠️  SKIPPED [${test}]: ${why}\n`);
}

function warnLive(test: string, why: string) {
    console.warn(`\n⚠️  LIVE-CONDITION [${test}]: ${why}\n`);
}

async function fetchBuses(): Promise<any[]> {
    const res = await axios.get(`${BASE_URL}/getBusPositions`);
    return res.data.buses || [];
}

/** Total displacement of a track from first to last sample, in meters. */
function displacement(track: BusTrack): number {
    const s = track.samples;
    if (s.length < 2) return 0;
    return haversineM(s[0].lat, s[0].lon, s[s.length - 1].lat, s[s.length - 1].lon);
}

/** Displacement between the last two samples of a track, in meters. */
function recentMovement(track: BusTrack): number {
    const s = track.samples;
    if (s.length < 2) return 0;
    return haversineM(s[s.length - 2].lat, s[s.length - 2].lon, s[s.length - 1].lat, s[s.length - 1].lon);
}

/** Fakes a rider's GPS sample a few meters off the bus's GPS center. */
function toUserSample(lat: number, lon: number, timestamp: number, offsetM = 3): UserSample {
    return { lat, lon: lon + offsetM / mPerDegLon(lat), timestamp };
}

/**
 * Builds a fake user trail that rides along an observed bus track,
 * densified with midpoints to resemble a phone's 2-5s GPS cadence.
 */
function buildRidingTrail(track: BusTrack): UserSample[] {
    const trail: UserSample[] = [];
    const s = track.samples;
    for (let i = 0; i < s.length; i++) {
        if (i > 0) {
            const a = s[i - 1];
            const b = s[i];
            trail.push(toUserSample((a.lat + b.lat) / 2, (a.lon + b.lon) / 2, Math.round((a.timestamp + b.timestamp) / 2)));
        }
        trail.push(toUserSample(s[i].lat, s[i].lon, s[i].timestamp));
    }
    return trail;
}

/** Builds a fake stationary user trail at a fixed point, ending now. */
function buildStationaryTrail(lat: number, lon: number, spanMs = 24000, samples = 5): UserSample[] {
    const now = Date.now();
    const trail: UserSample[] = [];
    for (let i = 0; i < samples; i++) {
        trail.push({ lat, lon, timestamp: now - spanMs + (spanMs / (samples - 1)) * i });
    }
    return trail;
}

async function detect(lat: number, lon: number, locationTrail: UserSample[], candidateVid?: string) {
    const res = await axios.post(`${BASE_URL}/detect-on-bus`, { lat, lon, locationTrail, candidateVid });
    return res.data;
}

async function planJourney(params: Record<string, string>) {
    const qs = new URLSearchParams(params).toString();
    const res = await axios.get(`${BASE_URL}/plan-journey?${qs}`);
    return res.data;
}

/** Appends the bus's current cached position to its track. Null if it vanished. */
async function refreshTrack(track: BusTrack): Promise<{ lat: number, lon: number, timestamp: number } | null> {
    const buses = await fetchBuses();
    const bus = buses.find(b => (b.vid || b.id) === track.vid);
    if (!bus) return null;
    const sample = { lat: parseFloat(bus.lat), lon: parseFloat(bus.lon), timestamp: Date.now() };
    if (isNaN(sample.lat) || isNaN(sample.lon)) return null;
    track.samples.push(sample);
    return sample;
}

/** Extends a track with additional live polls. */
async function observeMore(track: BusTrack, polls: number, intervalMs = OBSERVE_INTERVAL_MS) {
    for (let i = 0; i < polls; i++) {
        await sleep(intervalMs);
        await refreshTrack(track);
    }
}

/** Polls bus positions and accumulates per-vehicle tracks. */
async function observeAllBuses(polls: number, intervalMs: number): Promise<Map<string, BusTrack>> {
    const result = new Map<string, BusTrack>();
    for (let i = 0; i < polls; i++) {
        const buses = await fetchBuses();
        const now = Date.now();
        for (const bus of buses) {
            const vid = bus.vid || bus.id;
            const lat = parseFloat(bus.lat);
            const lon = parseFloat(bus.lon);
            if (!vid || isNaN(lat) || isNaN(lon)) continue;
            if (!result.has(vid)) result.set(vid, { vid, rt: bus.rt, samples: [] });
            result.get(vid)!.samples.push({ lat, lon, timestamp: now });
        }
        if (i < polls - 1) await sleep(intervalMs);
    }
    return result;
}

/** Whether the vehicle has predictions (i.e. an active trip in the routing graph). */
async function hasActiveTrip(vid: string): Promise<boolean> {
    const res = await axios.get(`${BASE_URL}/getBusPredictions/${vid}`);
    return (res.data['bustime-response']?.prd || []).length > 0;
}

/** Picks the fastest-moving bus that has an active trip; falls back to fastest overall. */
async function pickMovingBusWithTrip(): Promise<{ track: BusTrack, inGraph: boolean } | null> {
    for (const track of movingBuses) {
        if (await hasActiveTrip(track.vid)) return { track, inGraph: true };
    }
    return movingBuses.length ? { track: movingBuses[0], inGraph: false } : null;
}

function nearestStop(stops: Stop[], lat: number, lon: number): { stop: Stop, distance: number } | null {
    let best: Stop | null = null;
    let bestDist = Infinity;
    for (const stop of stops) {
        const d = haversineM(lat, lon, stop.lat, stop.lon);
        if (d < bestDist) { bestDist = d; best = stop; }
    }
    return best ? { stop: best, distance: bestDist } : null;
}

/**
 * Runs riding detection against a moving bus with one retry, and decides
 * whether a non-on_bus result is a genuine failure or explainable by live
 * conditions (bus stopped/slowed mid-test).
 */
async function attemptRidingDetection(testName: string, track: BusTrack, useCandidate: boolean) {
    let result: any = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        const current = await refreshTrack(track);
        if (!current) {
            warnLive(testName, `bus ${track.vid} disappeared from the live feed mid-test`);
            return null;
        }
        const trail = buildRidingTrail(track);
        const userPos = toUserSample(current.lat, current.lon, current.timestamp);
        result = await detect(userPos.lat, userPos.lon, trail, useCandidate ? track.vid : undefined);
        if (result.status === 'on_bus') return result;
        // Give the bus another chance to show clean motion, then retry once
        if (attempt === 0) await observeMore(track, 2);
    }
    return result;
}

// Shared live state collected in beforeAll
let stops: Stop[] = [];
let tracks: Map<string, BusTrack> = new Map();
let movingBuses: BusTrack[] = [];
let stationaryBuses: BusTrack[] = [];
let stationaryBusesAtStops: { track: BusTrack, stop: Stop, stopDistance: number }[] = [];
let busesRunning = false;

describe('On-Bus Detection & Routing (live data)', () => {
    beforeAll(async () => {
        try {
            await axios.get(`${BASE_URL}/getBusPositions`);
        } catch {
            throw new Error(
                `Server is not running at ${BASE_URL}. Start it with \`npm start\` before running the live on-bus tests.`
            );
        }

        const stopsRes = await axios.get(`${BASE_URL}/getAllStops`);
        stops = (Array.isArray(stopsRes.data) ? stopsRes.data : [])
            .filter((s: any) => typeof s.lat === 'number' && typeof s.lon === 'number');

        // Skip the long observation window entirely when nothing is reporting
        let shouldObserve = (await fetchBuses()).length > 0;
        if (!shouldObserve) {
            await sleep(OBSERVE_INTERVAL_MS);
            shouldObserve = (await fetchBuses()).length > 0;
        }
        if (shouldObserve) {
            console.log(`Observing live bus positions (${OBSERVE_POLLS} polls over ~${(OBSERVE_POLLS - 1) * OBSERVE_INTERVAL_MS / 1000}s)...`);
            tracks = await observeAllBuses(OBSERVE_POLLS, OBSERVE_INTERVAL_MS);
        }
        busesRunning = tracks.size > 0;

        for (const track of tracks.values()) {
            const moved = displacement(track);
            if (moved >= MOVING_DISPLACEMENT_M && recentMovement(track) >= 15) {
                movingBuses.push(track);
            } else if (moved <= STATIONARY_DISPLACEMENT_M) {
                stationaryBuses.push(track);
                const last = track.samples[track.samples.length - 1];
                const near = nearestStop(stops, last.lat, last.lon);
                if (near && near.distance <= 40) {
                    stationaryBusesAtStops.push({ track, stop: near.stop, stopDistance: near.distance });
                }
            }
        }
        // Prefer the fastest-moving bus for co-movement tests
        movingBuses.sort((a, b) => displacement(b) - displacement(a));

        if (!busesRunning) {
            console.warn(
                '\n' +
                '⚠️ ============================================================\n' +
                '⚠️  NO BUSES ARE CURRENTLY RUNNING.\n' +
                '⚠️  All bus-dependent live tests will be skipped with warnings.\n' +
                '⚠️  Re-run this suite while MBus vehicles are in service to get\n' +
                '⚠️  full live coverage of on-bus detection.\n' +
                '⚠️ ============================================================\n'
            );
        } else {
            console.log(
                `Live snapshot: ${tracks.size} buses total — ` +
                `${movingBuses.length} moving, ${stationaryBuses.length} stationary ` +
                `(${stationaryBusesAtStops.length} dwelling at a stop), ${stops.length} stops cached.`
            );
        }
    }, 90_000);

    it('reports current live bus availability', () => {
        if (!busesRunning) {
            console.warn('⚠️  No MBus vehicles reporting positions right now — bus-dependent tests below are skipped.');
        }
        // Always passes; exists to surface the availability summary in test output.
        expect(tracks).toBeDefined();
    });

    // ------------------------------------------------------------------
    // Hard invariants — these hold no matter what buses are running
    // ------------------------------------------------------------------

    it('classifies not_near_bus when the user is far from every bus', async () => {
        // Middle of Lake Erie — guaranteed far from any MBus vehicle
        const trail = buildStationaryTrail(41.7, -82.5);
        const result = await detect(41.7, -82.5, trail);
        expect(result.status).toBe('not_near_bus');
        expect(result.onBus).toBe(false);
    });

    it('returns candidate_bus_not_nearby for an unknown candidateVid', async () => {
        const trail = buildStationaryTrail(42.278, -83.738);
        const result = await detect(42.278, -83.738, trail, 'TEST_NO_SUCH_VID');
        expect(result.status).toBe('not_near_bus');
        expect(result.reason).toBe('candidate_bus_not_nearby');
    });

    it('rejects a malformed detect-on-bus body with 400', async () => {
        try {
            await axios.post(`${BASE_URL}/detect-on-bus`, { lat: 'not-a-number' });
            expect.fail('Expected 400 for malformed body');
        } catch (error) {
            if (axios.isAxiosError(error) && error.response) {
                expect(error.response.status).toBe(400);
            } else {
                throw error;
            }
        }
    });

    it('falls back with trail_required when onBus=true has no locationTrail', async () => {
        const data = await planJourney({
            originLat: '42.278', originLon: '-83.738',
            destLat: '42.2912', destLon: '-83.7175',
            onBus: 'true',
        });
        expect(Array.isArray(data.journeys)).toBe(true);
        expect(data.originContext).toBeDefined();
        expect(data.originContext.fallbackReason).toBe('trail_required');
        expect(data.originContext.validated).toBe(false);
    });

    it('keeps the legacy plan-journey response shape when no on-bus params are sent', async () => {
        const data = await planJourney({
            originLat: '42.278', originLon: '-83.738',
            destLat: '42.2912', destLon: '-83.7175',
        });
        expect(Array.isArray(data.journeys)).toBe(true);
        expect(data).not.toHaveProperty('originContext');
    });

    // ------------------------------------------------------------------
    // Riding detection with real moving buses
    // ------------------------------------------------------------------

    it('confirms on_bus for a fake user riding along a real moving bus', async () => {
        const name = 'riding → on_bus';
        if (!busesRunning) return warnSkip(name, 'no buses running');
        if (!movingBuses.length) return warnSkip(name, 'no bus is currently moving — re-run while buses are driving');

        const track = movingBuses[0];
        const result = await attemptRidingDetection(name, track, true);
        if (!result) return; // vehicle disappeared mid-test (already warned)

        if (result.status !== 'on_bus' && recentMovement(track) < 15) {
            warnLive(name, `bus ${track.vid} stopped/slowed mid-test; got '${result.status}' (${result.reason}) — acceptable under live conditions`);
            expect(['on_bus', 'near_bus', 'waiting_at_stop']).toContain(result.status);
            return;
        }

        expect(result.status, `bus ${track.vid} (rt ${track.rt}) still moving but not detected: ${result.reason}`).toBe('on_bus');
        expect(result.onBus).toBe(true);
        expect(result.vid).toBe(track.vid);
        expect(result.confidence).toBeGreaterThan(0.5);
        expect(typeof result.busLat).toBe('number');
        expect(typeof result.busLon).toBe('number');
        console.log(`✓ on_bus confirmed riding bus ${track.vid} (rt ${track.rt}), confidence ${result.confidence.toFixed(2)}, reason ${result.reason}`);
    }, 60_000);

    it('auto-picks the co-moving bus when no candidateVid is given', async () => {
        const name = 'auto-pick vid';
        if (!busesRunning) return warnSkip(name, 'no buses running');
        if (!movingBuses.length) return warnSkip(name, 'no bus is currently moving');

        const track = movingBuses[0];
        const result = await attemptRidingDetection(name, track, false);
        if (!result) return;

        if (result.status !== 'on_bus' && recentMovement(track) < 15) {
            warnLive(name, `bus ${track.vid} stopped/slowed mid-test; got '${result.status}' (${result.reason})`);
            expect(result.status).not.toBe('not_near_bus');
            return;
        }

        expect(result.status).toBe('on_bus');
        expect(result.vid).toBeDefined();
        if (result.vid !== track.vid) {
            warnLive(name, `auto-pick matched co-located bus ${result.vid} instead of ${track.vid} (both plausible)`);
        }
    }, 60_000);

    it('plans a journey starting from the bus when riding (continue/alight tagging)', async () => {
        const name = 'plan-journey on-bus';
        if (!busesRunning) return warnSkip(name, 'no buses running');
        if (!movingBuses.length) return warnSkip(name, 'no bus is currently moving');

        // Prefer a moving bus that actually has an active trip in the graph,
        // so the primary on-bus path is exercised (not just the fallback).
        const picked = await pickMovingBusWithTrip();
        if (!picked) return warnSkip(name, 'no bus is currently moving');
        if (!picked.inGraph) {
            warnLive(name, `no moving bus has an active trip right now — bus ${picked.track.vid} will exercise the bus_not_found fallback`);
        }
        const track = picked.track;
        const current = await refreshTrack(track);
        if (!current) return warnSkip(name, `bus ${track.vid} disappeared from the live feed`);
        const trail = buildRidingTrail(track);
        const userPos = toUserSample(current.lat, current.lon, current.timestamp);

        // Destination: the cached stop farthest from the bus, to maximize transit options
        let dest = { lat: 42.2912, lon: -83.7175 }; // CCTC fallback
        if (stops.length) {
            const farthest = stops.reduce((a, b) =>
                haversineM(userPos.lat, userPos.lon, a.lat, a.lon) >= haversineM(userPos.lat, userPos.lon, b.lat, b.lon) ? a : b);
            dest = { lat: farthest.lat, lon: farthest.lon };
        }

        const data = await planJourney({
            originLat: String(userPos.lat), originLon: String(userPos.lon),
            destLat: String(dest.lat), destLon: String(dest.lon),
            onBus: 'true', originVid: track.vid,
            locationTrail: JSON.stringify(trail),
        });

        expect(Array.isArray(data.journeys)).toBe(true);
        expect(data.originContext).toBeDefined();
        const ctx = data.originContext;

        if (ctx.mode !== 'on_bus') {
            if (ctx.fallbackReason === 'bus_not_found') {
                warnLive(name, `bus ${track.vid} has no active trip in the routing graph — fell back to '${ctx.mode}'`);
                return;
            }
            warnLive(name, `live classification raced to '${ctx.status}' (${ctx.fallbackReason}); mode '${ctx.mode}'`);
            expect(['walking', 'at_stop']).toContain(ctx.mode);
            return;
        }

        expect(ctx.status).toBe('on_bus');
        expect(ctx.vid).toBe(track.vid);
        expect(ctx.validated).toBe(true);

        const choices = data.journeys
            .map((j: any) => j.legs?.[0]?.originChoice)
            .filter(Boolean);
        for (const choice of choices) {
            expect(['continue_on_bus', 'alight_and_transfer']).toContain(choice);
        }
        if (ctx.isStoppedAtStop) {
            expect(ctx.showsTransferOptions).toBe(true);
            expect(ctx.currentStopId).toBeDefined();
        } else {
            // Moving bus: every journey must start by continuing on this bus
            for (const journey of data.journeys) {
                const firstBusLeg = journey.legs.find((l: any) => l.mode === 'bus');
                if (firstBusLeg) expect(firstBusLeg.vid).toBe(track.vid);
            }
        }
        const continueLegs = data.journeys.filter((j: any) => j.legs?.[0]?.originChoice === 'continue_on_bus');
        for (const journey of continueLegs) {
            const firstBusLeg = journey.legs.find((l: any) => l.mode === 'bus');
            expect(firstBusLeg.busPosition).toBeDefined();
        }
        console.log(
            `✓ on-bus journey plan for bus ${track.vid}: ${data.journeys.length} journeys ` +
            `(${choices.filter((c: string) => c === 'continue_on_bus').length} continue, ` +
            `${choices.filter((c: string) => c === 'alight_and_transfer').length} alight-and-transfer), ` +
            `stoppedAtStop=${ctx.isStoppedAtStop}`
        );
    }, 60_000);

    // ------------------------------------------------------------------
    // Negative cases with real buses: proximity alone must never be enough
    // ------------------------------------------------------------------

    it('never classifies a stationary user next to a real bus as on_bus', async () => {
        const name = 'stationary user near bus';
        if (!busesRunning) return warnSkip(name, 'no buses running');

        // Test against every bus currently reporting — none may produce on_bus
        const buses = await fetchBuses();
        expect(buses.length).toBeGreaterThan(0);
        for (const bus of buses.slice(0, 5)) {
            const vid = bus.vid || bus.id;
            const lat = parseFloat(bus.lat);
            const lon = parseFloat(bus.lon);
            if (!vid || isNaN(lat) || isNaN(lon)) continue;
            const trail = buildStationaryTrail(lat, lon);
            const result = await detect(lat, lon, trail, vid);
            expect(result.status, `stationary user misclassified as riding bus ${vid}`).not.toBe('on_bus');
        }
    }, 30_000);

    it('never classifies a too-short trail as on_bus, even right on a real bus', async () => {
        const name = 'short trail near bus';
        if (!busesRunning) return warnSkip(name, 'no buses running');

        const track = (movingBuses[0] || [...tracks.values()][0]);
        const current = await refreshTrack(track);
        if (!current) return warnSkip(name, `bus ${track.vid} disappeared from the live feed`);

        const now = Date.now();
        const shortTrail: UserSample[] = [
            toUserSample(current.lat, current.lon, now - 2000),
            toUserSample(current.lat, current.lon, now),
        ];
        const result = await detect(current.lat, current.lon, shortTrail, track.vid);
        expect(result.status).not.toBe('on_bus');
    }, 30_000);

    // ------------------------------------------------------------------
    // Waiting at a stop vs riding
    // ------------------------------------------------------------------

    it('classifies a stationary user at a stop with a dwelling bus as waiting_at_stop', async () => {
        const name = 'waiting_at_stop';
        if (!busesRunning) return warnSkip(name, 'no buses running');
        if (!stops.length) return warnSkip(name, 'no stops cached on the server yet');
        if (!stationaryBusesAtStops.length) {
            return warnSkip(name, 'no bus is currently dwelling at a stop — re-run when buses are stopped at stops');
        }

        const { track, stop } = stationaryBusesAtStops[0];
        // Confirm the bus is still there before asserting
        const current = await refreshTrack(track);
        if (!current) return warnSkip(name, `bus ${track.vid} disappeared from the live feed`);
        const stillThere = haversineM(current.lat, current.lon, stop.lat, stop.lon) <= 50
            && recentMovement(track) <= 10;
        if (!stillThere) return warnSkip(name, `bus ${track.vid} departed stop ${stop.stpid} mid-test`);

        const trail = buildStationaryTrail(stop.lat, stop.lon);
        const result = await detect(stop.lat, stop.lon, trail, track.vid);

        expect(result.status, 'a waiting user must never be classified as riding').not.toBe('on_bus');
        if (result.status !== 'waiting_at_stop') {
            const after = await refreshTrack(track);
            if (!after || recentMovement(track) > 10) {
                warnLive(name, `bus ${track.vid} departed during detection; got '${result.status}' (${result.reason})`);
                return;
            }
        }
        expect(result.status).toBe('waiting_at_stop');
        console.log(`✓ waiting_at_stop at ${stop.stpid} (${stop.name}) next to dwelling bus ${track.vid}`);
    }, 30_000);

    it('plans from the stop itself (at_stop origin) for a user standing at a real stop', async () => {
        const name = 'plan-journey at-stop';
        if (!stops.length) return warnSkip(name, 'no stops cached on the server yet (graph may still be building)');

        const stop = stops[0];
        let dest = stops.reduce((a, b) =>
            haversineM(stop.lat, stop.lon, a.lat, a.lon) >= haversineM(stop.lat, stop.lon, b.lat, b.lon) ? a : b);

        const trail = buildStationaryTrail(stop.lat, stop.lon);
        const data = await planJourney({
            originLat: String(stop.lat), originLon: String(stop.lon),
            destLat: String(dest.lat), destLon: String(dest.lon),
            onBus: 'true',
            locationTrail: JSON.stringify(trail),
        });

        expect(Array.isArray(data.journeys)).toBe(true);
        expect(data.originContext).toBeDefined();
        expect(data.originContext.mode).toBe('at_stop');
        expect(data.originContext.stopId).toBe(stop.stpid);

        // DUE-boarding check: if a bus is DUE at this stop, an immediate boarding should exist
        const predsRes = await axios.get(`${BASE_URL}/getStopPredictions/${stop.stpid}`);
        const preds = predsRes.data['bustime-response']?.prd || [];
        const dueHere = preds.filter((p: any) => p.prdctdn === 'DUE' || parseInt(p.prdctdn) <= 1);
        if (dueHere.length) {
            const now = new Date();
            const nowSec = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
            const immediate = data.journeys.some((j: any) => {
                const firstBus = j.legs.find((l: any) => l.mode === 'bus');
                return firstBus && firstBus.origin_id === stop.stpid && firstBus.startTime <= nowSec + 90;
            });
            if (immediate) {
                console.log(`✓ DUE bus at ${stop.stpid} is boardable immediately in the journey plan`);
            } else {
                warnLive(name, `bus DUE at ${stop.stpid} but no immediate boarding in plan (may serve the wrong direction for this destination)`);
            }
        }
        console.log(`✓ at_stop origin from ${stop.stpid} (${stop.name}): ${data.journeys.length} journeys`);
    }, 30_000);

    it('keeps on_bus (with transfer options) for a rider whose bus dwells at a stop after moving', async () => {
        const name = 'on-bus-at-stop';
        if (!busesRunning) return warnSkip(name, 'no buses running');
        if (!stops.length) return warnSkip(name, 'no stops cached on the server yet');

        // Fresh observation so the movement is inside the server's 60s history
        const fresh = await observeAllBuses(3, OBSERVE_INTERVAL_MS);
        const candidates = [...fresh.values()].filter(t => {
            if (displacement(t) < 40 || recentMovement(t) > 5) return false;
            const last = t.samples[t.samples.length - 1];
            const near = nearestStop(stops, last.lat, last.lon);
            return near !== null && near.distance <= 40;
        });
        if (!candidates.length) {
            return warnSkip(name, 'no bus moved and then dwelled at a stop during the observation window — re-run when buses are servicing stops');
        }

        const track = candidates[0];
        const trail = buildRidingTrail(track);
        const last = track.samples[track.samples.length - 1];
        const userPos = toUserSample(last.lat, last.lon, last.timestamp);

        const result = await detect(userPos.lat, userPos.lon, trail, track.vid);
        expect(['on_bus', 'waiting_at_stop']).toContain(result.status);
        if (result.status !== 'on_bus') {
            warnLive(name, `prior co-movement aged out of server history for bus ${track.vid}; got '${result.status}' (${result.reason})`);
            return;
        }
        console.log(`✓ rider kept on_bus while bus ${track.vid} dwells at a stop (${result.reason})`);

        // The journey plan should expose both continue and alight-and-transfer paths
        const dest = stops.reduce((a, b) =>
            haversineM(userPos.lat, userPos.lon, a.lat, a.lon) >= haversineM(userPos.lat, userPos.lon, b.lat, b.lon) ? a : b);
        const data = await planJourney({
            originLat: String(userPos.lat), originLon: String(userPos.lon),
            destLat: String(dest.lat), destLon: String(dest.lon),
            onBus: 'true', originVid: track.vid,
            locationTrail: JSON.stringify(trail),
        });

        expect(data.originContext).toBeDefined();
        if (data.originContext.mode !== 'on_bus') {
            warnLive(name, `plan fell back to '${data.originContext.mode}' (${data.originContext.fallbackReason ?? data.originContext.status})`);
            return;
        }
        if (data.originContext.isStoppedAtStop) {
            expect(data.originContext.showsTransferOptions).toBe(true);
            expect(data.originContext.currentStopId).toBeDefined();
            const choices = data.journeys.map((j: any) => j.legs?.[0]?.originChoice).filter(Boolean);
            console.log(
                `✓ dual-origin plan at ${data.originContext.currentStopId}: ` +
                `${choices.filter((c: string) => c === 'continue_on_bus').length} continue, ` +
                `${choices.filter((c: string) => c === 'alight_and_transfer').length} alight-and-transfer`
            );
        } else {
            warnLive(name, `bus ${track.vid} no longer registered as stopped at a stop when planning`);
        }
    }, 90_000);
});
