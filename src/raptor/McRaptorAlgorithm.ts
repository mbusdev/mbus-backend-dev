import { Trip, Transfer, StopID, Time, Interchange, StopTime, TransfersByOrigin } from "./types";
import { Bag, Label } from "./McStructs";

export const VIRTUAL_ORIGIN = 'VIRTUAL_ORIGIN';
export const VIRTUAL_DESTINATION = 'VIRTUAL_DESTINATION';

/**
 * Per-query walking overlay — avoids cloning the full transfer graph.
 * Origin walks replace VIRTUAL_ORIGIN transfers; destination walks append to each stop.
 */
export interface McRaptorQueryOverlay {
    originWalks: Transfer[];
    destinationWalks: Map<StopID, Transfer>;
}

/**
 * Represents a complete transit journey consisting of multiple legs.
 */
export interface Journey {
    legs: JourneyLeg[];
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

function buildRouteIndices(trips: Trip[]) {
    const routes: Record<string, Trip[]> = {};
    const routeStops: Record<string, StopID[]> = {};
    const stopToRoutes: Record<StopID, string[]> = {};

    for (const trip of trips) {
        const stopSeq = trip.stopTimes.map(st => st.stop).join(',');
        if (!routes[stopSeq]) {
            routes[stopSeq] = [];
            routeStops[stopSeq] = trip.stopTimes.map(st => st.stop);
        }
        routes[stopSeq].push(trip);
    }

    for (const routeId in routes) {
        routes[routeId].sort((a, b) => a.stopTimes[0].departureTime - b.stopTimes[0].departureTime);
        for (const stop of routeStops[routeId]) {
            if (!stopToRoutes[stop]) stopToRoutes[stop] = [];
            stopToRoutes[stop].push(routeId);
        }
    }

    return { routes, routeStops, stopToRoutes };
}

/** Merge per-query walking overlay into base transfers once (avoids per-round .concat allocations). */
function mergeTransfersWithOverlay(
    baseTransfers: TransfersByOrigin,
    overlay?: McRaptorQueryOverlay
): TransfersByOrigin {
    if (!overlay) return baseTransfers;

    const merged: TransfersByOrigin = { ...baseTransfers };
    merged[VIRTUAL_ORIGIN] = overlay.originWalks;

    for (const [stop, extra] of overlay.destinationWalks) {
        const base = baseTransfers[stop];
        merged[stop] = base ? [...base, extra] : [extra];
    }

    return merged;
}

function resolveTransfers(
    stop: StopID,
    transfers: TransfersByOrigin
): Transfer[] {
    if (stop === VIRTUAL_DESTINATION) return [];
    return transfers[stop] || [];
}

function findEarliestTrip(trips: Trip[], stopIndex: number, minTime: number): Trip | null {
    let lo = 0;
    let hi = trips.length - 1;
    let result: Trip | null = null;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const dep = trips[mid].stopTimes[stopIndex].departureTime;
        if (dep >= minTime) {
            result = trips[mid];
            hi = mid - 1;
        } else {
            lo = mid + 1;
        }
    }
    return result;
}

/**
 * Pre-built route indices for McRAPTOR. Rebuilt when the transit graph trips change.
 */
export class McRaptorIndex {
    private readonly trips: Trip[];
    private readonly interchange: Interchange;
    private readonly routes: Record<string, Trip[]>;
    private readonly routeStops: Record<string, StopID[]>;
    private readonly stopToRoutes: Record<StopID, string[]>;

    private constructor(
        trips: Trip[],
        interchange: Interchange,
        routes: Record<string, Trip[]>,
        routeStops: Record<string, StopID[]>,
        stopToRoutes: Record<StopID, string[]>
    ) {
        this.trips = trips;
        this.interchange = interchange;
        this.routes = routes;
        this.routeStops = routeStops;
        this.stopToRoutes = stopToRoutes;
    }

    static build(trips: Trip[], interchange: Interchange): McRaptorIndex {
        const { routes, routeStops, stopToRoutes } = buildRouteIndices(trips);
        return new McRaptorIndex(trips, interchange, routes, routeStops, stopToRoutes);
    }

