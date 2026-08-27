import { Trip, Transfer, StopID, Time, Interchange, StopTime } from "./types";
import { Bag, Label } from "./McStructs";

/**
 * Represents a complete transit journey consisting of multiple legs.
 */
export interface Journey {
    /** The sequence of legs (trips or walking transfers) in the journey. */
    legs: JourneyLeg[];
    /** The performance metrics for this journey. */
    criteria: {
        arrivalTime: number;
        walkingDistance: number;
        transferCount: number;
    }
}

/**
 * Represents a single segment of a journey, either a transit trip or a walking transfer.
 */
export interface JourneyLeg {
    type: 'Trip' | 'Transfer';
    origin: StopID;
    destination: StopID;
    startTime: number;
    endTime: number;
    trip?: Trip;
    transfer?: Transfer;
    duration: number;
    originID: StopID;
    destinationID: StopID;
    rt?: string;
    stopTimes?: StopTime[];
}

/**
 * Implementation of the McRAPTOR (Multi-Criteria Round-Based Public Transit Routing) algorithm.
 * Optimizes for arrival time, walking distance, and number of transfers.
 */
export class McRaptorAlgorithm {
    private trips: Trip[];
    private transfers: Record<StopID, Transfer[]>;
    private interchange: Interchange;
    private stops: StopID[];
    private routes: Record<string, Trip[]>;
    private routeStops: Record<string, StopID[]>;
    private stopToRoutes: Record<StopID, string[]>;

    private walkingPenalty: number = 1;

    /**
     * Route index (FIFO chains + inverted stop index) per trips array.
     * planJourney passes the same cached trips array for every request between
     * graph rebuilds, so the index is built once per rebuild instead of once
     * per request. Keyed by array identity: callers must not mutate a trips
     * array after first constructing an algorithm with it.
     */
    private static indexCache = new WeakMap<Trip[], {
        routes: Record<string, Trip[]>,
        routeStops: Record<string, StopID[]>,
        stopToRoutes: Record<StopID, string[]>,
    }>();

    /**
     * Initializes the routing engine with transit data.
     * @param trips - List of all transit trips.
     * @param transfers - Graph of walking connections between stops.
     * @param interchange - Minimum transfer times for each stop.
     */
    constructor(
        trips: Trip[],
        transfers: Record<StopID, Transfer[]>,
        interchange: Interchange
    ) {
        this.trips = trips;
        this.transfers = transfers;
        this.interchange = interchange;
        this.stops = Object.keys(interchange);

        const cached = McRaptorAlgorithm.indexCache.get(trips);
        if (cached) {
            this.routes = cached.routes;
            this.routeStops = cached.routeStops;
            this.stopToRoutes = cached.stopToRoutes;
            return;
        }

        this.routes = {};
        this.routeStops = {};
        this.stopToRoutes = {};

        const tripsBySeq: Record<string, Trip[]> = {};
        for (const trip of trips) {
            const stopSeq = trip.stopTimes.map(st => st.stop).join(',');
            if (!tripsBySeq[stopSeq]) tripsBySeq[stopSeq] = [];
            tripsBySeq[stopSeq].push(trip);
        }

        // RAPTOR requires that within a route, trips never overtake each other
        // (otherwise the earliest catchable trip is not always the best one).
        // Split each stop sequence into FIFO-ordered chains of trips.
        for (const stopSeq in tripsBySeq) {
            const sorted = tripsBySeq[stopSeq].sort((a, b) => a.stopTimes[0].departureTime - b.stopTimes[0].departureTime);

            const chains: Trip[][] = [];
            for (const trip of sorted) {
                const chain = chains.find(c => McRaptorAlgorithm.followsFifo(c[c.length - 1], trip));
                if (chain) chain.push(trip);
                else chains.push([trip]);
            }

            chains.forEach((chain, i) => {
                const routeId = `${stopSeq}#${i}`;
                this.routes[routeId] = chain;
                this.routeStops[routeId] = chain[0].stopTimes.map(st => st.stop);
            });
        }

        // Inverted index so route scans are O(markedStops) instead of scanning
        // every route's stop list per marked stop per round.
        for (const [routeId, stops] of Object.entries(this.routeStops)) {
            for (const stop of new Set(stops)) {
                if (!this.stopToRoutes[stop]) this.stopToRoutes[stop] = [];
                this.stopToRoutes[stop].push(routeId);
            }
        }

        McRaptorAlgorithm.indexCache.set(trips, {
            routes: this.routes,
            routeStops: this.routeStops,
            stopToRoutes: this.stopToRoutes,
        });
    }

