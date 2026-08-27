import { describe, it, expect } from 'vitest';
import { McRaptorAlgorithm, Journey } from '../src/raptor/McRaptorAlgorithm';
import { makeTrip, walkTransfer, transferMap, uniformInterchange, buildScheduledTrips } from './helpers/network';
import { Scenario, bruteForceParetoCriteria, sortCriteria, validateJourney } from './helpers/oracle';

/**
 * Runs the algorithm on a scenario, validates every returned journey against
 * the raw data, and asserts the returned criteria set equals the exact Pareto
 * frontier computed by the brute-force oracle.
 */
function runScenario(scenario: Scenario): Journey[] {
    const algo = new McRaptorAlgorithm(scenario.trips, scenario.transfers, scenario.interchange);
    if (scenario.walkingPenalty !== undefined) algo.setWalkingPenalty(scenario.walkingPenalty);

    const journeys = algo.getOptimizedJourneys(scenario.origin, scenario.destination, scenario.departureTime);
    for (const j of journeys) validateJourney(j, scenario);

    const got = sortCriteria(journeys.map(j => j.criteria));
    const want = bruteForceParetoCriteria(scenario);
    expect(got).toEqual(want);
    return journeys;
}

describe('McRaptor core: single rides and boarding rules', () => {
    it('finds a direct single-bus journey', () => {
        const scenario: Scenario = {
            trips: [makeTrip('BB_NORTH_0', '4001', [
                { stop: 'C250', arr: 1000 },
                { stop: 'M310', arr: 1200 },
                { stop: 'N551', arr: 1400 },
            ])],
            transfers: {},
            interchange: uniformInterchange(['C250', 'M310', 'N551']),
            origin: 'C250', destination: 'N551', departureTime: 900,
        };
        const journeys = runScenario(scenario);
        expect(journeys).toHaveLength(1);
        expect(journeys[0].criteria).toEqual({ arrivalTime: 1400, walkingDistance: 0, transferCount: 1 });
        expect(journeys[0].legs).toHaveLength(1);
        expect(journeys[0].legs[0]).toMatchObject({ type: 'Trip', origin: 'C250', destination: 'N551', startTime: 1000, endTime: 1400 });
    });

    it('does not board a bus that departs before the request time plus buffer', () => {
        const trips = [
            makeTrip('run0', '4001', [{ stop: 'C250', arr: 1000 }, { stop: 'N551', arr: 1400 }]),
            makeTrip('run1', '4002', [{ stop: 'C250', arr: 1600 }, { stop: 'N551', arr: 2000 }]),
        ];
        const scenario: Scenario = {
            trips, transfers: {},
            interchange: uniformInterchange(['C250', 'N551']),
            origin: 'C250', destination: 'N551', departureTime: 980, // 980 + 30 > 1000: first run missed
        };
        const journeys = runScenario(scenario);
        expect(journeys).toHaveLength(1);
        expect(journeys[0].criteria.arrivalTime).toBe(2000);
    });

    it('treats the interchange buffer boundary as inclusive', () => {
        const trips = [
            makeTrip('run0', '4001', [{ stop: 'C250', arr: 1000 }, { stop: 'N551', arr: 1400 }]),
            makeTrip('run1', '4002', [{ stop: 'C250', arr: 1600 }, { stop: 'N551', arr: 2000 }]),
        ];
        const interchange = uniformInterchange(['C250', 'N551']);

        // 970 + 30 = 1000 exactly: catchable.
        const caught = runScenario({ trips, transfers: {}, interchange, origin: 'C250', destination: 'N551', departureTime: 970 });
        expect(caught[0].criteria.arrivalTime).toBe(1400);

        // 971 + 30 = 1001 > 1000: missed.
        const missed = runScenario({ trips, transfers: {}, interchange, origin: 'C250', destination: 'N551', departureTime: 971 });
        expect(missed[0].criteria.arrivalTime).toBe(2000);
    });

    it('skips a trip whose boarding stop has pickUp=false and boards the next one', () => {
        // Both trips share a stop sequence, so they end up in the same FIFO chain;
        // the earliest catchable trip forbids boarding and must be passed over.
        const trips = [
            makeTrip('noPickup', '4001', [{ stop: 'C250', arr: 1000, pickUp: false }, { stop: 'N551', arr: 1200 }]),
            makeTrip('okPickup', '4002', [{ stop: 'C250', arr: 1100 }, { stop: 'N551', arr: 1300 }]),
        ];
        const journeys = runScenario({
            trips, transfers: {},
            interchange: uniformInterchange(['C250', 'N551']),
            origin: 'C250', destination: 'N551', departureTime: 900,
        });
        expect(journeys).toHaveLength(1);
        expect(journeys[0].criteria.arrivalTime).toBe(1300);
        expect(journeys[0].legs[0].trip?.tripId).toBe('okPickup');
    });

    it('does not alight at a stop with dropOff=false but can ride past it', () => {
        const trips = [makeTrip('t', '4001', [
            { stop: 'X', arr: 1000 },
            { stop: 'Y', arr: 1200, dropOff: false },
            { stop: 'Z', arr: 1400 },
        ])];
        const interchange = uniformInterchange(['X', 'Y', 'Z']);

        const toY = runScenario({ trips, transfers: {}, interchange, origin: 'X', destination: 'Y', departureTime: 900 });
        expect(toY).toHaveLength(0);

        const toZ = runScenario({ trips, transfers: {}, interchange, origin: 'X', destination: 'Z', departureTime: 900 });
        expect(toZ).toHaveLength(1);
        expect(toZ[0].criteria.arrivalTime).toBe(1400);
    });

    it('handles trips running past midnight (times above 86400)', () => {
        const trips = [makeTrip('late', '4001', [{ stop: 'C250', arr: 86300 }, { stop: 'N551', arr: 86800 }])];
        const journeys = runScenario({
            trips, transfers: {},
            interchange: uniformInterchange(['C250', 'N551']),
            origin: 'C250', destination: 'N551', departureTime: 86200,
        });
        expect(journeys).toHaveLength(1);
        expect(journeys[0].criteria.arrivalTime).toBe(86800);
    });

    it('returns a single trivial journey when origin equals destination', () => {
        const trips = [makeTrip('t', '4001', [{ stop: 'C250', arr: 1000 }, { stop: 'N551', arr: 1400 }])];
        const journeys = runScenario({
            trips, transfers: {},
            interchange: uniformInterchange(['C250', 'N551']),
            origin: 'C250', destination: 'C250', departureTime: 900,
        });
        expect(journeys).toHaveLength(1);
        expect(journeys[0].legs).toHaveLength(0);
        expect(journeys[0].criteria).toEqual({ arrivalTime: 900, walkingDistance: 0, transferCount: 0 });
    });

    it('returns no journeys when the destination is unreachable', () => {
        const trips = [makeTrip('t', '4001', [{ stop: 'A', arr: 1000 }, { stop: 'B', arr: 1400 }])];
        const journeys = runScenario({
            trips, transfers: {},
            interchange: uniformInterchange(['A', 'B', 'ISLAND']),
            origin: 'A', destination: 'ISLAND', departureTime: 900,
        });
        expect(journeys).toHaveLength(0);
    });
});

