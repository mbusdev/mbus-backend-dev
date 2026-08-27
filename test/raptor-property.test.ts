import { describe, it, expect } from 'vitest';
import { McRaptorAlgorithm } from '../src/raptor/McRaptorAlgorithm';
import { Trip, Transfer, Interchange } from '../src/raptor/types';
import { walkTransfer, transferMap, makeTrip, StopTimeSpec } from './helpers/network';
import { Scenario, bruteForceParetoCriteria, sortCriteria, validateJourney } from './helpers/oracle';

/**
 * Differential test: generates hundreds of small random-but-realistic transit
 * networks (loops, overtaking expresses, pickUp/dropOff restrictions, windowed
 * transfers, varied interchange buffers and walking penalties) and checks that
 * the McRaptor result set exactly equals the brute-force Pareto frontier, and
 * that every returned journey is executable against the raw data.
 *
 * Deterministic: seeded PRNG, so failures reproduce by seed.
 */

function mulberry32(seed: number): () => number {
    let t = seed;
    return () => {
        t += 0x6D2B79F5;
        let r = Math.imul(t ^ (t >>> 15), t | 1);
        r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

function randInt(rand: () => number, maxExclusive: number): number {
    return Math.floor(rand() * maxExclusive);
}

function shuffled<T>(rand: () => number, list: T[]): T[] {
    const arr = [...list];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = randInt(rand, i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

const BASE_TIME = 36000; // 10:00

function generateScenario(rand: () => number): Scenario {
    const numStops = 4 + randInt(rand, 7);
    const stops = Array.from({ length: numStops }, (_, i) => `S${i}`);

    const transfers: Transfer[] = [];
    for (const o of stops) {
        for (const d of stops) {
            if (o === d || rand() >= 0.25) continue;
            const duration = 60 + randInt(rand, 540);
            let endTime = Number.MAX_SAFE_INTEGER;
            if (rand() < 0.15) {
                // Only expiring windows. A window that opens in the future is
                // never produced by the graph builder and breaks the Pareto
                // monotonicity both the algorithm and the oracle rely on; the
                // not-yet-open behavior is pinned in raptor-core.test.ts.
                endTime = BASE_TIME + randInt(rand, 3000);
            }
            transfers.push(walkTransfer(o, d, duration, 0, endTime));
        }
    }

    const interchange: Interchange = {};
    for (const s of stops) interchange[s] = [0, 15, 30, 60][randInt(rand, 4)];

    const trips: Trip[] = [];
    const numRoutes = 2 + randInt(rand, 3);
    for (let r = 0; r < numRoutes; r++) {
        const len = 3 + randInt(rand, Math.min(4, numStops - 2));
        const routeStops = shuffled(rand, stops).slice(0, len);
        if (rand() < 0.15) routeStops.push(routeStops[0]); // loop route

        const travelTimes = Array.from({ length: routeStops.length - 1 }, () => 60 + randInt(rand, 420));
        const runs = 1 + randInt(rand, 3);
        const headway = 300 + randInt(rand, 900);
        const firstDeparture = BASE_TIME + randInt(rand, 1800);
        const dwell = rand() < 0.5 ? 0 : 20;

        const buildRun = (tripId: string, dep0: number, times: number[]): Trip => {
            const specs: StopTimeSpec[] = [];
            let arr = dep0;
            routeStops.forEach((stop, i) => {
                const isLast = i === routeStops.length - 1;
                const dep = isLast ? arr : arr + dwell;
                specs.push({ stop, arr, dep, rt: `R${r}` });
                if (!isLast) arr = dep + times[i];
            });
            return makeTrip(tripId, null, specs);
        };

        const routeTrips: Trip[] = [];
        for (let run = 0; run < runs; run++) {
            routeTrips.push(buildRun(`R${r}_run${run}`, firstDeparture + run * headway, travelTimes));
        }

        // Occasionally add an overtaking express on the same stop sequence.
        if (rand() < 0.25) {
            const expressTimes = travelTimes.map(t => Math.max(30, Math.floor(t / 2)));
            routeTrips.push(buildRun(`R${r}_express`, firstDeparture + 60 + randInt(rand, headway), expressTimes));
        }

        // A closely trailing duplicate makes same-chain time ties likely once
        // times are quantized below.
        if (rand() < 0.3) {
            routeTrips.push(buildRun(`R${r}_bunched`, firstDeparture + 60 + randInt(rand, 180), travelTimes));
        }

        // Production countdowns are whole minutes, so bunched buses routinely
        // tie at stops; quantizing recreates that (regression: tied trips must
        // be scanned as separate chains, not tie-dominated in one route bag).
        if (rand() < 0.35) {
            for (const trip of routeTrips) {
                for (const st of trip.stopTimes) {
                    st.arrivalTime = Math.floor(st.arrivalTime / 60) * 60;
                    st.departureTime = Math.floor(st.departureTime / 60) * 60;
                }
            }
        }

        trips.push(...routeTrips);
    }

    // Sprinkle boarding/alighting restrictions.
    for (const trip of trips) {
        for (const st of trip.stopTimes) {
            if (rand() < 0.06) st.pickUp = false;
            if (rand() < 0.06) st.dropOff = false;
        }
    }

    const origin = stops[randInt(rand, numStops)];
    let destination = stops[randInt(rand, numStops)];
    if (destination === origin) destination = stops[(stops.indexOf(origin) + 1) % numStops];

    return {
        trips,
        transfers: transferMap(transfers),
        interchange,
        origin,
        destination,
        departureTime: BASE_TIME + randInt(rand, 1500),
        walkingPenalty: [0, 1, 1, 2, 8][randInt(rand, 5)],
    };
}

describe('McRaptor vs brute-force oracle on random networks', () => {
    const ITERATIONS = 500;

    it(`matches the exact Pareto frontier on ${ITERATIONS} seeded random networks`, () => {
        for (let seed = 1; seed <= ITERATIONS; seed++) {
            const scenario = generateScenario(mulberry32(seed));

            const algo = new McRaptorAlgorithm(scenario.trips, scenario.transfers, scenario.interchange);
            algo.setWalkingPenalty(scenario.walkingPenalty!);
            const journeys = algo.getOptimizedJourneys(scenario.origin, scenario.destination, scenario.departureTime);

            for (const journey of journeys) {
                try {
                    validateJourney(journey, scenario);
                } catch (e) {
                    throw new Error(`seed ${seed}: ${(e as Error).message}`);
                }
            }

            const got = sortCriteria(journeys.map(j => j.criteria));
            const want = bruteForceParetoCriteria(scenario);
            expect(got, `seed ${seed} (${scenario.origin} -> ${scenario.destination} @ ${scenario.departureTime}, penalty ${scenario.walkingPenalty})`).toEqual(want);
        }
    }, 30000);
});
