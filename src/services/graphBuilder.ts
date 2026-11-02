import * as state from '../state/transitState';
import * as mbus from './mbus';
import * as rideBus from './ride';
import * as walking from '../walking/walkingMap';
import { Trip, StopTime } from "../raptor/types";
import * as process from "node:process";
import { MaxPriorityQueue } from '@datastructures-js/priority-queue';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_ROUTES = ["BB", "CN", "CS", "CSX", "DD", "MX", "NE", "NW", "NX", "OS", "NES", "WS", "WX"];
const DEFAULT_RIDE_ROUTES = ["3", "4", "5", "6", "22", "23", "25", "26", "27", "28", "29", "30", "31", "32", "33", "34", "42", "43", "44", "45", "46", "47", "61", "62", "63", "64", "65", "66", "67", "68", "104"];

/** Fetches and updates current bus positions in state. */
export async function updateBusPositions() {
    const buses = await mbus.fetchVehicles(DEFAULT_ROUTES);
    state.curBusPositions.buses = buses;
    const ridesBusses = await rideBus.fetchVehicles(DEFAULT_RIDE_ROUTES);
    state.curRidePositions.buses = ridesBusses;
}

/** Initializes route data, caching patterns and stop locations. */
export async function initializeRoutes() {
    if (process.env.DEV_CACHE === 'true') return;

    try {
        const routesData = await mbus.fetchRoutes();
        state.validRoutes.clear();
        const rideRoutesData = await rideBus.fetchRoutes();
        state.validRideRoutes.clear();

        await Promise.all(routesData.map(async (r: any) => {
            state.validRoutes.add(r.rt);
            const patterns = await mbus.fetchPatterns(r.rt);
            if (patterns) state.cachedRoutes[r.rt] = patterns;
        }));

        await Promise.all(rideRoutesData.map(async (r: any) => {
            state.validRideRoutes.add(r.rt);
            const patterns = await rideBus.fetchPatterns(r.rt);
            if (patterns) state.cachedRideRoutes[r.rt] = patterns;
        }));

        buildStopLocationMap();
        buildRideStops();
        await buildWalkingTransfers();

    } catch (e) {
        console.error("Init Routes Failed", e);
    }
}

/** Rebuilds the routing graph based on current predictions and static data. */
export async function rebuildGraph() {
    if (process.env.DEV_CACHE === 'true' && state.cachedGraph.trips.length > 0) return;

    try {
        console.log(`Rebuilding graph...`);
        const allStopIds = new Set<string>();
        Object.values(state.cachedRoutes).forEach((patterns) => {
            patterns.forEach((p) => p.pt.forEach((pt) => {
                if (pt.stpid) allStopIds.add(pt.stpid);
            }));
        });

        const rawPreds = await mbus.fetchPredictions(Array.from(allStopIds), DEFAULT_ROUTES);
        const formattedPreds = processPredictions(rawPreds);

        // Populate the lookup maps needed for Journey formatting
        populateLookupMaps(formattedPreds);

        updatePredictionLookups(formattedPreds);
        const trips = convertToTrips(formattedPreds);
        
        // extra stuff to update the busses for the ride
        const rideStopIds = new Set<string>();
        Object.values(state.cachedRideRoutes).forEach((patterns) => {
            patterns.forEach((p) => p.pt.forEach((pt) => {
                if (pt.stpid) rideStopIds.add(pt.stpid);
            }));
        });
        const rawRidePreds = await rideBus.fetchPredictions(Array.from(rideStopIds), DEFAULT_RIDE_ROUTES);
        const formattedRidePreds = processRidePredictions(rawRidePreds);
        populateRideLookupMaps(formattedRidePreds);
        updateRideLookups(formattedRidePreds);
        
        state.setCachedGraph({
            trips,
            transfers: state.cachedGraph.transfers,
            interchange: state.cachedGraph.interchange
        });

    } catch (error) {
        console.error('Error rebuilding graph:', error);
    }
}

/**
 * Populates lookup maps for stop names and trip-to-route mappings.
 * @param preds List of processed predictions
 */
