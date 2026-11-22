import * as state from '../state/transitState';
import * as graphBuilder from './graphBuilder';
import { haversine } from '../walking/loadMap';
import {
    AtStopContext,
    LocationSample,
    OnBusClassification,
    OnBusContext,
    OnBusStatus,
    Trip,
} from '../raptor/types';

/** Max user-to-bus distance to consider the bus a candidate. */
export const PROXIMITY_THRESHOLD_M = 50;
/** Distance to a known stop for the user/bus to count as "at" that stop. */
export const STOP_PROXIMITY_M = 40;
/** Distance to the bus center to count as aboard while both are stationary. */
export const TIGHT_BUS_PROXIMITY_M = 15;
/** Speeds below this are treated as stationary. */
export const STOPPED_SPEED_MS = 0.8;
/** A bus is considered moving above this speed. */
export const MOVING_BUS_SPEED_MS = 1.5;
/** Max heading difference for co-movement. */
export const HEADING_TOLERANCE_DEG = 50;
/** User speed vs bus speed ratio bounds for co-movement. */
export const SPEED_RATIO_MIN = 0.4;
export const SPEED_RATIO_MAX = 1.6;
/** Minimum location samples for a usable trail. */
export const MIN_TRAIL_SAMPLES = 3;
/** Minimum time span (ms) for a usable trail. */
export const MIN_TRAIL_DURATION_MS = 10_000;

type Velocity = { speed: number, heading: number | null };

/** Initial bearing in degrees (0-360) from point A to point B. */
function bearing(aLat: number, aLon: number, bLat: number, bLon: number): number {
    const toRad = (d: number) => d * Math.PI / 180;
    const dLon = toRad(bLon - aLon);
    const y = Math.sin(dLon) * Math.cos(toRad(bLat));
    const x = Math.cos(toRad(aLat)) * Math.sin(toRad(bLat))
        - Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Absolute angular difference between two headings, in [0, 180]. */
function headingDiff(a: number, b: number): number {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}

/**
 * Derives speed (m/s) and heading from a series of timestamped positions.
 * Uses the most recent window of samples to reflect current motion.
 */
export function velocityFromSamples(
    samples: { lat: number, lon: number, timestamp: number }[],
    windowMs: number = 15_000
): Velocity | null {
    if (samples.length < 2) return null;
    const sorted = [...samples].sort((a, b) => a.timestamp - b.timestamp);
    const last = sorted[sorted.length - 1];
    let first = sorted[0];
    for (const s of sorted) {
        if (last.timestamp - s.timestamp <= windowMs) { first = s; break; }
    }
    if (first === last) first = sorted[sorted.length - 2];
    const dt = (last.timestamp - first.timestamp) / 1000;
    if (dt <= 0) return null;
    const dist = haversine(first.lat, first.lon, last.lat, last.lon);
    const speed = dist / dt;
    // Heading is unreliable for tiny displacements
    const heading = dist > 5 ? bearing(first.lat, first.lon, last.lat, last.lon) : null;
    return { speed, heading };
}

/** User velocity, preferring device-reported speed/heading over GPS-derived values. */
function userVelocity(trail: LocationSample[]): Velocity | null {
    const last = trail[trail.length - 1];
    const derived = velocityFromSamples(trail);
    const speed = last?.speed !== undefined ? last.speed : derived?.speed;
    if (speed === undefined) return null;
    const heading = last?.heading !== undefined ? last.heading : (derived?.heading ?? null);
    return { speed, heading };
}

/** Current bus velocity from its most recent pair of history samples. */
function busVelocity(vid: string, bus?: any): Velocity {
    const history = state.busPositionHistory[vid] || [];
    if (history.length >= 2) {
        const a = history[history.length - 2];
        const b = history[history.length - 1];
        const dt = (b.timestamp - a.timestamp) / 1000;
        if (dt > 0) {
            const dist = haversine(a.lat, a.lon, b.lat, b.lon);
            const speed = dist / dt;
            const heading = dist > 5
                ? bearing(a.lat, a.lon, b.lat, b.lon)
                : (b.heading ?? null);
            return { speed, heading };
        }
    }
    // No usable history yet: conservatively treat as stationary
    const hdg = bus ? parseFloat(bus.hdg) : NaN;
    return { speed: 0, heading: isNaN(hdg) ? null : hdg };
}

function isTrailValid(trail: LocationSample[]): boolean {
    if (trail.length < MIN_TRAIL_SAMPLES) return false;
    return trail[trail.length - 1].timestamp - trail[0].timestamp >= MIN_TRAIL_DURATION_MS;
}

/** Finds the bus history sample closest in time to `timestamp`, within `maxDeltaMs`. */
function nearestInTime(
    history: state.BusPositionSample[],
    timestamp: number,
    maxDeltaMs: number
): state.BusPositionSample | null {
    let best: state.BusPositionSample | null = null;
    let bestDelta = Infinity;
    for (const h of history) {
        const d = Math.abs(h.timestamp - timestamp);
        if (d < bestDelta) { bestDelta = d; best = h; }
    }
    return bestDelta <= maxDeltaMs ? best : null;
}

/**
 * Checks whether the trail contains an earlier window where the user moved
 * with this bus while the bus was in motion (the "was riding" signal used
 * when the bus is currently stopped at a light or stop).
 */
function hadPriorCoMovement(trail: LocationSample[], history: state.BusPositionSample[]): boolean {
    const sortedHist = [...history].sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 0; i + 1 < sortedHist.length; i++) {
        const b1 = sortedHist[i];
        const b2 = sortedHist[i + 1];
        const dt = (b2.timestamp - b1.timestamp) / 1000;
        if (dt <= 0) continue;
        const busSpeed = haversine(b1.lat, b1.lon, b2.lat, b2.lon) / dt;
        if (busSpeed < MOVING_BUS_SPEED_MS) continue;

        const userWindow = trail.filter(
            s => s.timestamp >= b1.timestamp - 5000 && s.timestamp <= b2.timestamp + 5000
        );
        if (userWindow.length < 2) continue;
        const uVel = velocityFromSamples(userWindow, Number.MAX_SAFE_INTEGER);
        if (!uVel || uVel.speed < MOVING_BUS_SPEED_MS) continue;

        const busHeading = bearing(b1.lat, b1.lon, b2.lat, b2.lon);
        if (uVel.heading !== null && headingDiff(uVel.heading, busHeading) > HEADING_TOLERANCE_DEG) continue;

        const ratio = uVel.speed / busSpeed;
        if (ratio < SPEED_RATIO_MIN || ratio > SPEED_RATIO_MAX) continue;

        const mid = userWindow[Math.floor(userWindow.length / 2)];
        const distToSegment = Math.min(
            haversine(mid.lat, mid.lon, b1.lat, b1.lon),
            haversine(mid.lat, mid.lon, b2.lat, b2.lon)
        );
        if (distToSegment > PROXIMITY_THRESHOLD_M) continue;

        return true;
    }
    return false;
}