    /**
     * Returns true if `later` departs and arrives STRICTLY later than `earlier`
     * at every stop and offers the same pickUp/dropOff availability. Only then
     * is boarding the earliest catchable trip of a chain always optimal.
     *
     * Strictness matters: if two trips tie at one stop but diverge afterwards,
     * on-board labels of the slower trip can tie-dominate boardings of the
     * faster one inside the shared route bag and lose Pareto-optimal journeys
     * (ties are common in production because countdowns are quantized to whole
     * minutes). Tied trips are simply scanned as separate chains.
     */
    private static followsFifo(earlier: Trip, later: Trip): boolean {
        for (let i = 0; i < earlier.stopTimes.length; i++) {
            const a = earlier.stopTimes[i];
            const b = later.stopTimes[i];
            if (b.departureTime <= a.departureTime) return false;
            if (b.arrivalTime <= a.arrivalTime) return false;
            if ((a.pickUp ?? true) !== (b.pickUp ?? true)) return false;
            if ((a.dropOff ?? true) !== (b.dropOff ?? true)) return false;
        }
        return true;
    }

    /**
     * Sets the penalty multiplier for walking (default is 1).
     * @param penalty - The multiplier for walking duration cost.
     */
    public setWalkingPenalty(penalty: number) {
        this.walkingPenalty = penalty;
    }

    /**
     * Executes the McRAPTOR algorithm to find all non-dominated paths to the destination.
     * @param origin - The starting Stop ID.
     * @param destination - The destination Stop ID.
     * @param departureTime - The time of departure.
     * @returns A Bag containing Pareto-optimal labels for the destination.
     */
    public run(origin: StopID, destination: StopID, departureTime: Time): Bag {
        const rounds = 8;
        const bags: Record<StopID, Bag>[] = [];

        bags[0] = {};
        for (const stop of this.stops) bags[0][stop] = new Bag();
        if (!bags[0][destination]) bags[0][destination] = new Bag();

        if (!bags[0][origin]) bags[0][origin] = new Bag();

        const startLabel = new Label(departureTime, 0, 0, null, null, null, origin, departureTime, -1);
        bags[0][origin].add(startLabel);


        let markedStops = new Set<StopID>();
        markedStops.add(origin);

        const initialFootPathMarked = new Set<StopID>();
        {
            const stop = origin;
            const stopBag = bags[0][stop];
            if (stopBag && !stopBag.isEmpty()) {
                const transfers = this.transfers[stop] || [];
                for (const transfer of transfers) {
                    const dest = transfer.destination;
                    const walkTime = transfer.duration;
                    const walkCost = walkTime * this.walkingPenalty;

                    if (!bags[0][dest]) bags[0][dest] = new Bag();

                    for (const label of stopBag.labels) {
                        if (label.arrivalTime < transfer.startTime || label.arrivalTime > transfer.endTime) continue;
                        const arrTime = label.arrivalTime + walkTime;
                        const totalWalk = label.walkingDistance + walkCost;

                        const newLabel = new Label(
                            arrTime,
                            totalWalk,
                            label.transferCount,
                            label,
                            null,
                            transfer,
                            dest,
                            arrTime,
                            -1
                        );

                        if (bags[0][dest].add(newLabel)) {
                            initialFootPathMarked.add(dest);
                        }
                    }
                }
            }
        }

        for (const s of initialFootPathMarked) markedStops.add(s);

        for (let k = 1; k <= rounds; k++) {
            bags[k] = {};

            const routesToVisit = new Set<string>();
            for (const stop of markedStops) {
                for (const routeId of this.stopToRoutes[stop] ?? []) {
                    routesToVisit.add(routeId);
                }
            }

            const newMarkedStops = new Set<StopID>();

            if (!bags[k][destination]) bags[k][destination] = new Bag();

            for (const routeId of routesToVisit) {
                const stops = this.routeStops[routeId];
                const trips = this.routes[routeId];

                let routeBag: Bag = new Bag();

                for (let i = 0; i < stops.length; i++) {
                    const stop = stops[i];
                    if (!bags[k][stop]) bags[k][stop] = new Bag();

                    // Advance on-board labels to this stop so dominance compares
                    // positions along the route rather than boarding times; a trip
                    // boarded later upstream may still be ahead here.
                    if (i > 0 && !routeBag.isEmpty()) {
                        const advanced = new Bag();
                        for (const label of routeBag.labels) {
                            if (!label.trip) continue;
                            const moved = label.clone();
                            moved.arrivalTime = label.trip.stopTimes[i].departureTime;
                            advanced.add(moved);
                        }
                        routeBag = advanced;
                    }

                    for (const label of routeBag.labels) {
                        if (!label.trip) continue;
                        const stopTime = label.trip.stopTimes[i];
                        if (stopTime.dropOff === false) continue;
                        const arrivalTime = stopTime.arrivalTime;
                        const newLabel = new Label(
                            arrivalTime,
                            label.walkingDistance,
                            label.transferCount,
                            label,
                            label.trip,
                            null,
                            stop,
                            arrivalTime,
                            i
                        );

                        if (bags[k][stop].add(newLabel)) {
                            newMarkedStops.add(stop);
                        }
                    }

                    const prevBag = bags[k - 1][stop];
                    if (prevBag) {
                        for (const label of prevBag.labels) {
                            const buffer = this.interchange[stop] || 0;
                            const catchTrip = this.findEarliestTrip(trips, i, label.arrivalTime + buffer);

                            if (catchTrip) {
                                const departureTime = catchTrip.stopTimes[i].departureTime;
                                const onBoardLabel = new Label(
                                    departureTime,
                                    label.walkingDistance,
                                    label.transferCount + 1,
                                    label,
                                    catchTrip,
                                    null,
                                    stop,
                                    departureTime,
                                    i
                                );
                                routeBag.add(onBoardLabel);
                            }
                        }
                    }
                }
            }

            const footPathMarked = new Set<StopID>();

            // Snapshot the trip-arrival labels before relaxing footpaths so a
            // walk label added at one stop is not walked onward from another
            // stop in the same pass (walks must not chain).
            const footPathSources = new Map<StopID, Label[]>();
            for (const stop of newMarkedStops) {
                const stopBag = bags[k][stop];
                if (!stopBag || stopBag.isEmpty()) continue;
                footPathSources.set(stop, [...stopBag.labels]);
            }

            for (const [stop, sourceLabels] of footPathSources) {
                const transfers = this.transfers[stop] || [];

                for (const transfer of transfers) {
                    const dest = transfer.destination;
                    const walkTime = transfer.duration;
                    const walkCost = walkTime * this.walkingPenalty;

                    if (!bags[k][dest]) bags[k][dest] = new Bag();

                    for (const label of sourceLabels) {
                        if (label.arrivalTime < transfer.startTime || label.arrivalTime > transfer.endTime) continue;
                        const arrTime = label.arrivalTime + walkTime;
                        const totalWalk = label.walkingDistance + walkCost;

                        const newLabel = new Label(
                            arrTime,
                            totalWalk,
                            label.transferCount,
                            label,
                            null,
                            transfer,
                            dest,
                            arrTime,
                            -1
                        );

                        if (bags[k][dest].add(newLabel)) {
                            footPathMarked.add(dest);
                        }
                    }
                }
            }

            for (const s of footPathMarked) newMarkedStops.add(s);
            markedStops = newMarkedStops;
            if (markedStops.size === 0) break;
        }

        const resultBag = new Bag();
        for (let k = 0; k <= rounds; k++) {
            if (bags[k] && bags[k][destination]) {
                resultBag.merge(bags[k][destination]);
            }
        }

        return resultBag;
    }