describe('McRaptor core: transfers and walking', () => {
    it('finds a two-bus journey transferring at a shared stop', () => {
        const trips = [
            makeTrip('leg1', '4001', [{ stop: 'S1', arr: 1000 }, { stop: 'S2', arr: 1300 }]),
            makeTrip('leg2', '4002', [{ stop: 'S2', arr: 1400 }, { stop: 'S3', arr: 1700 }]),
        ];
        const journeys = runScenario({
            trips, transfers: {},
            interchange: uniformInterchange(['S1', 'S2', 'S3']),
            origin: 'S1', destination: 'S3', departureTime: 900,
        });
        expect(journeys).toHaveLength(1);
        expect(journeys[0].criteria).toEqual({ arrivalTime: 1700, walkingDistance: 0, transferCount: 2 });
        expect(journeys[0].legs.map(l => l.type)).toEqual(['Trip', 'Trip']);
    });

    it('finds a journey that walks between stops to transfer', () => {
        const trips = [
            makeTrip('leg1', '4001', [{ stop: 'S1', arr: 1000 }, { stop: 'S2', arr: 1300 }]),
            makeTrip('leg2', '4002', [{ stop: 'S3', arr: 1500 }, { stop: 'S4', arr: 1800 }]),
        ];
        const journeys = runScenario({
            trips,
            transfers: transferMap([walkTransfer('S2', 'S3', 120)]),
            interchange: uniformInterchange(['S1', 'S2', 'S3', 'S4']),
            origin: 'S1', destination: 'S4', departureTime: 900,
        });
        expect(journeys).toHaveLength(1);
        expect(journeys[0].criteria).toEqual({ arrivalTime: 1800, walkingDistance: 120, transferCount: 2 });
        expect(journeys[0].legs.map(l => l.type)).toEqual(['Trip', 'Transfer', 'Trip']);
    });

    it('walks from the origin to reach a better stop (round-0 footpath)', () => {
        const trips = [
            makeTrip('viaA', '4001', [{ stop: 'A', arr: 1100 }, { stop: 'D', arr: 1400 }]),
            makeTrip('fromO', '4002', [{ stop: 'O', arr: 1300 }, { stop: 'D', arr: 1800 }]),
        ];
        const journeys = runScenario({
            trips,
            transfers: transferMap([walkTransfer('O', 'A', 100)]),
            interchange: uniformInterchange(['O', 'A', 'D']),
            origin: 'O', destination: 'D', departureTime: 900,
        });
        // Walk to A then ride (faster, some walking) vs ride from O (slower, no walking).
        expect(sortCriteria(journeys.map(j => j.criteria))).toEqual([
            { arrivalTime: 1400, walkingDistance: 100, transferCount: 1 },
            { arrivalTime: 1800, walkingDistance: 0, transferCount: 1 },
        ]);
    });

    it('walks after the final bus to reach the destination', () => {
        const trips = [makeTrip('t', '4001', [{ stop: 'O', arr: 1000 }, { stop: 'A', arr: 1300 }])];
        const journeys = runScenario({
            trips,
            transfers: transferMap([walkTransfer('A', 'D', 150)]),
            interchange: uniformInterchange(['O', 'A', 'D']),
            origin: 'O', destination: 'D', departureTime: 900,
        });
        expect(journeys).toHaveLength(1);
        expect(journeys[0].criteria).toEqual({ arrivalTime: 1450, walkingDistance: 150, transferCount: 1 });
    });

    it('finds a walk-only journey when no bus helps', () => {
        const journeys = runScenario({
            trips: [],
            transfers: transferMap([walkTransfer('O', 'D', 600)]),
            interchange: uniformInterchange(['O', 'D']),
            origin: 'O', destination: 'D', departureTime: 900,
        });
        expect(journeys).toHaveLength(1);
        expect(journeys[0].criteria).toEqual({ arrivalTime: 1500, walkingDistance: 600, transferCount: 0 });
        expect(journeys[0].legs).toHaveLength(1);
        expect(journeys[0].legs[0].type).toBe('Transfer');
    });

    it('does not chain two walking legs (transfer table is assumed transitively closed)', () => {
        // O->M and M->D exist but O->D does not. The graph builder always
        // produces all-pairs transfers, so single-hop walking is the contract.
        const journeys = runScenario({
            trips: [],
            transfers: transferMap([walkTransfer('O', 'M', 100), walkTransfer('M', 'D', 100)]),
            interchange: uniformInterchange(['O', 'M', 'D']),
            origin: 'O', destination: 'D', departureTime: 900,
        });
        expect(journeys).toHaveLength(0);
    });
});