function populateLookupMaps(preds: any[]) {
    Object.values(state.cachedRoutes).forEach((patterns) => {
        patterns.forEach((p) => p.pt.forEach((pt) => {
            if (pt.stpid && pt.stpnm) {
                state.stopIdToName[pt.stpid] = pt.stpnm;
            }
        }));
    });
    preds.forEach((trip: any) => {
        trip.stops.forEach((stop: any) => {
            if (stop.stpid && stop.stpnm) {
                state.stopIdToName[stop.stpid] = stop.stpnm;
            }
        });
    });

    preds.forEach((trip: any) => {
        if (trip.tatripid && trip.stops.length > 0) {
            const firstStopWithRt = trip.stops.find((s: any) => s.rt);
            if (firstStopWithRt) {
                state.tatripidToRt[trip.tatripid] = firstStopWithRt.rt;
            }
        }
    });
}

/**
 * Populates the lookup map for ride stop names
 * @param preds List of processed predictions from the ride
 */
function populateRideLookupMaps(preds: any[]) {
    Object.values(state.cachedRideRoutes).forEach((patterns) => {
        patterns.forEach((p) => p.pt.forEach((pt) => {
            if (pt.stpid && pt.stpnm) {
                state.rideStopIdToName[pt.stpid] = pt.stpnm;
            }
        }));
    });
    preds.forEach((trip: any) => {
        trip.stops.forEach((stop: any) => {
            if (stop.stpid && stop.stpnm) {
                state.rideStopIdToName[stop.stpid] = stop.stpnm;
            }
        });
    });
}

/**
 * Builds a map of stop locations from cached route patterns.
 * Also initializes the walking graph node map.
 */
function buildStopLocationMap() {
    const locs: Record<string, any> = {};
    Object.values(state.cachedRoutes).forEach((patterns) => {
        patterns.forEach((p) => p.pt.forEach((pt) => {
            if (pt.stpid && pt.lat) {
                locs[pt.stpid] = { name: pt.stpnm, lat: pt.lat, lon: pt.lon };
            }
        }));
    });
    state.setCachedStopLocations(locs);
    walking.buildStopNodeMap(locs);
}

/**
 * Builds a map of ride stop locations from cached route patterns.
 */
function buildRideStops() {
    const locs: Record<string, any> = {};
    Object.values(state.cachedRideRoutes).forEach((patterns) => {
        patterns.forEach((p) => p.pt.forEach((pt) => {
            if (pt.stpid && pt.lat) {
                locs[pt.stpid] = { name: pt.stpnm, lat: pt.lat, lon: pt.lon };
            }
        }));
    });
    state.setCachedRideStopLocations(locs);
}

/**
 * Generates walking transfers between all stops.
 * Uses the walking service to calculate durations.
 */
async function buildWalkingTransfers() {
    const stops = Object.keys(state.cachedStopLocations);
    stops.forEach(s => {
        state.cachedGraph.transfers[s] = [];
        state.cachedGraph.interchange[s] = 30;
    });

    await walking.ensureCacheForStops(new Set(stops), state.cachedStopLocations);

    stops.forEach(origin => {
        stops.forEach(dest => {
            if (origin === dest) return;
            const walk = walking.getCachedWalk(origin, dest);
            if (walk) {
                state.cachedGraph.transfers[origin].push({
                    origin, destination: dest, duration: walk.duration,
                    startTime: 0, endTime: Number.MAX_SAFE_INTEGER
                });
            }
        });
    });
}

/**
 * Processes raw prediction chunks into a structured format.
 * Handles flattening, sorting, and extrapolating predictions.
 * @param rawChunks Raw API response chunks
 */
