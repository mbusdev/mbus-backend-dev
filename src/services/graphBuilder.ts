import * as state from '../state/transitState';
import * as mbus from './mbus';
import * as rideBus from './ride';
import * as walking from '../walking/walkingMap';
import { haversine } from '../walking/loadMap';
import { Trip, StopTime } from "../raptor/types";
import * as process from "node:process";
import { MaxPriorityQueue } from '@datastructures-js/priority-queue';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_ROUTES = ["BB", "CN", "CS", "CSX", "DD", "MX", "NE", "NW", "NX", "OS", "NES", "WS", "WX"];
const DEFAULT_RIDE_ROUTES = ["3", "4", "5", "6", "22", "23", "25", "26", "27", "28", "29", "30", "31", "32", "33", "34", "42", "43", "44", "45", "46", "47", "61", "62", "63", "64", "65", "66", "67", "68", "104"];

/** Routes to poll: the live feed's route set once known (so reminders accepted
 *  for any valid route are actually tracked), falling back to the static
 *  defaults before the first successful getroutes fetch. */
function activeRoutes(): string[] {
    return state.validRoutes.size > 0 ? Array.from(state.validRoutes) : DEFAULT_ROUTES;
}
function activeRideRoutes(): string[] {
    return state.validRideRoutes.size > 0 ? Array.from(state.validRideRoutes) : DEFAULT_RIDE_ROUTES;
}

/** Fetches and updates current bus positions in state.
 *  Keeps the previous positions when a fetch fails (null), so a transient
 *  API error does not blank the live map. */
export async function updateBusPositions() {
    const [buses, ridesBusses] = await Promise.all([
        mbus.fetchVehicles(activeRoutes()),
        rideBus.fetchVehicles(activeRideRoutes()),
    ]);
    if (buses !== null) state.curBusPositions.buses = buses;
    if (ridesBusses !== null) state.curRidePositions.buses = ridesBusses;
}

/** Initializes route data, caching patterns and stop locations.
 *  All network fetches happen first; shared state is only swapped in
 *  synchronously afterwards, so concurrent requests never observe cleared
 *  route sets, and transient failures keep the previous data. */
export async function initializeRoutes() {
    if (process.env.DEV_CACHE === 'true') return;

    try {
        const routesData = await mbus.fetchRoutes();
        const rideRoutesData = await rideBus.fetchRoutes();

        const umPatterns = await Promise.all(routesData.map(async (r: any) => ({
            rt: r.rt, patterns: await mbus.fetchPatterns(r.rt)
        })));
        const ridePatterns = await Promise.all(rideRoutesData.map(async (r: any) => ({
            rt: r.rt, patterns: await rideBus.fetchPatterns(r.rt)
        })));

        if (routesData.length > 0) {
            state.validRoutes.clear();
            for (const r of routesData) state.validRoutes.add(r.rt);
            // Evict routes the feed no longer reports so their stops stop
            // appearing in nearest-stop results and the transfer matrix.
            for (const rt of Object.keys(state.cachedRoutes)) {
                if (!state.validRoutes.has(rt)) delete state.cachedRoutes[rt];
            }
            for (const { rt, patterns } of umPatterns) {
                // An empty result is what a failed fetch looks like; keep the
                // previously cached patterns rather than wiping the route.
                if (patterns && patterns.length > 0) state.cachedRoutes[rt] = patterns;
            }
        }

        if (rideRoutesData.length > 0) {
            state.validRideRoutes.clear();
            for (const r of rideRoutesData) state.validRideRoutes.add(r.rt);
            for (const rt of Object.keys(state.cachedRideRoutes)) {
                if (!state.validRideRoutes.has(rt)) delete state.cachedRideRoutes[rt];
            }
            for (const { rt, patterns } of ridePatterns) {
                if (patterns && patterns.length > 0) state.cachedRideRoutes[rt] = patterns;
            }
        }

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
        Object.values(state.cachedRoutes).forEach((patterns: any) => {
            patterns?.forEach((p: any) => p.pt?.forEach((pt: any) => {
                if (pt.stpid) allStopIds.add(pt.stpid);
            }));
        });

        const rawPreds = await mbus.fetchPredictions(Array.from(allStopIds), activeRoutes());
        if (rawPreds.some((chunk: any) => chunk === null)) {
            // A failed chunk would make vehicles look vanished, mass-firing
            // "disappeared" reminders and blanking routing data. Keep the
            // previous graph and predictions until the next successful cycle.
            console.warn('Prediction fetch partially failed; keeping previous graph and predictions');
        } else {
            const formattedPreds = processPredictions(rawPreds);

            // Populate the lookup maps needed for Journey formatting
            populateLookupMaps(formattedPreds);

            updatePredictionLookups(formattedPreds);
            const trips = convertToTrips(formattedPreds);

            state.setCachedGraph({
                trips,
                transfers: state.cachedGraph.transfers,
                interchange: state.cachedGraph.interchange
            });
        }

        // extra stuff to update the busses for the ride
        const rideStopIds = new Set<string>();
        Object.values(state.cachedRideRoutes).forEach((patterns: any) => {
            patterns?.forEach((p: any) => p.pt?.forEach((pt: any) => {
                if (pt.stpid) rideStopIds.add(pt.stpid);
            }));
        });
        const rawRidePreds = await rideBus.fetchPredictions(Array.from(rideStopIds), activeRideRoutes());
        if (rawRidePreds.some((chunk: any) => chunk === null)) {
            console.warn('Ride prediction fetch partially failed; keeping previous ride predictions');
        } else {
            const formattedRidePreds = processRidePredictions(rawRidePreds);
            populateRideLookupMaps(formattedRidePreds);
            updateRideLookups(formattedRidePreds);
        }

    } catch (error) {
        console.error('Error rebuilding graph:', error);
    }
}