describe('McRaptor core: transfer time windows', () => {
    it('ignores a transfer whose window has expired', () => {
        const transfers = transferMap([walkTransfer('O', 'D', 300, 0, 900)]);
        const journeys = runScenario({
            trips: [], transfers,
            interchange: uniformInterchange(['O', 'D']),
            origin: 'O', destination: 'D', departureTime: 1000,
        });
        expect(journeys).toHaveLength(0);
    });

    it('treats the transfer window end as inclusive', () => {
        const transfers = transferMap([walkTransfer('O', 'D', 300, 0, 1000)]);
        const journeys = runScenario({
            trips: [], transfers,
            interchange: uniformInterchange(['O', 'D']),
            origin: 'O', destination: 'D', departureTime: 1000,
        });
        expect(journeys).toHaveLength(1);
        expect(journeys[0].criteria.arrivalTime).toBe(1300);
    });

    it('ignores a transfer whose window has not opened yet (no waiting to walk)', () => {
        const transfers = transferMap([walkTransfer('O', 'D', 300, 1200, Number.MAX_SAFE_INTEGER)]);
        const journeys = runScenario({
            trips: [], transfers,
            interchange: uniformInterchange(['O', 'D']),
            origin: 'O', destination: 'D', departureTime: 1000,
        });
        expect(journeys).toHaveLength(0);
    });

    it('applies the window to mid-journey transfers based on when the walk starts', () => {
        const trips = [makeTrip('t', '4001', [{ stop: 'O', arr: 1100 }, { stop: 'A', arr: 1400 }])];
        const interchange = uniformInterchange(['O', 'A', 'D']);

        const closed = runScenario({
            trips, transfers: transferMap([walkTransfer('A', 'D', 100, 0, 1399)]),
            interchange, origin: 'O', destination: 'D', departureTime: 900,
        });
        expect(closed).toHaveLength(0);

        const open = runScenario({
            trips, transfers: transferMap([walkTransfer('A', 'D', 100, 0, 1400)]),
            interchange, origin: 'O', destination: 'D', departureTime: 900,
        });
        expect(open).toHaveLength(1);
        expect(open[0].criteria).toEqual({ arrivalTime: 1500, walkingDistance: 100, transferCount: 1 });
    });
});