function processPredictions(rawChunks: any[]) {
    const formattedPredictions = rawChunks.flat().reduce((acc: any[], chunk: any) => {
        if (chunk['bustime-response']?.['prd']) {
            chunk['bustime-response']['prd'].forEach((prd: any) => {
                let trip = acc.find((t: any) => t.tatripid === prd.tatripid);
                // If no tatripid, try to match by vid (mbus API specifics)
                if (!trip && prd.vid) trip = acc.find((t: any) => t.vid === prd.vid);
                // If no match, create new trip
                if (!trip) {
                    trip = { tatripid: prd.tatripid, vid: prd.vid, des: prd.des, stops: [] };
                    acc.push(trip);
                } else {
                    if (!trip.tatripid) trip.tatripid = prd.tatripid;
                    if (!trip.vid && prd.vid) trip.vid = prd.vid;
                }
                // If no stop, create new stop
                let stop = trip.stops.find((s: any) => s.stpid === prd.stpid);
                if (!stop) {
                    stop = { stpnm: prd.stpnm, stpid: prd.stpid, prdctdn: null, rt: null, rtdir: null };
                    trip.stops.push(stop);
                }
                stop.rtdir = prd.rtdir;
                stop.rt = prd.rt;
                stop.prdctdn = prd.prdctdn === "DUE" ? "1" : prd.prdctdn;
                stop.prdtm = parseInt(prd.prdtm);
            });
        }
        return acc;
    }, []);

    // build index maps
    const routeInfoFilter: Record<string, { stpid: string; rtdir: string }[]> = {};
    for (const [routeName, routeList] of Object.entries(state.cachedRoutes)) {
        for (const route of routeList) {
            const rtdir = route.rtdir;
            const routeKey = routeName + rtdir;
            if (!routeInfoFilter[routeKey]) routeInfoFilter[routeKey] = [];
            for (const point of route.pt) {
                if (point.typ !== "W" && point.stpid) {
                    routeInfoFilter[routeKey].push({ stpid: point.stpid, rtdir });
                }
            }
        }
    }

    const routeStopIndexMaps = new Map<string, Map<string, number>>();
    for (const [routeId, stopOrder] of Object.entries(routeInfoFilter)) {
        const stopIndexMap = new Map(stopOrder.map(({ stpid }, i) => [stpid, i]));
        routeStopIndexMaps.set(routeId, stopIndexMap);
    }

    // sort predictions based on route (oddly complicated)
    formattedPredictions.forEach((trip: any) => {
        if (trip.stops.length == 0) return;
        const minPrdctdn = Math.min(...trip.stops.map((s: any) => parseInt(s.prdctdn, 10)));
        const firstRoute = trip.stops.find((s: any) => parseInt(s.prdctdn, 10) === minPrdctdn)?.rt;

        if (!firstRoute) return;

        trip.stops.sort((a: any, b: any) => {
            const diffTime = parseInt(a.prdctdn, 10) - parseInt(b.prdctdn, 10);
            if (diffTime !== 0) return diffTime;
            if (a.rt + a.rtdir !== b.rt + b.rtdir) {
                if (a.rt === firstRoute) return -1;
                if (b.rt === firstRoute) return 1;
                return a.rt.localeCompare(b.rt);
            }
            const aMap = routeStopIndexMaps.get(a.rt + a.rtdir);
            const bMap = routeStopIndexMaps.get(b.rt + b.rtdir);
            const aIdx = aMap?.get(a.stpid) ?? Number.MAX_SAFE_INTEGER;
            const bIdx = bMap?.get(b.stpid) ?? Number.MAX_SAFE_INTEGER;
            return aIdx - bIdx;
        });

        // update timing cache using new predictions
        for (let i = 0; i < trip.stops.length - 1; i++) {
            const from = trip.stops[i];
            const to = trip.stops[i + 1];
            const diff = parseInt(to.prdctdn, 10) - parseInt(from.prdctdn, 10);
            const rt = from.rt;

            const stopIndexMap = routeStopIndexMaps.get(from.rt + from.rtdir);
            if (!stopIndexMap) continue;

            const fromIdx = stopIndexMap.get(from.stpid);
            const toIdx = stopIndexMap.get(to.stpid);
            const isValidFollowUp = (
                fromIdx !== undefined && toIdx !== undefined &&
                (toIdx === fromIdx + 1 || fromIdx === stopIndexMap.size - 1)
            );
            if (!isValidFollowUp) continue;

            if (!state.routeTimingCache[rt]) state.routeTimingCache[rt] = {};
            const fromKey = from.stpid + (from.rtdir || "");
            if (!state.routeTimingCache[rt][fromKey]) state.routeTimingCache[rt][fromKey] = {};
            state.routeTimingCache[rt][fromKey] = {
                [to.stpid]: {
                    diff: diff,
                    rtdir: to.rtdir,
                    rtNext: to.rt
                }
            };
        }
    });


    // extrapolate predictions
    formattedPredictions.forEach((trip: any) => {
        let stopsAdded = 0;
        while (stopsAdded < 20 && trip.stops.length > 0) {
            const lastStop = trip.stops[trip.stops.length - 1];
            const rt = lastStop.rt;
            if (!rt) break;

            const fromKey = lastStop.stpid + (lastStop.rtdir || "");
            const nextStops = state.routeTimingCache[rt]?.[fromKey];
            if (!nextStops) break;

            const nextEntries = Object.entries(nextStops);
            if (nextEntries.length === 0) break;

            const [nextStopId, { diff, rtdir, rtNext }] = nextEntries[0];
            const nextPrdctdn = (parseInt(lastStop.prdctdn, 10) + diff).toString();

            trip.stops.push({
                stpnm: state.cachedStopLocations[nextStopId]?.name || nextStopId,
                stpid: nextStopId,
                prdctdn: nextPrdctdn,
                rt: rtNext,
                rtdir: rtdir,
                isExtrapolated: true
            });
            stopsAdded++;
        }
    });

    return formattedPredictions;
}