    private findEarliestTrip(trips: Trip[], stopIndex: number, minTime: number): Trip | null {
        for (const trip of trips) {
            const stopTime = trip.stopTimes[stopIndex];
            if (stopTime.pickUp === false) continue;
            if (stopTime.departureTime >= minTime) {
                return trip;
            }
        }
        return null;
    }

    /**
     * Calculates optimal journeys for a specific departure time.
     * @param origin - The starting Stop ID.
     * @param destination - The destination Stop ID.
     * @param departureTime - The exact departure time.
     * @returns A list of optimal Journey objects.
     */
    public getOptimizedJourneys(origin: StopID, destination: StopID, departureTime: Time): Journey[] {
        const resultBag = this.run(origin, destination, departureTime);

        const journeys: Journey[] = [];

        for (const label of resultBag.labels) {
            const path = this.traceBack(label);
            journeys.push({
                legs: path,
                criteria: {
                    arrivalTime: label.arrivalTime,
                    walkingDistance: label.walkingDistance,
                    transferCount: label.transferCount
                }
            });
        }
        return journeys;
    }

    /**
     * Finds the best journeys within a time window, filtering for Pareto optimality across all departures.
     * @param origin - The starting Stop ID.
     * @param destination - The destination Stop ID.
     * @param startTime - The start of the departure window.
     * @param range - The duration of the window to search (e.g. 3600s).
     * @returns A deduplicated list of the best journeys found in the time range.
     */
    public getOptimizedJourneysInRange(origin: StopID, destination: StopID, startTime: Time, range: number): Journey[] {
        const allJourneys: Journey[] = [];
        const endTime = startTime + range;

        const significantTimes = new Set<number>();
        significantTimes.add(startTime);
        // Always sample the window end too: a bus whose latest-catchable seed
        // falls just past endTime can be the ONLY option for riders departing
        // in the window's tail, and no interior seed would surface it once an
        // earlier faster bus dominates those runs.
        significantTimes.add(endTime);

        // A seed is the LATEST origin departure that can still catch a trip:
        // the trip's departure minus the walk to the stop and that stop's
        // interchange buffer. Seeding raw departure times would start runs
        // that arrive after their own trip has left.
        const reachable: { stop: StopID, cost: number }[] = [
            { stop: origin, cost: this.interchange[origin] || 0 },
            ...(this.transfers[origin] || []).map(t => ({
                stop: t.destination,
                cost: t.duration + (this.interchange[t.destination] || 0),
            })),
        ];

        for (const { stop, cost } of reachable) {
            for (const routeId of this.stopToRoutes[stop] ?? []) {
                for (const trip of this.routes[routeId]) {
                    for (const stopTime of trip.stopTimes) {
                        if (stopTime.stop !== stop) continue;
                        const seed = stopTime.departureTime - cost;
                        if (seed >= startTime && seed <= endTime) significantTimes.add(seed);
                    }
                }
            }
        }

        // Latest-first, so when two seeds yield the same journey criteria the
        // latest-departure variant is the one that survives dedup.
        const sortedTimes = Array.from(significantTimes).sort((a, b) => b - a);

        for (const depTime of sortedTimes) {
            const journeys = this.getOptimizedJourneys(origin, destination, depTime);
            for (const j of journeys) {
                if (j.legs.length === 0) continue;
                allJourneys.push(j);
            }
        }

        // Identity-based trip keys: tripId can legitimately be undefined
        // (vid-only feed rows), and joining undefined yields '' which would
        // misclassify bus journeys as walking-only.
        let anonCounter = 0;
        const tripKeys = new Map<Trip, string>();
        const keyOf = (trip: Trip): string => {
            let key = tripKeys.get(trip);
            if (key === undefined) {
                key = trip.tripId ?? trip.vid ?? `anon_${anonCounter++}`;
                tripKeys.set(trip, key);
            }
            return key;
        };

        const dominatesOrEqual = (a: Journey, b: Journey) =>
            a.criteria.arrivalTime <= b.criteria.arrivalTime &&
            a.criteria.walkingDistance <= b.criteria.walkingDistance &&
            a.criteria.transferCount <= b.criteria.transferCount;

        // Keep the full Pareto set per trip signature: journeys on the same
        // trips can still trade arrival time against walking distance.
        const journeysBySignature = new Map<string, Journey[]>();
        const walkingJourneys: Journey[] = [];

        for (const j of allJourneys) {
            const busLegs = j.legs.filter(l => l.type === 'Trip' && l.trip);
            if (busLegs.length === 0) {
                walkingJourneys.push(j);
                continue;
            }
            const signature = busLegs.map(l => keyOf(l.trip!)).join('|');

            const group = journeysBySignature.get(signature) ?? [];
            if (group.some(existing => dominatesOrEqual(existing, j))) continue;
            journeysBySignature.set(signature, [...group.filter(existing => !dominatesOrEqual(j, existing)), j]);
        }

        const uniqueJourneys: Journey[] = Array.from(journeysBySignature.values()).flat();

        if (walkingJourneys.length > 0) {
            walkingJourneys.sort((a, b) => a.criteria.arrivalTime - b.criteria.arrivalTime);
            uniqueJourneys.push(walkingJourneys[0]);
        }

        return uniqueJourneys;
    }