describe('McRaptor core: Pareto optimality', () => {
    it('returns all mutually non-dominated journeys and drops dominated ones', () => {
        const trips = [
            makeTrip('direct', '4001', [{ stop: 'O', arr: 960 }, { stop: 'D', arr: 1400 }]),
            makeTrip('viaA', '4002', [{ stop: 'A', arr: 1080 }, { stop: 'D', arr: 1300 }]),
            makeTrip('slowDirect', '4003', [{ stop: 'O', arr: 1000 }, { stop: 'D', arr: 1450 }]), // dominated by 'direct'
        ];
        const journeys = runScenario({
            trips,
            transfers: transferMap([walkTransfer('O', 'A', 100), walkTransfer('O', 'D', 600)]),
            interchange: uniformInterchange(['O', 'A', 'D']),
            origin: 'O', destination: 'D', departureTime: 900,
        });
        expect(sortCriteria(journeys.map(j => j.criteria))).toEqual([
            { arrivalTime: 1300, walkingDistance: 100, transferCount: 1 }, // walk + fast bus
            { arrivalTime: 1400, walkingDistance: 0, transferCount: 1 },  // direct bus
            { arrivalTime: 1500, walkingDistance: 600, transferCount: 0 }, // pure walk
        ]);
        expect(journeys.some(j => j.legs.some(l => l.trip?.tripId === 'slowDirect'))).toBe(false);
    });

    it('drops a two-bus journey dominated by a direct bus, but keeps it when it is faster', () => {
        const interchange = uniformInterchange(['O', 'M', 'D']);
        const direct = makeTrip('direct', '4001', [{ stop: 'O', arr: 1000 }, { stop: 'D', arr: 1500 }]);
        const first = makeTrip('first', '4002', [{ stop: 'O', arr: 950 }, { stop: 'M', arr: 1050 }]);

        // Second leg arrives later than the direct bus: dominated (more boardings, later).
        const slowSecond = makeTrip('slowSecond', '4003', [{ stop: 'M', arr: 1100 }, { stop: 'D', arr: 1600 }]);
        const dominated = runScenario({
            trips: [direct, first, slowSecond], transfers: {}, interchange,
            origin: 'O', destination: 'D', departureTime: 900,
        });
        expect(dominated.map(j => j.criteria)).toEqual([
            { arrivalTime: 1500, walkingDistance: 0, transferCount: 1 },
        ]);

        // Second leg beats the direct bus: both survive (earlier vs fewer boardings).
        const fastSecond = makeTrip('fastSecond', '4004', [{ stop: 'M', arr: 1100 }, { stop: 'D', arr: 1400 }]);
        const both = runScenario({
            trips: [direct, first, fastSecond], transfers: {}, interchange,
            origin: 'O', destination: 'D', departureTime: 900,
        });
        expect(sortCriteria(both.map(j => j.criteria))).toEqual([
            { arrivalTime: 1400, walkingDistance: 0, transferCount: 2 },
            { arrivalTime: 1500, walkingDistance: 0, transferCount: 1 },
        ]);
    });

    it('applies the walking penalty to the walking criterion only', () => {
        const trips = [makeTrip('bus', '4001', [{ stop: 'O', arr: 1000 }, { stop: 'D', arr: 1600 }])];
        const transfers = transferMap([walkTransfer('O', 'D', 600)]);
        const interchange = uniformInterchange(['O', 'D']);

        // Penalty 8: the walk still arrives at 1500 but costs 4800.
        const penalized = runScenario({
            trips, transfers, interchange,
            origin: 'O', destination: 'D', departureTime: 900, walkingPenalty: 8,
        });
        expect(sortCriteria(penalized.map(j => j.criteria))).toEqual([
            { arrivalTime: 1500, walkingDistance: 4800, transferCount: 0 },
            { arrivalTime: 1600, walkingDistance: 0, transferCount: 1 },
        ]);

        // Penalty 0: walking is free, so the earlier walk dominates the bus entirely.
        const free = runScenario({
            trips, transfers, interchange,
            origin: 'O', destination: 'D', departureTime: 900, walkingPenalty: 0,
        });
        expect(free.map(j => j.criteria)).toEqual([
            { arrivalTime: 1500, walkingDistance: 0, transferCount: 0 },
        ]);
    });
});

