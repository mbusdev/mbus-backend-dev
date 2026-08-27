import { Trip, StopTime, Transfer, TransfersByOrigin, Interchange, StopID } from '../../src/raptor/types';

/**
 * Compact spec for a single stop event when hand-building trips in tests.
 */
export interface StopTimeSpec {
    stop: StopID;
    /** Arrival time in seconds since midnight. */
    arr: number;
    /** Departure time; defaults to the arrival time. */
    dep?: number;
    pickUp?: boolean;
    dropOff?: boolean;
    rt?: string;
}

/** Builds a Trip from compact stop time specs. */
export function makeTrip(tripId: string, vid: string | null, specs: StopTimeSpec[]): Trip {
    const stopTimes: StopTime[] = specs.map(s => ({
        stop: s.stop,
        arrivalTime: s.arr,
        departureTime: s.dep ?? s.arr,
        pickUp: s.pickUp ?? true,
        dropOff: s.dropOff ?? true,
        rt: s.rt
    }));
    return { tripId, vid, stopTimes };
}

/** Builds a walking transfer. Window defaults to "always usable" like the production graph. */
export function walkTransfer(
    origin: StopID,
    destination: StopID,
    duration: number,
    startTime: number = 0,
    endTime: number = Number.MAX_SAFE_INTEGER
): Transfer {
    return { origin, destination, duration, startTime, endTime };
}

/** Indexes a flat list of transfers by origin stop, as the algorithm expects. */
export function transferMap(transfers: Transfer[]): TransfersByOrigin {
    const map: TransfersByOrigin = {};
    for (const t of transfers) {
        if (!map[t.origin]) map[t.origin] = [];
        map[t.origin].push(t);
    }
    return map;
}

/** Uniform minimum-transfer-time map, mirroring the production 30s default. */
export function uniformInterchange(stops: StopID[], buffer: number = 30): Interchange {
    const interchange: Interchange = {};
    for (const s of stops) interchange[s] = buffer;
    return interchange;
}

/**
 * A scheduled route: an ordered stop list served by several timed runs,
 * the shape real M-Bus routes (BB, CN, CS, ...) take after ingestion.
 */
export interface ScheduledRoute {
    rt: string;
    rtdir: string;
    stops: StopID[];
    /** Seconds of travel between consecutive stops (length = stops.length - 1). */
    travelTimes: number[];
    /** Departure time of the first run from stops[0], seconds since midnight. */
    firstDeparture: number;
    /** Seconds between consecutive runs. */
    headway: number;
    runs: number;
    /** Seconds a bus waits at each intermediate stop. Default 0. */
    dwell?: number;
}

/** Expands a scheduled route into one Trip per run. */
export function buildScheduledTrips(route: ScheduledRoute): Trip[] {
    const trips: Trip[] = [];
    const dwell = route.dwell ?? 0;

    for (let run = 0; run < route.runs; run++) {
        const specs: StopTimeSpec[] = [];
        let arr = route.firstDeparture + run * route.headway;

        route.stops.forEach((stop, i) => {
            const isLast = i === route.stops.length - 1;
            const dep = isLast ? arr : arr + dwell;
            specs.push({ stop, arr, dep, rt: route.rt });
            if (!isLast) arr = dep + route.travelTimes[i];
        });

        trips.push(makeTrip(`${route.rt}_${route.rtdir}_${run}`, `${4000 + run}`, specs));
    }
    return trips;
}