/** Whether the user stayed within tight proximity of the bus across the trail. */
function sustainedTightProximity(trail: LocationSample[], history: state.BusPositionSample[]): boolean {
    let matched = 0;
    let within = 0;
    for (const s of trail) {
        const b = nearestInTime(history, s.timestamp, 10_000);
        if (!b) continue;
        matched++;
        if (haversine(s.lat, s.lon, b.lat, b.lon) <= TIGHT_BUS_PROXIMITY_M) within++;
    }
    return matched >= 2 && within / matched >= 0.6;
}

/** Whether the user-to-bus distance stayed stable (not drifting apart) over the trail. */
function distanceStable(trail: LocationSample[], history: state.BusPositionSample[]): boolean {
    const distances: number[] = [];
    for (const s of trail) {
        const b = nearestInTime(history, s.timestamp, 10_000);
        if (b) distances.push(haversine(s.lat, s.lon, b.lat, b.lon));
    }
    if (distances.length < 2) return true; // not enough overlap to judge; don't reject
    return distances[distances.length - 1] <= distances[0] + 20;
}

const STATUS_RANK: Record<OnBusStatus, number> = {
    on_bus: 3,
    waiting_at_stop: 2,
    near_bus: 1,
    not_near_bus: 0,
};

/**
 * Detects whether the user is physically standing at a known stop.
 * @returns Context for the nearest stop within STOP_PROXIMITY_M, or null.
 */
export function detectAtStopContext(userLat: number, userLon: number): AtStopContext | null {
    try {
        const nearest = graphBuilder.findNearestStops(userLat, userLon, 1);
        if (!nearest.length || nearest[0].distance > STOP_PROXIMITY_M) return null;
        return {
            stopId: nearest[0].stpid,
            stopName: nearest[0].name,
            distanceMeters: nearest[0].distance,
            walkTimeSeconds: 0,
        };
    } catch {
        return null;
    }
}