/**
 * Populates lookup maps for stop names and trip-to-route mappings.
 * @param preds List of processed predictions
 */
function populateLookupMaps(preds: any[]) {
    Object.values(state.cachedRoutes).forEach((patterns: any) => {
        patterns?.forEach((p: any) => p.pt?.forEach((pt: any) => {
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
    Object.values(state.cachedRideRoutes).forEach((patterns: any) => {
        patterns?.forEach((p: any) => p.pt?.forEach((pt: any) => {
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
    Object.values(state.cachedRoutes).forEach((patterns: any) => {
        patterns?.forEach((p: any) => p.pt?.forEach((pt: any) => {
            if (pt.stpid && pt.lat) {
                const lat = parseFloat(pt.lat);
                const lon = parseFloat(pt.lon);
                // A garbled coordinate poisons every distance computed from it.
                if (Number.isFinite(lat) && Number.isFinite(lon)) {
                    locs[pt.stpid] = { name: pt.stpnm, lat, lon };
                }
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
    Object.values(state.cachedRideRoutes).forEach((patterns: any) => {
        patterns?.forEach((p: any) => p.pt?.forEach((pt: any) => {
            if (pt.stpid && pt.lat) {
                const lat = parseFloat(pt.lat);
                const lon = parseFloat(pt.lon);
                if (Number.isFinite(lat) && Number.isFinite(lon)) {
                    locs[pt.stpid] = { name: pt.stpnm, lat, lon };
                }
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

    // ensureCacheForStops yields to the event loop while computing, so the
    // shared graph must NOT be cleared before it: build into local structures
    // and swap them in synchronously afterwards, or concurrent /plan-journey
    // requests would observe an empty transfer table mid-rebuild.
    await walking.ensureCacheForStops(new Set(stops), state.cachedStopLocations);

    const transfers: typeof state.cachedGraph.transfers = {};
    const interchange: typeof state.cachedGraph.interchange = {};
    stops.forEach(s => {
        transfers[s] = [];
        interchange[s] = 30;
    });

    stops.forEach(origin => {
        stops.forEach(dest => {
            if (origin === dest) return;
            const walk = walking.getCachedWalk(origin, dest);
            if (walk) {
                transfers[origin].push({
                    origin, destination: dest, duration: walk.duration,
                    startTime: 0, endTime: Number.MAX_SAFE_INTEGER
                });
            }
        });
    });

    state.setCachedGraph({
        trips: state.cachedGraph.trips,
        transfers,
        interchange
    });
}

/**
 * Processes raw prediction chunks into a structured format.
 * Handles flattening, sorting, and extrapolating predictions.
 * @param rawChunks Raw API response chunks
 */
/**
 * Shared grouping step for both feeds: folds raw prediction chunks into
 * per-vehicle trips with one stop event per (stop, pass). The feeds differ
 * only in how a usable prdtm timestamp is derived, so that is a parameter —
 * keeping the tatripid/vid matching and loop-pass logic in exactly one place.
 */
function groupPredictions(rawChunks: any[], prdtmOf: (prd: any, prdctdn: string) => number): any[] {
    return rawChunks.flat().reduce((acc: any[], chunk: any) => {
        if (chunk?.['bustime-response']?.['prd']) {
            chunk['bustime-response']['prd'].forEach((prd: any) => {
                // Only match by tatripid when one is present: matching
                // undefined === undefined would merge every tatripid-less
                // prediction from DIFFERENT vehicles into one trip.
                let trip = prd.tatripid ? acc.find((t: any) => t.tatripid === prd.tatripid) : undefined;
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
                // A looping bus predicts the same stop more than once (e.g. in
                // 1 min and again in 11 min). Only merge entries for the same
                // pass (same stop AND same countdown); different passes must be
                // kept as separate stop events.
                const prdctdn = prd.prdctdn === "DUE" ? "1" : prd.prdctdn;
                let stop = trip.stops.find((s: any) => s.stpid === prd.stpid && s.prdctdn === prdctdn);
                if (!stop) {
                    stop = { stpnm: prd.stpnm, stpid: prd.stpid, prdctdn: null, rt: null, rtdir: null };
                    trip.stops.push(stop);
                }
                stop.rtdir = prd.rtdir;
                stop.rt = prd.rt;
                stop.prdctdn = prdctdn;
                stop.prdtm = prdtmOf(prd, prdctdn);
            });
        }
        return acc;
    }, []);
}

export function processPredictions(rawChunks: any[]) {
    // prdtm sorts the prediction caches; keep it a finite number.
    const formattedPredictions = groupPredictions(rawChunks, (prd) => {
        const prdtm = parseInt(prd.prdtm);
        return Number.isFinite(prdtm) ? prdtm : Number.MAX_SAFE_INTEGER;
    });

    // build index maps
    const routeInfoFilter: Record<string, { stpid: string; rtdir: string }[]> = {};
    for (const [routeName, routeList] of Object.entries(state.cachedRoutes as Record<string, any[]>)) {
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
        // The feed reports "DLY" (delayed) instead of a countdown for some
        // stops; those cannot be ordered by time, so sort them last.
        const countdown = (s: any) => {
            const v = parseInt(s.prdctdn, 10);
            return Number.isFinite(v) ? v : Infinity;
        };
        const finiteCountdowns = trip.stops.map(countdown).filter((v: number) => v !== Infinity);
        if (finiteCountdowns.length === 0) return;
        const minPrdctdn = Math.min(...finiteCountdowns);
        const firstRoute = trip.stops.find((s: any) => countdown(s) === minPrdctdn)?.rt;

        if (!firstRoute) return;

        trip.stops.sort((a: any, b: any) => {
            const diffTime = countdown(a) - countdown(b);
            if (diffTime !== 0 && !Number.isNaN(diffTime)) return diffTime;
            if (a.rt + a.rtdir !== b.rt + b.rtdir) {
                // Antisymmetry matters: both stops can be on firstRoute in
                // different directions, so that tie must also be broken
                // deterministically (returning -1 for both orders corrupts
                // the sort and the timing cache learned from it).
                const aFirst = a.rt === firstRoute;
                const bFirst = b.rt === firstRoute;
                if (aFirst !== bFirst) return aFirst ? -1 : 1;
                return String(a.rt + (a.rtdir ?? '')).localeCompare(String(b.rt + (b.rtdir ?? '')));
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
            if (!Number.isFinite(diff)) continue; // delayed neighbor: no usable timing
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
            // Merge rather than replace: the hand-seeded interlining entries in
            // transitState (e.g. CN -> CS at the loop end) must survive live
            // learning. Extrapolation follows the FIRST entry, so earlier
            // (seeded) successors keep priority over later learned ones.
            state.routeTimingCache[rt][fromKey][to.stpid] = {
                diff: diff,
                rtdir: to.rtdir,
                rtNext: to.rt
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

            const lastCountdown = parseInt(lastStop.prdctdn, 10);
            if (!Number.isFinite(lastCountdown)) break; // cannot extrapolate from a delayed stop

            const [nextStopId, { diff, rtdir, rtNext }] = nextEntries[0];
            const nextPrdctdn = (lastCountdown + diff).toString();

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
export function processRidePredictions(rawChunks: any[]) {
    // TheRide's prdtm is "YYYYMMDD HH:MM:SS" (no unix timestamps), so derive a
    // usable epoch from the countdown instead. TODO: parse the actual timestamp.
    // "DLY" has no countdown; a NaN prdtm would corrupt the sorted prediction
    // caches, so pin it to the far future instead.
    return groupPredictions(rawChunks, (_prd, prdctdn) => {
        const rideCountdown = parseInt(prdctdn, 10);
        return Number.isFinite(rideCountdown)
            ? Date.now() + (rideCountdown + 0.5) * 60 * 1000
            : Number.MAX_SAFE_INTEGER;
    });
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
            // "DLY" entries are kept so the frontend can show delayed buses;
            // their prdtm is pinned far in the future so they sort last, and
            // the reminder pipeline skips non-numeric countdowns itself.

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
            // Same as updatePredictionLookups: "DLY" entries stay visible to
            // the frontend; the reminder pipeline ignores them itself.
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
export function convertToTrips(preds: any[]): Trip[] {
    const trips: Trip[] = [];
    const now = new Date();
    // Anchor all trip times to this build's UTC midnight and remember the
    // anchor, so request handlers can compute "now" in the same frame even
    // when the clock crosses midnight before the next rebuild.
    const baseMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    state.setCachedGraphTimeBase(baseMs);
    const currentTime = Math.floor((now.getTime() - baseMs) / 1000);

    preds.forEach((p: any) => {
        const stopTimes: StopTime[] = p.stops
            // Delayed stops ("DLY") have no countdown and would produce NaN times.
            .filter((s: any) => Number.isFinite(parseInt(s.prdctdn, 10)))
            .map((s: any) => ({
                stop: s.stpid,
                arrivalTime: currentTime + (parseInt(s.prdctdn) * 60),
                departureTime: currentTime + (parseInt(s.prdctdn) * 60),
                pickUp: true,
                dropOff: true,
                rt: s.rt,
                // Carried through so journey legs can flag guessed stop times.
                isExtrapolated: s.isExtrapolated
            })).sort((a: StopTime, b: StopTime) => a.arrivalTime - b.arrivalTime);

        // A vehicle whose every prediction is delayed has no usable schedule.
        if (stopTimes.length === 0) return;

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

/**
 * Returns "now" in the cached graph's time frame: seconds since the UTC
 * midnight the graph's stop times are anchored to. Just after 00:00 UTC this
 * exceeds 86400 until the graph is rebuilt, matching the stop times instead
 * of wrapping to ~0 while the graph still holds pre-midnight values.
 */
export function currentGraphTimeSeconds(): number {
    const now = new Date();
    const base = state.cachedGraphTimeBase
        || Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return Math.floor((now.getTime() - base) / 1000);
}

/** Finds the nearest k stops to a given coordinate. */
export function findNearestStops(lat: number, lon: number, k: number = 2) {
    if (isNaN(lat) || isNaN(lon)) throw new Error("Invalid Coordinates");

    // Root of the heap is the FARTHEST of the k stops kept so far, so it is
    // the one to evict when a nearer stop shows up.
    const heap = new MaxPriorityQueue<{ stpid: string; name: string; lat: number; lon: number; distance: number }>({
        compare: (a, b) => b.distance - a.distance
    });

    for (const [stpid, stop] of Object.entries(state.cachedStopLocations)) {
        const distance = haversine(lat, lon, stop.lat, stop.lon);

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