/**
 * COPIED FROM PROCESS PREDICTIONS AND MODIFIED TO WORK WITH THE RIDE
 * @param rawChunks Raw API response chunks
 */
function processRidePredictions(rawChunks: any[]) {
    const formattedPredictions = rawChunks.flat().reduce((acc: any[], chunk: any) => {
        if (chunk['bustime-response']?.['prd']) {
            chunk['bustime-response']['prd'].forEach((prd: any) => {
                let trip = acc.find((t: any) => t.tatripid === prd.tatripid);
                // If no tatripid, try to match by vid (mbus API specifics)
                if (!trip && prd.vid) trip = acc.find((t: any) => t.vid === prd.vid);
                // If no match, create new trip
                if (!trip) {
                    trip = { tatripid: prd.tatripid, vid: prd.vid, des: prd.des, stops: [] };
                    acc.push(trip);
                } else {
                    if (!trip.tatripid) trip.tatripid = prd.tatripid;
                    if (!trip.vid && prd.vid) trip.vid = prd.vid;
                }
                // If no stop, create new stop
                let stop = trip.stops.find((s: any) => s.stpid === prd.stpid);
                if (!stop) {
                    stop = { stpnm: prd.stpnm, stpid: prd.stpid, prdctdn: null, rt: null, rtdir: null };
                    trip.stops.push(stop);
                }
                stop.rtdir = prd.rtdir;
                stop.rt = prd.rt;
                stop.prdctdn = prd.prdctdn === "DUE" ? "1" : prd.prdctdn;
                // console.log(prd.prdtm);
                // prdtm is in format YYYYMMDD HH:MM:SS
                // stop.prdtm = parseInt(prd.prdtm);
                // TODO: use actual timestamp
                stop.prdtm = Date.now() + (parseInt(stop.prdctdn) + 0.5) * 60 * 1000;
            });
        }
        return acc;
    }, []);

    return formattedPredictions;
}

/**
 * Updates global prediction lookup caches (by VID and Stop ID).
 * @param preds List of processed predictions
 */
function updatePredictionLookups(preds: any[]) {
    for (const key in state.cachedPredsByVid) delete state.cachedPredsByVid[key];
    for (const key in state.cachedPredsByStopId) delete state.cachedPredsByStopId[key];

    preds.forEach((trip: any) => {
        trip.stops.forEach((stop: any) => {
            if (stop.isExtrapolated) return; 

            const predObj = { ...stop, vid: trip.vid, tatripid: trip.tatripid, des: trip.des };

            if (!state.cachedPredsByStopId[stop.stpid]) state.cachedPredsByStopId[stop.stpid] = [];
            state.cachedPredsByStopId[stop.stpid].push(predObj);

            if (trip.vid) {
                if (!state.cachedPredsByVid[trip.vid]) state.cachedPredsByVid[trip.vid] = [];
                state.cachedPredsByVid[trip.vid].push(predObj);
            }
        });
    });
    // sort
    sortPreds(state.cachedPredsByStopId);
    sortPreds(state.cachedPredsByVid);
}


/**
 * COPIED FROM updatePredictionLookups AND MODIFIED TO WORK WITH THE RIDE
 * Updates global prediction lookup caches (by VID and Stop ID).
 * @param preds List of processed predictions
 */
