import { Trip, TransfersByOrigin, Interchange, StopID } from '../../src/raptor/types';
import { Journey } from '../../src/raptor/McRaptorAlgorithm';

/**
 * The three optimization criteria of the McRaptor search.
 * transferCount counts boardings (a direct ride has transferCount 1).
 */
export interface Criteria {
    arrivalTime: number;
    walkingDistance: number;
    transferCount: number;
}

export interface Scenario {
    trips: Trip[];
    transfers: TransfersByOrigin;
    interchange: Interchange;
    origin: StopID;
    destination: StopID;
    departureTime: number;
    walkingPenalty?: number;
}

/** Sorts criteria lexicographically so two frontiers can be compared with toEqual. */
export function sortCriteria(list: Criteria[]): Criteria[] {
    return [...list].sort((a, b) =>
        a.arrivalTime - b.arrivalTime ||
        a.walkingDistance - b.walkingDistance ||
        a.transferCount - b.transferCount
    );
}

function dominates(a: Criteria, b: Criteria): boolean {
    if (a.arrivalTime > b.arrivalTime) return false;
    if (a.walkingDistance > b.walkingDistance) return false;
    if (a.transferCount > b.transferCount) return false;
    return a.arrivalTime < b.arrivalTime || a.walkingDistance < b.walkingDistance || a.transferCount < b.transferCount;
}

function sameCriteria(a: Criteria, b: Criteria): boolean {
    return a.arrivalTime === b.arrivalTime
        && a.walkingDistance === b.walkingDistance
        && a.transferCount === b.transferCount;
}

interface SearchState {
    stop: StopID;
    time: number;
    walk: number;
    rides: number;
    /** Walking legs may not chain: transfers are assumed transitively closed upstream. */
    lastWasWalk: boolean;
}

/**
 * Brute-force reference implementation of the intended journey semantics:
 * exhaustively enumerates every feasible journey (up to maxRides boardings)
 * and returns the exact Pareto frontier of (arrivalTime, walkingDistance,
 * transferCount) at the destination. Deliberately independent of the
 * McRaptor implementation so the two can be compared.
 *
 * Semantics mirrored:
 * - The interchange buffer applies before every boarding, including the first.
 * - pickUp === false forbids boarding, dropOff === false forbids alighting.
 * - A transfer is usable only if the walk starts within [startTime, endTime].
 * - walkingPenalty scales the walking criterion, not the arrival time.
 * - Two walking legs never follow each other.
 */
export function bruteForceParetoCriteria(scenario: Scenario, maxRides: number = 8): Criteria[] {
    const { trips, transfers, interchange, origin, destination, departureTime } = scenario;
    const penalty = scenario.walkingPenalty ?? 1;

    const boardings = new Map<StopID, { trip: Trip; index: number }[]>();
    for (const trip of trips) {
        trip.stopTimes.forEach((st, index) => {
            if (!boardings.has(st.stop)) boardings.set(st.stop, []);
            boardings.get(st.stop)!.push({ trip, index });
        });
    }

    const best = new Map<string, { time: number; walk: number; rides: number }[]>();
    const atDestination: Criteria[] = [];
    const queue: SearchState[] = [];

    const offer = (state: SearchState) => {
        const key = `${state.stop}|${state.lastWasWalk ? 1 : 0}`;
        const labels = best.get(key) ?? [];
        for (const l of labels) {
            if (l.time <= state.time && l.walk <= state.walk && l.rides <= state.rides) return;
        }
        const kept = labels.filter(l => !(state.time <= l.time && state.walk <= l.walk && state.rides <= l.rides));
        kept.push({ time: state.time, walk: state.walk, rides: state.rides });
        best.set(key, kept);

        if (state.stop === destination) {
            atDestination.push({ arrivalTime: state.time, walkingDistance: state.walk, transferCount: state.rides });
        }
        queue.push(state);
    };

    offer({ stop: origin, time: departureTime, walk: 0, rides: 0, lastWasWalk: false });

    while (queue.length > 0) {
        const s = queue.pop()!;

        if (s.rides < maxRides) {
            const buffer = interchange[s.stop] || 0;
            for (const { trip, index } of boardings.get(s.stop) ?? []) {
                const board = trip.stopTimes[index];
                if (board.pickUp === false) continue;
                if (board.departureTime < s.time + buffer) continue;
                for (let j = index + 1; j < trip.stopTimes.length; j++) {
                    const alight = trip.stopTimes[j];
                    if (alight.dropOff === false) continue;
                    offer({
                        stop: alight.stop,
                        time: alight.arrivalTime,
                        walk: s.walk,
                        rides: s.rides + 1,
                        lastWasWalk: false
                    });
                }
            }
        }

        if (!s.lastWasWalk) {
            for (const t of transfers[s.stop] ?? []) {
                if (s.time < t.startTime || s.time > t.endTime) continue;
                offer({
                    stop: t.destination,
                    time: s.time + t.duration,
                    walk: s.walk + t.duration * penalty,
                    rides: s.rides,
                    lastWasWalk: true
                });
            }
        }
    }

    const unique: Criteria[] = [];
    for (const c of atDestination) {
        if (!unique.some(u => sameCriteria(u, c))) unique.push(c);
    }
    return sortCriteria(unique.filter(c => !unique.some(u => dominates(u, c))));
}