/**
 * Classifies the user's relationship to nearby buses using motion correlation.
 * Proximity alone never yields `on_bus`; the trail must show co-movement
 * (or prior co-movement when the bus is currently stopped).
 *
 * @param userLat - Current user latitude.
 * @param userLon - Current user longitude.
 * @param locationTrail - Recent user location samples (oldest to newest).
 * @param candidateVid - Optional vehicle ID to restrict evaluation to.
 */
export function classifyOnBusStatus(
    userLat: number,
    userLon: number,
    locationTrail: LocationSample[],
    candidateVid?: string
): OnBusClassification {
    const trail = [...(locationTrail || [])].sort((a, b) => a.timestamp - b.timestamp);

    const candidates: { vid: string, bus: any, distance: number }[] = [];
    for (const bus of state.curBusPositions.buses) {
        const vid = bus.vid || bus.id;
        if (!vid) continue;
        if (candidateVid && vid !== candidateVid) continue;
        const lat = parseFloat(bus.lat);
        const lon = parseFloat(bus.lon);
        if (isNaN(lat) || isNaN(lon)) continue;
        const distance = haversine(userLat, userLon, lat, lon);
        if (distance <= PROXIMITY_THRESHOLD_M) candidates.push({ vid, bus, distance });
    }

    if (candidates.length === 0) {
        return {
            status: 'not_near_bus',
            confidence: 0,
            reason: candidateVid ? 'candidate_bus_not_nearby' : 'no_bus_within_proximity',
        };
    }

    const trailValid = isTrailValid(trail);
    const uVel = trailValid ? userVelocity(trail) : null;
    const userStopped = !uVel || uVel.speed < STOPPED_SPEED_MS;
    const atStop = detectAtStopContext(userLat, userLon) !== null;

    let best: OnBusClassification | null = null;
    for (const cand of candidates) {
        const result = classifyCandidate(cand.vid, cand.bus, trail, trailValid, uVel, userStopped, atStop);
        if (!best
            || STATUS_RANK[result.status] > STATUS_RANK[best.status]
            || (STATUS_RANK[result.status] === STATUS_RANK[best.status] && result.confidence > best.confidence)) {
            best = result;
        }
    }
    return best!;
}

function classifyCandidate(
    vid: string,
    bus: any,
    trail: LocationSample[],
    trailValid: boolean,
    uVel: Velocity | null,
    userStopped: boolean,
    atStop: boolean
): OnBusClassification {
    const history = state.busPositionHistory[vid] || [];
    const bVel = busVelocity(vid, bus);
    const busMoving = bVel.speed >= MOVING_BUS_SPEED_MS;
    const priorCoMove = trailValid && hadPriorCoMovement(trail, history);

    if (busMoving) {
        if (!trailValid) {
            return { status: 'near_bus', vid, confidence: 0.2, reason: 'trail_insufficient' };
        }
        if (!uVel || userStopped || uVel.speed < MOVING_BUS_SPEED_MS) {
            return { status: 'near_bus', vid, confidence: 0.2, reason: 'user_not_moving_with_bus' };
        }

        const hd = (uVel.heading !== null && bVel.heading !== null)
            ? headingDiff(uVel.heading, bVel.heading)
            : null;
        const ratio = bVel.speed > 0 ? uVel.speed / bVel.speed : 0;
        const headingOk = hd === null || hd < HEADING_TOLERANCE_DEG;
        const ratioOk = ratio >= SPEED_RATIO_MIN && ratio <= SPEED_RATIO_MAX;
        const stable = distanceStable(trail, history);

        if (headingOk && ratioOk && stable) {
            const headingScore = hd === null ? 0.5 : 1 - hd / HEADING_TOLERANCE_DEG;
            const ratioScore = Math.max(0, 1 - Math.abs(1 - ratio));
            const confidence = Math.min(1, 0.5 + 0.25 * headingScore + 0.25 * ratioScore);
            return { status: 'on_bus', vid, confidence, reason: 'co_movement_matched' };
        }
        const reason = !headingOk ? 'heading_mismatch' : !ratioOk ? 'speed_mismatch' : 'drifting_from_bus';
        return { status: 'near_bus', vid, confidence: 0.3, reason };
    }

    // Bus is stationary (or too slow to confirm motion)
    if (priorCoMove) {
        if (atStop) {
            if (sustainedTightProximity(trail, history)) {
                // User tracked this bus while it moved and is still right on top of it
                return { status: 'on_bus', vid, confidence: 0.7, reason: 'prior_co_movement_bus_at_stop' };
            }
            // Was near the bus but not tightly: ambiguous, default to waiting
            return { status: 'waiting_at_stop', vid, confidence: 0.5, reason: 'prior_co_movement_not_tight' };
        }
        // e.g. bus paused at a red light mid-route while user remains aboard
        return { status: 'on_bus', vid, confidence: 0.6, reason: 'prior_co_movement_bus_paused' };
    }

    if (atStop && userStopped) {
        return { status: 'waiting_at_stop', vid, confidence: 0.6, reason: 'user_stationary_near_stop' };
    }

    return {
        status: 'near_bus',
        vid,
        confidence: 0.2,
        reason: trailValid ? 'no_co_movement_detected' : 'trail_insufficient',
    };
}