function updateRideLookups(preds: any[]) {
    for (const key in state.cachedRidePredsByVid) delete state.cachedRidePredsByVid[key];
    for (const key in state.cachedRidePredsByStopId) delete state.cachedRidePredsByStopId[key];

    preds.forEach((trip: any) => {
        trip.stops.forEach((stop: any) => {
            const predObj = { ...stop, vid: trip.vid, tatripid: trip.tatripid, des: trip.des };

            if (!state.cachedRidePredsByStopId[stop.stpid]) state.cachedRidePredsByStopId[stop.stpid] = [];
            state.cachedRidePredsByStopId[stop.stpid].push(predObj);

            if (trip.vid) {
                if (!state.cachedRidePredsByVid[trip.vid]) state.cachedRidePredsByVid[trip.vid] = [];
                state.cachedRidePredsByVid[trip.vid].push(predObj);
            }
        });
    });
    // sort
    sortPreds(state.cachedRidePredsByStopId);
    sortPreds(state.cachedRidePredsByVid);
}

/** Sorts every prediction list contained in `x` by arrival timestamp */
export function sortPreds(x: Record<string, state.Prediction[]>) {
    for (const k in x) {
        x[k].sort((lhs, rhs) => lhs.prdtm - rhs.prdtm);
    }
}

/**
 * Converts processed predictions into the Trip format used by the Raptor algorithm.
 * @param preds List of processed predictions
 */
function convertToTrips(preds: any[]): Trip[] {
    const trips: Trip[] = [];
    const now = new Date();
    const currentTime = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();

    preds.forEach((p: any) => {
        const stopTimes: StopTime[] = p.stops.map((s: any) => ({
            stop: s.stpid,
            arrivalTime: currentTime + (parseInt(s.prdctdn) * 60),
            departureTime: currentTime + (parseInt(s.prdctdn) * 60),
            pickUp: true,
            dropOff: true,
            rt: s.rt
        })).sort((a: StopTime, b: StopTime) => a.arrivalTime - b.arrivalTime);

        trips.push({
            tripId: p.tatripid,
            vid: p.vid,
            stopTimes
        });
    });

    trips.push({
        tripId: 'VIRTUAL_ORIGIN_TRIP', vid: null,
        stopTimes: [{ stop: 'VIRTUAL_ORIGIN', arrivalTime: 0, departureTime: 0, pickUp: true, dropOff: true }]
    });
    trips.push({
        tripId: 'VIRTUAL_DESTINATION_TRIP', vid: null,
        stopTimes: [{ stop: 'VIRTUAL_DESTINATION', arrivalTime: 0, departureTime: 0, pickUp: true, dropOff: true }]
    });

    return trips;
}

/** Finds the nearest k stops to a given coordinate. */
export function findNearestStops(lat: number, lon: number, k: number = 2) {
    if (isNaN(lat) || isNaN(lon)) throw new Error("Invalid Coordinates");

    const heap = new MaxPriorityQueue<{ stpid: string; name: string; lat: number; lon: number; distance: number }>({
        compare: (a, b) => a.distance - b.distance
    });

    for (const [stpid, stop] of Object.entries(state.cachedStopLocations)) {
        const latDiff = (stop.lat - lat) * 111320;
        const lonDiff = (stop.lon - lon) * 111320 * Math.cos(lat * Math.PI / 180);
        const distance = Math.sqrt(latDiff ** 2 + lonDiff ** 2);

        const stopWithDist = {
            stpid,
            name: stop.name,
            lat: stop.lat,
            lon: stop.lon,
            distance
        };

        if (heap.size() < k) {
            heap.enqueue(stopWithDist);
        } else if (distance < heap.front()!.distance) {
            heap.dequeue();
            heap.enqueue(stopWithDist);
        }
    }

    return heap.toArray()
        .sort((a, b) => a.distance - b.distance);
}

/** Saves the current graph and state to a JSON file (DEV mode only). */
export function saveGraphState() {
    const filePath = path.resolve(process.cwd(), 'saved_graph.json');
    const fullState = {
        graph: state.cachedGraph,
        stopLocations: state.cachedStopLocations,
        stopNames: state.stopIdToName,
        predsByVid: state.cachedPredsByVid,
        predsByStopId: state.cachedPredsByStopId
    };
    const data = JSON.stringify(fullState, null, 2);
    fs.writeFileSync(filePath, data);
    return filePath;
}