describe('McRaptor core: route structure edge cases', () => {
    it('boards the faster overtaking trip even when a slower one departs first', () => {
        // Same stop sequence, but the express overtakes the local: before the
        // FIFO-split fix the algorithm always boarded the local and reported 2000.
        const trips = [
            makeTrip('local', '4001', [{ stop: 'X', arr: 1000 }, { stop: 'Y', arr: 2000 }]),
            makeTrip('express', '4002', [{ stop: 'X', arr: 1100 }, { stop: 'Y', arr: 1500 }]),
        ];
        const journeys = runScenario({
            trips, transfers: {},
            interchange: uniformInterchange(['X', 'Y']),
            origin: 'X', destination: 'Y', departureTime: 900,
        });
        expect(journeys).toHaveLength(1);
        expect(journeys[0].criteria).toEqual({ arrivalTime: 1500, walkingDistance: 0, transferCount: 1 });
        expect(journeys[0].legs[0].trip?.tripId).toBe('express');
    });

    it('does not lose a Pareto-optimal journey when two trips of a route tie at a stop', () => {
        // run1 trails run0 but ties with it at S3 and falls behind afterwards.
        // With non-strict FIFO chaining, run1's on-board label tie-dominated
        // the walk+board-run0 option inside the shared route bag, losing the
        // journey that arrives 120s earlier. Ties like this are routine in
        // production because countdowns are quantized to whole minutes.
        const trips = [
            makeTrip('run0', '4001', [
                { stop: 'S5', arr: 36300 }, { stop: 'S4', arr: 36360 },
                { stop: 'S6', arr: 36420 }, { stop: 'S3', arr: 36660 }, { stop: 'S0', arr: 36960 },
            ]),
            makeTrip('run1', '4002', [
                { stop: 'S5', arr: 36420 }, { stop: 'S4', arr: 36480 },
                { stop: 'S6', arr: 36540 }, { stop: 'S3', arr: 36660 }, { stop: 'S0', arr: 37080 },
            ]),
        ];
        const journeys = runScenario({
            trips,
            transfers: transferMap([walkTransfer('S6', 'S3', 118)]),
            interchange: uniformInterchange(['S5', 'S4', 'S6', 'S3', 'S0']),
            origin: 'S6', destination: 'S0', departureTime: 36480,
        });
        expect(sortCriteria(journeys.map(j => j.criteria))).toEqual([
            { arrivalTime: 36960, walkingDistance: 118, transferCount: 1 }, // walk to S3, catch run0
            { arrivalTime: 37080, walkingDistance: 0, transferCount: 1 },  // board run1 at S6
        ]);
    });

    it('handles loop routes where a trip serves the same stop twice', () => {
        const trips = [makeTrip('loop', '4001', [
            { stop: 'A', arr: 1000, dep: 1000 },
            { stop: 'B', arr: 1200, dep: 1210 },
            { stop: 'A', arr: 1400, dep: 1410 },
            { stop: 'C', arr: 1600 },
        ])];
        const interchange = uniformInterchange(['A', 'B', 'C']);

        // Board at B, alight at the second visit to A.
        const bToA = runScenario({ trips, transfers: {}, interchange, origin: 'B', destination: 'A', departureTime: 900 });
        expect(bToA).toHaveLength(1);
        expect(bToA[0].criteria).toEqual({ arrivalTime: 1400, walkingDistance: 0, transferCount: 1 });

        // Board at the first visit to A, ride through the loop to C.
        const aToC = runScenario({ trips, transfers: {}, interchange, origin: 'A', destination: 'C', departureTime: 900 });
        expect(aToC).toHaveLength(1);
        expect(aToC[0].criteria).toEqual({ arrivalTime: 1600, walkingDistance: 0, transferCount: 1 });
    });

    it('rides two routes sharing a corridor of stops', () => {
        const trips = [
            ...buildScheduledTrips({
                rt: 'R1', rtdir: 'EAST', stops: ['A', 'B', 'C'],
                travelTimes: [200, 200], firstDeparture: 1000, headway: 600, runs: 1,
            }),
            ...buildScheduledTrips({
                rt: 'R2', rtdir: 'EAST', stops: ['B', 'C', 'D'],
                travelTimes: [200, 200], firstDeparture: 1300, headway: 600, runs: 1,
            }),
        ];
        const journeys = runScenario({
            trips, transfers: {},
            interchange: uniformInterchange(['A', 'B', 'C', 'D']),
            origin: 'A', destination: 'D', departureTime: 900,
        });
        // Transferring at B or at C yields the identical criteria; exactly one survives.
        expect(journeys).toHaveLength(1);
        expect(journeys[0].criteria).toEqual({ arrivalTime: 1700, walkingDistance: 0, transferCount: 2 });
    });

    it('finds journeys needing all 8 rounds but not more (documented round cap)', () => {
        // A chain of 9 single-hop routes: S0 -> S1 -> ... -> S9, one boarding each.
        const stops = Array.from({ length: 10 }, (_, i) => `S${i}`);
        const trips = stops.slice(1).map((stop, i) =>
            makeTrip(`hop${i + 1}`, `40${i}`, [
                { stop: `S${i}`, arr: 1000 + i * 200 },
                { stop, arr: 1000 + i * 200 + 100 },
            ])
        );
        const base = {
            trips, transfers: {}, interchange: uniformInterchange(stops), departureTime: 900,
        };

        const eightRides = runScenario({ ...base, origin: 'S0', destination: 'S8' });
        expect(eightRides).toHaveLength(1);
        expect(eightRides[0].criteria.transferCount).toBe(8);

        // Nine boardings exceed the 8-round cap: the algorithm finds nothing,
        // even though the journey physically exists (the oracle sees it at maxRides=9).
        const algo = new McRaptorAlgorithm(trips, {}, uniformInterchange(stops));
        expect(algo.getOptimizedJourneys('S0', 'S9', 900)).toHaveLength(0);
        expect(bruteForceParetoCriteria({ ...base, origin: 'S0', destination: 'S9', transfers: {} }, 9)).toHaveLength(1);
    });
});