    private traceBack(finalLabel: Label): JourneyLeg[] {
        const path: JourneyLeg[] = [];
        let current: Label | null = finalLabel;

        while (current && current.parent) {
            const parent: Label = current.parent;

            let leg: JourneyLeg;

            if (current.trip) {
                if (current.transferCount > parent.transferCount) {
                    current = parent;
                    continue;
                }

                const trip = current.trip;
                const boardStop = parent.stop!;
                const alightStop = current.stop!;
                

                if (!parent.trip) {
                    current = parent;
                    continue;
                }
                const boardIndex = parent.stopIndex;
                const alightIndex = current.stopIndex;

                const boardTime = trip.stopTimes[boardIndex]?.departureTime || 0;
                const alightTime = trip.stopTimes[alightIndex]?.arrivalTime || 0;

                leg = {
                    type: 'Trip',
                    origin: boardStop,
                    destination: alightStop,
                    startTime: boardTime,
                    endTime: alightTime,
                    trip: trip,
                    duration: alightTime - boardTime,
                    originID: boardStop,
                    destinationID: alightStop,
                    rt: trip.stopTimes[boardIndex]?.rt,
                    stopTimes: trip.stopTimes
                };
            } else if (current.transfer) {
                leg = {
                    type: 'Transfer',
                    origin: parent.stop!,
                    destination: current.stop!,
                    startTime: parent.arrivalTime,
                    endTime: current.arrivalTime,
                    transfer: current.transfer,
                    duration: current.transfer.duration,
                    originID: parent.stop!,
                    destinationID: current.stop!
                };
            } else {
                break;
            }

            path.unshift(leg);
            current = parent;
        }

        return path;
    }
}