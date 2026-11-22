import { Trip, TransfersByOrigin, Interchange } from "../raptor/types";

/** Current positions of all buses. */
export const curBusPositions = { buses: [] as any[] };
/** Current positions of all ride buses. */
export const curRidePositions = { buses: [] as any[] };

/** A single historical GPS sample for a bus. */
export type BusPositionSample = {
    lat: number,
    lon: number,
    /** Epoch milliseconds (poll time). */
    timestamp: number,
    /** Heading in degrees from the vehicle's hdg field, if available. */
    heading?: number
};

/** Maximum age of bus position history samples, in milliseconds. */
export const BUS_HISTORY_MAX_AGE_MS = 60_000;

/** Recent position samples per vehicle ID (ring buffer, last ~60s). */
export const busPositionHistory: Record<string, BusPositionSample[]> = {};

/** Appends current bus positions to the per-vid history and prunes old samples. */
export function recordBusPositionHistory(buses: any[], now: number = Date.now()) {
    const seen = new Set<string>();
    for (const bus of buses) {
        const vid = bus.vid || bus.id;
        const lat = parseFloat(bus.lat);
        const lon = parseFloat(bus.lon);
        if (!vid || isNaN(lat) || isNaN(lon)) continue;
        seen.add(vid);

        const sample: BusPositionSample = { lat, lon, timestamp: now };
        const hdg = parseFloat(bus.hdg);
        if (!isNaN(hdg)) sample.heading = hdg;

        if (!busPositionHistory[vid]) busPositionHistory[vid] = [];
        busPositionHistory[vid].push(sample);
        busPositionHistory[vid] = busPositionHistory[vid].filter(
            s => now - s.timestamp <= BUS_HISTORY_MAX_AGE_MS
        );
    }
    // Drop history for vehicles no longer reporting
    for (const vid of Object.keys(busPositionHistory)) {
        if (!seen.has(vid)) {
            const samples = busPositionHistory[vid];
            if (!samples.length || now - samples[samples.length - 1].timestamp > BUS_HISTORY_MAX_AGE_MS) {
                delete busPositionHistory[vid];
            }
        }
    }
}
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

/** Predictions indexed by vehicle ID. */
export const cachedPredsByVid: Record<string, Prediction[]> = {};
/** Predictions indexed by ride vehicle ID. */
export const cachedRidePredsByVid: Record<string, Prediction[]> = {};
/** Predictions indexed by stop ID. */
export const cachedPredsByStopId: Record<string, Prediction[]> = {};
/** Predictions indexed by ride stop ID. */
export const cachedRidePredsByStopId: Record<string, Prediction[]> = {};

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
/** Set of currently valid ride route IDs. */
export const validRideRoutes = new Set<string>();

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