/** Picks the trip stop index the user can ride from, using predictions then time then distance. */
function determineBoardIndex(
    trip: Trip,
    vid: string,
    busLat: number,
    busLon: number,
    currentTime: number
): number {
    // Primary: the vehicle's next predicted stop
    const preds = state.cachedPredsByVid[vid];
    if (preds && preds.length > 0) {
        const idx = trip.stopTimes.findIndex(st => st.stop === preds[0].stpid);
        if (idx >= 0) return idx;
    }
    // Secondary: first stop the trip has not yet reached
    const timeIdx = trip.stopTimes.findIndex(st => st.arrivalTime >= currentTime);
    if (timeIdx >= 0) return timeIdx;
    // Tertiary: stop nearest to the bus's GPS position
    let bestIdx = 0;
    let bestDist = Infinity;
    trip.stopTimes.forEach((st, i) => {
        const loc = state.cachedStopLocations[st.stop];
        if (!loc) return;
        const d = haversine(busLat, busLon, loc.lat, loc.lon);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    return bestIdx;
}

/**
 * Builds the routing context for a user confirmed to be on a bus:
 * locates the vehicle and its active trip, picks the boarding index, resolves
 * the physical stop if the bus is stopped at one, and builds the trimmed trip
 * starting from a virtual on-bus stop.
 *
 * @param vid - Vehicle ID the user is on.
 * @param userLat - Current user latitude (unused for resolution, kept for parity).
 * @param userLon - Current user longitude.
 * @param currentTime - Journey time in seconds since midnight (UTC).
 * @param classification - The classification that confirmed on-bus status.
 * @returns Context for graph injection, or null when the bus has no active trip.
 */
export function resolveOnBusContext(
    vid: string,
    userLat: number,
    userLon: number,
    currentTime: number,
    classification: OnBusClassification
): OnBusContext | null {
    const bus = state.curBusPositions.buses.find(b => (b.vid || b.id) === vid);
    if (!bus) return null;
    const busLat = parseFloat(bus.lat);
    const busLon = parseFloat(bus.lon);
    if (isNaN(busLat) || isNaN(busLon)) return null;

    const trip = graphBuilder.findTripByVid(vid);
    if (!trip || trip.stopTimes.length === 0) return null;

    const boardStopIndex = determineBoardIndex(trip, vid, busLat, busLon, currentTime);
    const remaining = trip.stopTimes.slice(boardStopIndex);
    if (remaining.length === 0) return null;

    // Physical stop the bus is currently servicing, if stationary at one
    let currentStopId: string | undefined;
    let currentStopName: string | undefined;
    let isStoppedAtStop = false;
    if (busVelocity(vid, bus).speed < STOPPED_SPEED_MS) {
        try {
            const nearest = graphBuilder.findNearestStops(busLat, busLon, 1);
            if (nearest.length && nearest[0].distance <= STOP_PROXIMITY_M) {
                currentStopId = nearest[0].stpid;
                currentStopName = nearest[0].name;
                isStoppedAtStop = true;
            }
        } catch {
            // No stop locations cached; treat as not at a stop
        }
    }

    const virtualStopId = `ON_BUS_${vid}`;
    const rt = remaining[0].rt || state.tatripidToRt[trip.tripId] || bus.rt || 'UNKNOWN';

    const trimmedTrip: Trip = {
        tripId: trip.tripId,
        vid: trip.vid,
        stopTimes: [
            { stop: virtualStopId, arrivalTime: currentTime, departureTime: currentTime, pickUp: true, dropOff: false },
            // Clamp slightly-stale predictions so times stay monotonic from "now"
            ...remaining.map(st => st.arrivalTime < currentTime
                ? { ...st, arrivalTime: currentTime, departureTime: Math.max(st.departureTime, currentTime) }
                : st),
        ],
    };

    return {
        vid,
        tripId: trip.tripId,
        rt,
        virtualStopId,
        boardStopIndex,
        busLat,
        busLon,
        trimmedTrip,
        classification,
        currentStopId,
        currentStopName,
        isStoppedAtStop,
    };
}
