import { Trip, TransfersByOrigin, Interchange } from "../raptor/types";

/** Current positions of all buses. */
export const curBusPositions = { buses: [] as any[] };
/** Cache of route patterns and static data. */
export const cachedRoutes: Record<string, any> = {};

/** Represents a bus prediction. */
export type Prediction = { vid: string; stpid: string } & Record<string, any>;
/** Predictions indexed by vehicle ID. */
export const cachedPredsByVid: Record<string, Prediction[]> = {};
/** Predictions indexed by stop ID. */
export const cachedPredsByStopId: Record<string, Prediction[]> = {};

/** Map of stop IDs to their human-readable names. */
export const stopIdToName: Record<string, string> = {};
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

/** Cache of timing differences between stops for extrapolation. */
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

/** Updates the cached graph. */
export function setCachedGraph(newGraph: typeof cachedGraph) {
    cachedGraph = newGraph;
}
/** Updates the cached stop locations. */
export function setCachedStopLocations(newLocs: typeof cachedStopLocations) {
    cachedStopLocations = newLocs;
}