/**
 * Checks that a journey returned by the algorithm is internally consistent
 * and actually executable against the scenario's data: legs connect, times
 * come from real trips/transfers, buffers and pickUp/dropOff/window rules are
 * respected, and the reported criteria match a replay of the legs.
 */
export function validateJourney(journey: Journey, scenario: Scenario): void {
    const penalty = scenario.walkingPenalty ?? 1;
    const { legs, criteria } = journey;

    const describe = () => legs
        .map(l => `${l.type}:${l.origin}->${l.destination}@${l.startTime}-${l.endTime}`)
        .join(', ');
    const fail = (msg: string): never => {
        throw new Error(`Invalid journey (${msg}); criteria=${JSON.stringify(criteria)}; legs=[${describe()}]`);
    };

    if (legs.length === 0) {
        if (scenario.origin !== scenario.destination) fail('no legs but origin differs from destination');
        if (criteria.arrivalTime !== scenario.departureTime || criteria.walkingDistance !== 0 || criteria.transferCount !== 0) {
            fail('trivial journey criteria mismatch');
        }
        return;
    }

    if (legs[0].origin !== scenario.origin) fail('first leg does not start at the origin');
    if (legs[legs.length - 1].destination !== scenario.destination) fail('last leg does not end at the destination');

    let cursor = scenario.departureTime;
    let walkCost = 0;
    let rides = 0;

    for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        if (i > 0 && legs[i - 1].destination !== leg.origin) fail(`leg ${i} does not start where leg ${i - 1} ended`);

        if (leg.type === 'Transfer') {
            if (i > 0 && legs[i - 1].type === 'Transfer') fail('two consecutive walking legs');
            const match = (scenario.transfers[leg.origin] ?? [])
                .find(t => t.destination === leg.destination && t.duration === leg.duration);
            if (!match) return fail(`no transfer ${leg.origin}->${leg.destination} of duration ${leg.duration}`);
            if (leg.startTime !== cursor) fail(`walk leg ${i} does not start when the previous leg ended`);
            if (cursor < match.startTime || cursor > match.endTime) fail(`walk leg ${i} starts outside the transfer window`);
            if (leg.endTime !== leg.startTime + match.duration) fail(`walk leg ${i} end time mismatch`);
            walkCost += match.duration * penalty;
            cursor = leg.endTime;
        } else {
            const trip = scenario.trips.find(t => t.tripId === leg.trip?.tripId);
            if (!trip) return fail(`ride leg ${i} references unknown trip ${leg.trip?.tripId}`);
            const buffer = scenario.interchange[leg.origin] || 0;
            if (leg.startTime < cursor + buffer) fail(`ride leg ${i} boards before the ${buffer}s interchange buffer`);

            let consistent = false;
            for (let bi = 0; bi < trip.stopTimes.length && !consistent; bi++) {
                const board = trip.stopTimes[bi];
                if (board.stop !== leg.origin || board.departureTime !== leg.startTime || board.pickUp === false) continue;
                for (let ai = bi + 1; ai < trip.stopTimes.length; ai++) {
                    const alight = trip.stopTimes[ai];
                    if (alight.stop === leg.destination && alight.arrivalTime === leg.endTime && alight.dropOff !== false) {
                        consistent = true;
                        break;
                    }
                }
            }
            if (!consistent) fail(`ride leg ${i} cannot be executed on trip ${trip.tripId}`);
            rides++;
            cursor = leg.endTime;
        }
    }

    if (criteria.arrivalTime !== cursor) fail(`criteria.arrivalTime ${criteria.arrivalTime} != replayed arrival ${cursor}`);
    if (Math.abs(criteria.walkingDistance - walkCost) > 1e-6) fail(`criteria.walkingDistance ${criteria.walkingDistance} != replayed ${walkCost}`);
    if (criteria.transferCount !== rides) fail(`criteria.transferCount ${criteria.transferCount} != boarding count ${rides}`);
}