describe('McRaptor range search (getOptimizedJourneysInRange)', () => {
    // Interchange 0 keeps window boundaries exact in these tests.
    const stops = ['X', 'Y'];
    const interchange = uniformInterchange(stops, 0);

    function rangeJourneys(trips: ReturnType<typeof makeTrip>[], transfers = {}, start = 900, range = 1500) {
        const algo = new McRaptorAlgorithm(trips, transfers, interchange);
        return algo.getOptimizedJourneysInRange('X', 'Y', start, range);
    }

    it('returns one journey per departure in the window plus one walking option', () => {
        const trips = buildScheduledTrips({
            rt: 'RR', rtdir: 'EAST', stops: ['X', 'Y'],
            travelTimes: [400], firstDeparture: 1000, headway: 600, runs: 3, // departs 1000, 1600, 2200
        });
        const journeys = rangeJourneys(trips, transferMap([walkTransfer('X', 'Y', 5000)]));

        const busArrivals = journeys.filter(j => j.legs.some(l => l.type === 'Trip')).map(j => j.criteria.arrivalTime).sort((a, b) => a - b);
        expect(busArrivals).toEqual([1400, 2000, 2600]);

        // Every seed produces a walking journey; only the earliest survives.
        const walks = journeys.filter(j => j.legs.every(l => l.type === 'Transfer'));
        expect(walks).toHaveLength(1);
        expect(walks[0].criteria).toEqual({ arrivalTime: 5900, walkingDistance: 5000, transferCount: 0 });
    });

    it('includes a departure exactly at the end of the window and dedupes repeated trips', () => {
        const trips = buildScheduledTrips({
            rt: 'RR', rtdir: 'EAST', stops: ['X', 'Y'],
            travelTimes: [400], firstDeparture: 1200, headway: 600, runs: 4, // departs 1200, 1800, 2400, 3000
        });
        const journeys = rangeJourneys(trips); // window [900, 2400]

        // The 2400 departure is included (inclusive end); the 3000 one is not
        // Pareto-relevant from any seed. Each trip appears exactly once.
        const tripIds = journeys.map(j => j.legs[0].trip?.tripId).sort();
        expect(tripIds).toEqual(['RR_EAST_0', 'RR_EAST_1', 'RR_EAST_2']);
        expect(journeys.map(j => j.criteria.arrivalTime).sort((a, b) => a - b)).toEqual([1600, 2200, 2800]);
    });

    it('keeps Pareto alternates that share the same trips (different alight/walk tradeoffs)', () => {
        // One trip, two ways off it: earlier arrival with more walking vs
        // later arrival with less. Both are non-dominated and must survive
        // the per-signature dedup.
        const trips = [makeTrip('R1', '4001', [
            { stop: 'O', arr: 1000 },
            { stop: 'B', arr: 1100 },
            { stop: 'A', arr: 1200 },
        ])];
        const algo = new McRaptorAlgorithm(
            trips,
            transferMap([walkTransfer('B', 'D', 150), walkTransfer('A', 'D', 60)]),
            uniformInterchange(['O', 'B', 'A', 'D'])
        );
        const journeys = algo.getOptimizedJourneysInRange('O', 'D', 900, 600);
        expect(sortCriteria(journeys.map(j => j.criteria))).toEqual([
            { arrivalTime: 1250, walkingDistance: 150, transferCount: 1 },
            { arrivalTime: 1260, walkingDistance: 60, transferCount: 1 },
        ]);
    });

    it('seeds account for walking and buffer, producing the latest catchable departure', () => {
        // Trip departs N at 2000; reaching N takes a 100s walk plus the 30s
        // buffer, so the latest origin departure that catches it is 1870.
        const trips = [makeTrip('T', '4001', [{ stop: 'N', arr: 2000 }, { stop: 'Z', arr: 2400 }])];
        const algo = new McRaptorAlgorithm(
            trips,
            transferMap([walkTransfer('O', 'N', 100)]),
            uniformInterchange(['O', 'N', 'Z'])
        );
        const journeys = algo.getOptimizedJourneysInRange('O', 'Z', 0, 3600);
        expect(journeys).toHaveLength(1);
        // The latest-departure variant survives dedup (seeds are run latest-first).
        expect(journeys[0].legs[0].startTime).toBe(1870);
        expect(journeys[0].criteria.arrivalTime).toBe(2400);
    });

    it('keeps a slower bus that is the only option in the window tail', () => {
        // FAST's latest-catchable seed (1900) is inside the window; SLOW's
        // (2500) falls past its end. Riders leaving in (1900, 2400] can only
        // catch SLOW, so it must be returned even though FAST dominates every
        // interior seed — the window end is always sampled.
        const trips = [
            makeTrip('FAST', '4001', [{ stop: 'A', arr: 2000 }, { stop: 'D', arr: 2200 }]),
            makeTrip('SLOW', '4002', [{ stop: 'A', arr: 2600 }, { stop: 'D', arr: 3200 }]),
        ];
        const algo = new McRaptorAlgorithm(
            trips,
            transferMap([walkTransfer('O', 'A', 100)]),
            uniformInterchange(['O', 'A', 'D'], 0)
        );
        const journeys = algo.getOptimizedJourneysInRange('O', 'D', 900, 1500);
        const tripsUsed = journeys.map(j => j.legs.find(l => l.type === 'Trip')?.trip?.tripId).sort();
        expect(tripsUsed).toEqual(['FAST', 'SLOW']);
    });

    it('does not misclassify journeys on tripId-less trips as walking journeys', () => {
        // Real feed rows can lack tatripid, leaving Trip.tripId undefined.
        const anonTrip = { ...makeTrip('x', '4001', [{ stop: 'X', arr: 1000 }, { stop: 'Y', arr: 1400 }]), tripId: undefined as any };
        const algo = new McRaptorAlgorithm(
            [anonTrip],
            transferMap([walkTransfer('X', 'Y', 5000)]),
            uniformInterchange(['X', 'Y'], 0)
        );
        const journeys = algo.getOptimizedJourneysInRange('X', 'Y', 900, 1500);
        // Both the bus journey AND the walking option must survive; previously
        // the bus journey's empty signature landed it in the walking bucket
        // where only the earliest of the two was kept.
        const busArrivals = journeys.filter(j => j.legs.some(l => l.type === 'Trip')).map(j => j.criteria.arrivalTime);
        const walkArrivals = journeys.filter(j => j.legs.every(l => l.type === 'Transfer')).map(j => j.criteria.arrivalTime);
        expect(busArrivals).toEqual([1400]);
        expect(walkArrivals).toEqual([5900]);
    });

    it('still returns a bus that departs after the window when nothing departs inside it', () => {
        // Characterization: the window bounds the *seed* departure times, not the
        // first boarding. From the start-of-window seed the search runs
        // unbounded into the future, so a later bus is still reported.
        const trips = [makeTrip('late', '4001', [{ stop: 'X', arr: 5000 }, { stop: 'Y', arr: 5400 }])];
        const journeys = rangeJourneys(trips);
        expect(journeys).toHaveLength(1);
        expect(journeys[0].criteria).toEqual({ arrivalTime: 5400, walkingDistance: 0, transferCount: 1 });
    });
});
