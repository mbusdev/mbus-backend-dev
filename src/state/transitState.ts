import { Key } from "@/types";
import { Trip, TransfersByOrigin, Interchange } from "../raptor/types";
import * as bustime from '@/services/bustimeCommon';

/** Current positions of all buses. */
export const curBusPositions = { buses: [] as any[] };
/** Current positions of all ride buses. */
export const curRidePositions = { buses: [] as any[] };
/** Cache of route patterns and static data. */
export const cachedRoutes: Record<string, bustime.BusRouteLine[]> = {};
/** Cache of route patterns and static data for the ride. */
export const cachedRideRoutes: Record<string, bustime.BusRouteLine[]> = {};

/** Poly lines to use when constructing the path taken by a bus leg */
export const cachedStopToStopPaths: Map<Key<{ rt: string, from: string, to: string }>, bustime.LatLon[]> = new Map();

// Remove when support for mb2 is dropped
export const cachedRoutesLegacy: Record<string, bustime.Pattern[]> = {};
export const cachedRideRoutesLegacy: Record<string, bustime.Pattern[]> = {};

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
} & Record<string, unknown>;

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
export const routeTimingCache: Record<string, Record<string, Record<string,
    { diff: number, rtdir: string, rtNext: string }>>> = {
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