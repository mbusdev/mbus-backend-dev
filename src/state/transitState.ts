import { Trip, TransfersByOrigin, Interchange } from "../raptor/types";
import {produce, freeze, enableMapSet, type Draft} from "immer";
enableMapSet();

/** Current positions of all buses. */
export let curBusPositions = freeze ({ buses: [] as any[]}, true);
/** Current positions of all ride buses. */
export let curRidePositions = freeze ({ buses: [] as any[]}, true);
/** Updates the current bus positions */
export function setCurBusPositions(buses: any[]) {
    curBusPositions = produce(curBusPositions, draft => {
        draft.buses = buses;
    });
}
/** Updates the current ride bus positions */
export function setCurRideBusPositions(buses: any[]) {
    curRidePositions = produce(curRidePositions, draft => {
        draft.buses = buses;
    });
}
/** Cache of route patterns and static data. */
export let cachedRoutes: Record<string, any> = freeze({}, true);
/** Cache of route patterns and static data for the ride. */
export let cachedRideRoutes: Record<string, any> = freeze({}, true);

/** Updates Cache Routes */
export function setCachedRoute(routeId: string, patterns: any) {
    cachedRoutes = produce(cachedRoutes, draft => {
        draft[routeId] = patterns;
    });
}

/** Updates the cached ride routes */
export function setCachedRideRoute(routeId: string, patterns: any) {
    cachedRideRoutes = produce(cachedRideRoutes, draft => {
        draft[routeId] = patterns;
    });
}

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
export let cachedPredsByVid: Record<string, Prediction[]> = freeze({}, true);
/** Predictions indexed by ride vehicle ID. */
export let cachedRidePredsByVid: Record<string, Prediction[]> = freeze({}, true);
/** Predictions indexed by stop ID. */
export let cachedPredsByStopId: Record<string, Prediction[]> = freeze({}, true);
/** Predictions indexed by ride stop ID. */
export let cachedRidePredsByStopId: Record<string, Prediction[]> = freeze({}, true);

export function setPredictionLookups(
    byVid: Record<string, Prediction[]>,
    byStopId: Record<string, Prediction[]>
) {
    cachedPredsByVid = produce(cachedPredsByVid, () => byVid);
    cachedPredsByStopId = produce(cachedPredsByStopId, () => byStopId);
}

export function setRidePredictionLookups(
    byVid: Record<string, Prediction[]>,
    byStopId: Record<string, Prediction[]>
) {
    cachedRidePredsByVid = produce(
        cachedRidePredsByVid,
        () => byVid
    );
    cachedRidePredsByStopId = produce(
        cachedRidePredsByStopId,
        () => byStopId
    );
}

export let stopIdToName: Record<string, string> = freeze({}, true);
export let rideStopIdToName: Record<string, string> = freeze({}, true);
export let tatripidToRt: Record<string, string> = freeze({}, true);

export function updateLookupMaps(
    stopNames: Record<string, string>,
    tripRoutes: Record<string, string>
) {
    stopIdToName = produce(stopIdToName, draft => {
        Object.assign(draft, stopNames);
    });

    tatripidToRt = produce(tatripidToRt, draft => {
        Object.assign(draft, tripRoutes);
    });
}

export function updateRideLookupMap(
    stopNames: Record<string, string>
) {
    rideStopIdToName = produce(rideStopIdToName, draft => {
        Object.assign(draft, stopNames);
    });
}

/** The current transit graph used for routing. */
export type TransitGraph ={
    trips: Trip[];
    transfers: TransfersByOrigin;
    interchange: Interchange;
}

export let cachedGraph: TransitGraph = freeze ({
    trips: [],
    transfers: {},
    interchange: {},
}, true);


/** Cache of stop locations (lat/lon). */
export let cachedStopLocations: Record<string, { name: string, lat: number, lon: number }> = freeze({}, true);
export let cachedRideStopLocations: Record<string, { name: string, lat: number, lon: number }> = freeze({}, true);


/** Cache of timing differences between stops for extrapolation. */
export let routeTimingCache: Record<string, Record<string, Record<string, { diff: number, rtdir: string, rtNext: string }>>> = freeze({
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
}, true);

export function setRouteTiming (
     rt: string,
    fromKey: string,
    toStopId: string,
    diff: number,
    rtdir: string,
    rtNext: string
) {
    routeTimingCache = produce(routeTimingCache, draft => {
        if(!draft[rt]) draft[rt] = {};

        draft[rt][fromKey] = {
            [toStopId]: {
                diff,
                rtdir,
                rtNext
            }
        };
    });
}

/** Set of currently valid route IDs. */
export let validRoutes = freeze(new Set<string>(), true);
/** Set of currently valid ride route IDs. */
export let validRideRoutes = freeze(new Set<string>(), true);
/** Replace the valid route ID */
export function setValidRoutes(routes: string[]) {
    validRoutes = produce(validRoutes, draft =>{
        draft.clear();
        routes.forEach(route => draft.add(route));
    });
}

export function setValidRideRoutes(routes: string[]) {
    validRideRoutes = produce(validRideRoutes, draft =>{
        draft.clear();
        routes.forEach(route => draft.add(route));
    });
}
/** Updates the cached graph. */
export function setCachedGraph(newGraph: TransitGraph) {
    cachedGraph = produce(cachedGraph, draft => {
        draft.trips = newGraph.trips;
        draft.transfers = newGraph.transfers;
        draft.interchange = newGraph.interchange;
    });
}

export function updateCacheGraph(
    update: (draft: Draft<TransitGraph>) => void
) {
    cachedGraph = produce(cachedGraph, update);
}

/** Updates the cached stop locations with a frozen copy. */
export function setCachedStopLocations(newLocs: typeof cachedStopLocations) {
    cachedStopLocations = freeze(structuredClone(newLocs), true);
}

/** Updates the cached Ride stop locations with a frozen copy. */
export function setCachedRideStopLocations(newLocs: typeof cachedRideStopLocations) {
    cachedRideStopLocations = freeze(structuredClone(newLocs), true);
}