    run(
        origin: StopID,
        destination: StopID,
        departureTime: Time,
        baseTransfers: TransfersByOrigin,
        overlay?: McRaptorQueryOverlay,
        walkingPenalty = 1
    ): Bag {
        const rounds = 8;
        const bags: Record<StopID, Bag>[] = [];
        const transfers = mergeTransfersWithOverlay(baseTransfers, overlay);
        const getTransfers = (stop: StopID) => resolveTransfers(stop, transfers);

        bags[0] = {};
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
                for (const transfer of getTransfers(stop)) {
                    const dest = transfer.destination;
                    const walkTime = transfer.duration;
                    const walkCost = walkTime * walkingPenalty;

                    if (!bags[0][dest]) bags[0][dest] = new Bag();

                    for (const label of stopBag.labels) {
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
                const routeIds = this.stopToRoutes[stop];
                if (!routeIds) continue;
                for (const routeId of routeIds) {
                    routesToVisit.add(routeId);
                }
            }

            const newMarkedStops = new Set<StopID>();

            for (const routeId of routesToVisit) {
                const stops = this.routeStops[routeId];
                const trips = this.routes[routeId];

                let routeBag: Bag = new Bag();

                for (let i = 0; i < stops.length; i++) {
                    const stop = stops[i];
                    if (!bags[k][stop]) bags[k][stop] = new Bag();

                    for (const label of routeBag.labels) {
                        if (!label.trip) continue;
                        const stopTime = label.trip.stopTimes[i];
                        if (!stopTime.dropOff && stopTime.dropOff !== undefined) continue;
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
                            const catchTrip = findEarliestTrip(trips, i, label.arrivalTime + buffer);

                            if (catchTrip) {
                                if (catchTrip.stopTimes[i].pickUp === false) continue;

                                const tripDepartureTime = catchTrip.stopTimes[i].departureTime;
                                const onBoardLabel = new Label(
                                    tripDepartureTime,
                                    label.walkingDistance,
                                    label.transferCount + 1,
                                    label,
                                    catchTrip,
                                    null,
                                    stop,
                                    tripDepartureTime,
                                    i
                                );
                                routeBag.add(onBoardLabel);
                            }
                        }
                    }
                }
            }

            const footPathMarked = new Set<StopID>();

            for (const stop of newMarkedStops) {
                const stopBag = bags[k][stop];
                if (!stopBag || stopBag.isEmpty()) continue;

                for (const transfer of getTransfers(stop)) {
                    const dest = transfer.destination;
                    const walkTime = transfer.duration;
                    const walkCost = walkTime * walkingPenalty;

                    if (!bags[k][dest]) bags[k][dest] = new Bag();

                    for (const label of stopBag.labels) {
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

    getOptimizedJourneys(
        origin: StopID,
        destination: StopID,
        departureTime: Time,
        baseTransfers: TransfersByOrigin,
        overlay?: McRaptorQueryOverlay,
        walkingPenalty = 1
    ): Journey[] {
        const resultBag = this.run(origin, destination, departureTime, baseTransfers, overlay, walkingPenalty);

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

    getOptimizedJourneysInRange(
        origin: StopID,
        destination: StopID,
        startTime: Time,
        range: number,
        baseTransfers: TransfersByOrigin,
        overlay?: McRaptorQueryOverlay,
        walkingPenalty = 1
    ): Journey[] {
        const allJourneys: Journey[] = [];
        const endTime = startTime + range;

        const significantTimes = new Set<number>();
        significantTimes.add(startTime);

        const mergedTransfers = mergeTransfersWithOverlay(baseTransfers, overlay);
        const startStops = [origin, ...(mergedTransfers[origin] || []).map(t => t.destination)];

        for (const stop of startStops) {
            const routeIds = this.stopToRoutes[stop];
            if (!routeIds) continue;
            for (const routeId of routeIds) {
                const params = this.routes[routeId];
                for (const trip of params) {
                    const stopTime = trip.stopTimes.find(st => st.stop === stop);
                    if (stopTime && stopTime.departureTime >= startTime && stopTime.departureTime <= endTime) {
                        significantTimes.add(stopTime.departureTime);
                    }
                }
            }
        }

        const sortedTimes = Array.from(significantTimes).sort((a, b) => b - a);

        for (const depTime of sortedTimes) {
            const journeys = this.getOptimizedJourneys(
                origin, destination, depTime, baseTransfers, overlay, walkingPenalty
            );
            for (const j of journeys) {
                if (j.legs.length === 0) continue;
                allJourneys.push(j);
            }
        }
        const bestJourneysBySignature = new Map<string, Journey>();
        const walkingJourneys: Journey[] = [];

        for (const j of allJourneys) {
            const tripsSignature = j.legs
                .filter(l => l.type === 'Trip' && l.trip)
                .map(l => l.trip!.tripId)
                .join('|');

            if (!tripsSignature) {
                walkingJourneys.push(j);
                continue;
            }

            if (!bestJourneysBySignature.has(tripsSignature)) {
                bestJourneysBySignature.set(tripsSignature, j);
            } else {
                const existing = bestJourneysBySignature.get(tripsSignature)!;

                let better = false;
                if (j.criteria.arrivalTime < existing.criteria.arrivalTime) better = true;
                else if (j.criteria.arrivalTime === existing.criteria.arrivalTime) {
                    if (j.criteria.walkingDistance < existing.criteria.walkingDistance) better = true;
                    else if (j.criteria.walkingDistance === existing.criteria.walkingDistance) {
                        if (j.criteria.transferCount < existing.criteria.transferCount) better = true;
                    }
                }

                if (better) {
                    bestJourneysBySignature.set(tripsSignature, j);
                }
            }
        }

        const uniqueJourneys: Journey[] = Array.from(bestJourneysBySignature.values());

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

/** Build per-query transfer overlay from walking access results. */
export function buildQueryOverlay(
    walksFromOrigin: { stopId: string; duration: number }[],
    walksToDest: { stopId: string; duration: number }[],
    departureTime: Time
): McRaptorQueryOverlay {
    const originWalks: Transfer[] = walksFromOrigin.map(walk => ({
        origin: VIRTUAL_ORIGIN,
        destination: walk.stopId === 'DIRECT_WALK' ? VIRTUAL_DESTINATION : walk.stopId,
        duration: walk.duration,
        startTime: departureTime,
        endTime: Number.MAX_SAFE_INTEGER,
    }));

    const destinationWalks = new Map<StopID, Transfer>();
    for (const walk of walksToDest) {
        destinationWalks.set(walk.stopId, {
            origin: walk.stopId,
            destination: VIRTUAL_DESTINATION,
            duration: walk.duration,
            startTime: departureTime,
            endTime: Number.MAX_SAFE_INTEGER,
        });
    }

    return { originWalks, destinationWalks };
}
