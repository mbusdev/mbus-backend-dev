import { Trip, Transfer, StopID, Time, Interchange, StopTime } from "./types";
import { Bag, Label } from "./McStructs";

export interface Journey {
    legs: JourneyLeg[];
    criteria: {
        arrivalTime: number;
        walkingDistance: number;
        transferCount: number;
    }
}

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

export class McRaptorAlgorithm {
    private trips: Trip[];
    private transfers: Record<StopID, Transfer[]>;
    private interchange: Interchange;
    private stops: StopID[];
    private routes: Record<string, Trip[]>;
    private routeStops: Record<string, StopID[]>;

    private walkingPenalty: number = 1;

    constructor(
        trips: Trip[],
        transfers: Record<StopID, Transfer[]>,
        interchange: Interchange
    ) {
        this.trips = trips;
        this.transfers = transfers;
        this.interchange = interchange;
        this.stops = Object.keys(interchange);

        this.routes = {};
        this.routeStops = {};

        for (const trip of trips) {
            const stopSeq = trip.stopTimes.map(st => st.stop).join(',');
            if (!this.routes[stopSeq]) {
                this.routes[stopSeq] = [];
                this.routeStops[stopSeq] = trip.stopTimes.map(st => st.stop);
            }
            this.routes[stopSeq].push(trip);
        }

        for (const routeId in this.routes) {
            this.routes[routeId].sort((a, b) => a.stopTimes[0].departureTime - b.stopTimes[0].departureTime);
        }

    }

    public setWalkingPenalty(penalty: number) {
        this.walkingPenalty = penalty;
    }

    public run(origin: StopID, destination: StopID, departureTime: Time): Bag {
        const rounds = 8;
        const bags: Record<StopID, Bag>[] = [];

        bags[0] = {};
        for (const stop of this.stops) bags[0][stop] = new Bag();
        if (!bags[0][destination]) bags[0][destination] = new Bag();

        if (!bags[0][origin]) bags[0][origin] = new Bag();

        const startLabel = new Label(departureTime, 0, 0, null, null, null, origin, departureTime);
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
                            arrTime
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
                for (const [routeId, stops] of Object.entries(this.routeStops)) {
                    if (stops.includes(stop)) {
                        routesToVisit.add(routeId);
                    }
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

                    for (const label of routeBag.labels) {
                        if (!label.trip) continue;
                        const stopTime = label.trip.stopTimes[i];
                        if (!stopTime.dropOff && stopTime.dropOff !== undefined) continue;
                        const arrivalTime = stopTime.arrivalTime;
                        const newLabel = new Label(
                            arrivalTime,
                            label.walkingDistance,
                            label.transferCount,
                            label.parent,
                            label.trip,
                            null,
                            stop,
                            arrivalTime
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
                                if (catchTrip.stopTimes[i].pickUp === false) continue;

                                const departureTime = catchTrip.stopTimes[i].departureTime;
                                const onBoardLabel = new Label(
                                    departureTime,
                                    label.walkingDistance,
                                    label.transferCount + 1,
                                    label,
                                    catchTrip,
                                    null,
                                    stop,
                                    departureTime
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

                const transfers = this.transfers[stop] || [];

                for (const transfer of transfers) {
                    const dest = transfer.destination;
                    const walkTime = transfer.duration;
                    const walkCost = walkTime * this.walkingPenalty;

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
                            arrTime
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
            if (trip.stopTimes[stopIndex].departureTime >= minTime) {
                return trip;
            }
        }
        return null;
    }

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

    private traceBack(finalLabel: Label): JourneyLeg[] {
        const path: JourneyLeg[] = [];
        let current: Label | null = finalLabel;

        while (current && current.parent) {
            const parent: Label = current.parent;

            let leg: JourneyLeg;

            if (current.trip) {
                const trip = current.trip;
                const boardStop = parent.stop!;
                const alightStop = current.stop!;


                const boardTime = trip.stopTimes.find(st => st.stop === boardStop)?.departureTime || 0;
                const alightTime = trip.stopTimes.find(st => st.stop === alightStop)?.arrivalTime || 0;

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
                    rt: trip.stopTimes.find(st => st.stop === boardStop)?.rt,
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
