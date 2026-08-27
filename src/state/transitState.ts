import { Trip, TransfersByOrigin, Interchange } from "../raptor/types";

/** Current positions of all buses. */
export const curBusPositions = { buses: [] as any[] };
/** Current positions of all ride buses. */
export const curRidePositions = { buses: [] as any[] };
/** Cache of route patterns and static data. */
export const cachedRoutes: Record<string, any> = {};
/** Cache of route patterns and static data for the ride. */
export const cachedRideRoutes: Record<string, any> = {};

/** Represents a bus prediction. */
export type Prediction = {
    /** route id */
    rt: string,
    /** vehicle id */
    vid: string,
    /** stop id */
    stpid: string,
    /** timestamp of predicted arrival time, epoch milliseconds */
    prdtm: number,
    /** minutes until arrival, or 'DUE' (corresponding to 1 minute) */
    prdctdn: string
} & Record<string, any>;

// The prediction caches are looked up with USER-CONTROLLED keys from route
// params, so they must be prototype-less: with a plain {} a request for
// "constructor" or "__proto__" would return inherited Object members and
// break the response shape.
/** Predictions indexed by vehicle ID. */
export const cachedPredsByVid: Record<string, Prediction[]> = Object.create(null);
/** Predictions indexed by ride vehicle ID. */
export const cachedRidePredsByVid: Record<string, Prediction[]> = Object.create(null);
/** Predictions indexed by stop ID. */
export const cachedPredsByStopId: Record<string, Prediction[]> = Object.create(null);
/** Predictions indexed by ride stop ID. */
export const cachedRidePredsByStopId: Record<string, Prediction[]> = Object.create(null);

/** Map of stop IDs to their human-readable names. */
export const stopIdToName: Record<string, string> = {};
/** Map of ride stop IDs to their human-readable names. */
export const rideStopIdToName: Record<string, string> = {};
/** Map of trip IDs to route names. */
export const tatripidToRt: Record<string, string> = {};

/** The current transit graph used for routing. */
export let cachedGraph: {
    trips: Trip[];
    transfers: TransfersByOrigin;
    interchange: Interchange;
} = { trips: [], transfers: {}, interchange: {} };

/** Cache of stop locations (lat/lon). */
export let cachedStopLocations: Record<string, { name: string, lat: number, lon: number }> = {};
export let cachedRideStopLocations: Record<string, { name: string, lat: number, lon: number }> = {};

/** Cache of timing differences between stops for extrapolation.
 *
 *  The pre-seeded entries below encode route INTERLINING (a CN bus becomes a
 *  CS bus at the loop end, and vice versa) with hardcoded stop IDs. They are
 *  configuration, not derivable state: revisit whenever the university
 *  renumbers these stops or changes the CN/CS pairing. Live learning MERGES
 *  into this map (it must never replace whole entries), and extrapolation
 *  prefers the first (i.e. seeded) successor for a given stop. */
export const routeTimingCache: Record<string, Record<string, Record<string, { diff: number, rtdir: string, rtNext: string }>>> = {
    "CN": {
        "N434NORTHBOUND": {
            "N500": { "diff": 5, "rtdir": "SOUTHBOUND", "rtNext": "CS" }
        },
    },
    "CS": {
        "S002SOUTHBOUND": {
            "S001": { "diff": 5, "rtdir": "NORTHBOUND", "rtNext": "CN" }
        }
    }
};

/** Set of currently valid route IDs. */
export const validRoutes = new Set<string>();
/** Set of currently valid ride route IDs. */
export const validRideRoutes = new Set<string>();

/**
 * Epoch milliseconds of the UTC midnight that the cached graph's
 * seconds-since-midnight stop times are relative to. Request handlers must
 * compute "now" against this base so a graph built just before 00:00 UTC is
 * not queried with a wrapped-around clock.
 */
export let cachedGraphTimeBase = 0;

/** Updates the graph time base (set when trips are converted). */
export function setCachedGraphTimeBase(baseMs: number) {
    cachedGraphTimeBase = baseMs;
}

/** Updates the cached graph. */
export function setCachedGraph(newGraph: typeof cachedGraph) {
    cachedGraph = newGraph;
}
/** Updates the cached stop locations. */
export function setCachedStopLocations(newLocs: typeof cachedStopLocations) {
    cachedStopLocations = newLocs;
}
/** Updates the cached ride stop locations. */
export function setCachedRideStopLocations(newLocs: typeof cachedRideStopLocations) {
    cachedRideStopLocations = newLocs;
}