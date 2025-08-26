import * as process from "node:process";

import axios from 'axios';
import dotenv from "dotenv";
import { Route } from "@/types";
import { 
    Trip, 
    StopTime, 
    Transfer, 
    StopID, 
    TransfersByOrigin, 
    Interchange
} from "./raptor/types";

dotenv.config();

const API_KEY = process.env.MBUS_API_KEY;
if (API_KEY === undefined) {
    throw new Error("MBus API key not set.");
}

const curBusPositions: {
    buses: any[]
} = {
    "buses": []
}

const cachedRoutes: {[k: string]: any} = {};
type Prediction = { vid: string; stpid: string } & Record<string, any>;

let cachedPredsByVid: Record<string, Prediction[]> = {};
let cachedPredsByStopId: Record<string, Prediction[]> = {};
// routeTimingCache: route -> fromStop -> toStop -> latest diff (minutes)
const routeTimingCache: Record<string, Record<string, Record<string, {diff : number, rtdir : string, rtNext : string}>>> = 
{
    "CN": {
        "N434NORTHBOUND": {
        "N500": {
          "diff": 5,
          "rtdir": "SOUTHBOUND",
          "rtNext": "CS"
        }
      },
    },
    "CS":{
        "S002SOUTHBOUND": {
            "S001": {
            "diff": 5,
            "rtdir": "NORTHBOUND",
            "rtNext": "CN"
            }
        }
    }
};

const validRoutes = new Set();
let curRouteSelections = {};
const routes = ["BB", "CN", "CS", "CSX", "DD", "MX", "NE", "NW", "NX", "OS", "NES", "WS", "WX"];
let cachedStopLocations: { [stopId: string]: {name : string, lat: number, lon: number } } = {

};

const message = {id: "gradamatation", title: "Congrats Grads 🥳", message: "Congrats to everyone who is gradamatating! Enjoy some grad hats on the buses, and don't forget to celebrate!", buildVersion: '99'}

let cachedGraph: {
    trips: Trip[];
    transfers: TransfersByOrigin;
    interchange: Interchange;
}

let stopIdToName: Record<string, string> = {};
let tatripidToRt: Record<string, string> = {};

const sortStopTimesByRouteSequence = (stopTimes: StopTime[]): StopTime[] => {
    if (stopTimes.length <= 1) return stopTimes;
    
    // Sort by arrival time
    return stopTimes.sort((a, b) => a.arrivalTime - b.arrivalTime);
};

const rebuildGraph = async () => {
    try {
        const predictions = await getAllBusPredictions();
        if (!predictions || predictions.length === 0) {
            return;
        }

        // Build stopIdToName and tatripidToRt maps
        stopIdToName = {};
        tatripidToRt = {};
        predictions.forEach((trip: any) => {
            if (trip.tatripid && trip.stops && trip.stops.length > 0) {
                // Find first stop with rt
                const firstStopWithRt = trip.stops.find((stop: any) => stop.rt);
                if (firstStopWithRt && firstStopWithRt.rt) {
                    tatripidToRt[trip.tatripid] = firstStopWithRt.rt;
                }
            }
            trip.stops.forEach((stop: any) => {
                if (stop.stpid && stop.stpnm) {
                    stopIdToName[stop.stpid] = stop.stpnm;
                }
            });
        });
        
        const now = new Date();
        const currentTime = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();

        const transfers = cachedGraph?.transfers || {};
        const interchange = cachedGraph?.interchange || {};
        
        const allStops = new Set<StopID>();
        predictions.forEach((trip: any) => {
            trip.stops.forEach((stop: any) => {
                allStops.add(stop.stpid);
            });
        });
        
        allStops.forEach(stopId => {
            if (!transfers[stopId]) {
                transfers[stopId] = [];
            }
            if (!interchange[stopId]) {
                interchange[stopId] = 60; // 1 minute interchange time
            }
        });
        
        const stopPredictions: Record<string, any[]> = {};
        predictions.forEach((trip: any) => {
            trip.stops.forEach((stop: any) => {
                if (!stopPredictions[stop.stpid]) {
                    stopPredictions[stop.stpid] = [];
                }
                stopPredictions[stop.stpid].push({
                    stpid: stop.stpid,
                    prdctdn: stop.prdctdn,
                    tatripid: trip.tatripid
                });
            });
        });

        const trips: Trip[] = [];
        interface TripPrediction {
            vid: string;
            stops: {
                stpid: string;
                prdctdn: string;
                rt: string;
            }[];
        }

        const tripPredictions: Record<string, TripPrediction> = {};

        predictions.forEach((trip: any) => {
            if (!tripPredictions[trip.tatripid]) {
                tripPredictions[trip.tatripid] = {
                    vid: trip.vid,
                    stops: []
                };
            }
            trip.stops.forEach((stop: any) => {
                tripPredictions[trip.tatripid].stops.push({
                    stpid: stop.stpid,
                    prdctdn: stop.prdctdn,
                    rt: stop.rt
                });
            });
        });

        Object.entries(tripPredictions).forEach(([tripId, preds]) => {
            // Create stop times with prediction times
            const stopTimes: StopTime[] = preds.stops.map(pred => ({
                stop: pred.stpid,
                arrivalTime: currentTime + (parseInt(pred.prdctdn) * 60),
                departureTime: currentTime + (parseInt(pred.prdctdn) * 60),
                pickUp: true,
                dropOff: true,
                rt: pred.rt
            }));

            // Sort stop times by their sequence in the route
            const sortedStopTimes = sortStopTimesByRouteSequence(stopTimes);

            trips.push({
                tripId,
                vid: preds.vid,
                stopTimes: sortedStopTimes
            });
        });


        cachedGraph = {
            trips,
            transfers,
            interchange
        };

        // Add virtual stops and their interchange
        const originStopId = 'VIRTUAL_ORIGIN';
        const destStopId = 'VIRTUAL_DESTINATION';
        cachedGraph.transfers[originStopId] = [];
        cachedGraph.transfers[destStopId] = [];
        cachedGraph.interchange[originStopId] = 60;
        cachedGraph.interchange[destStopId] = 60;
        const virtualOriginTrip = {
            tripId: 'VIRTUAL_ORIGIN_TRIP',
            vid: null,
            stopTimes: [{
                stop: originStopId,
                arrivalTime: 0,
                departureTime: 0,
                pickUp: true,
                dropOff: true
            }]
        };
        const virtualDestTrip = {
            tripId: 'VIRTUAL_DESTINATION_TRIP',
            vid: null,
            stopTimes: [{
                stop: destStopId,
                arrivalTime: 0,
                departureTime: 0,
                pickUp: true,
                dropOff: true
            }]
        };
        cachedGraph.trips.push(virtualOriginTrip);
        cachedGraph.trips.push(virtualDestTrip);
        
    } catch (error) {
        console.error('Error rebuilding graph:', error);
    }
};

const getAllBusPredictions = async () => {
    try {
        // Get all unique stop IDs from cached routes
        const allStopIds = new Set<string>();
        Object.values(cachedRoutes).forEach((routePatterns: any) => {
            if (Array.isArray(routePatterns)) {
                routePatterns.forEach((pattern: any) => {
                    if (pattern.pt && Array.isArray(pattern.pt)) {
                        pattern.pt.forEach((point: any) => {
                            if (point.stpid) {
                                allStopIds.add(point.stpid);
                            }
                        });
                    }
                });
            }
        });

        const stopIdsArray = Array.from(allStopIds);
        const chunks = [];
        
        for (let i = 0; i < stopIdsArray.length; i += 10) {
            chunks.push(stopIdsArray.slice(i, i + 10));
        }

        const predictions = await Promise.all(
            chunks.map(async (chunk) => {
                const stopIds = chunk.join(',');
                const response = await axios.get(`https://mbus.ltp.umich.edu/bustime/api/v3/getpredictions`, {
                    params: {
                        requestType: 'getpredictions',
                        locale: 'en',
                        stpid: stopIds,
                        rt: routes.join(','),
                        tmres: 's',
                        rtpidatafeed: 'bustime',
                        key: API_KEY,
                        format: 'json'
                    }
                });
                return response.data;
            })
        );

        const formattedPredictions = predictions.flat().reduce((acc, predictionChunk) => {
        if (predictionChunk['bustime-response'] && predictionChunk['bustime-response']['prd']) {
            predictionChunk['bustime-response']['prd'].forEach((prd: any) => {
            const tatripid = prd.tatripid;
            const stopName = prd.stpnm;
            const stopId = prd.stpid;
            const rt = prd.rt;
            const rtdir = prd.rtdir;
            const vid = prd.vid;
            let prdctdn = prd.prdctdn;
            prdctdn = prdctdn === "DUE" ? "1" : prdctdn;

            let trip = acc.find((t: any) => t.tatripid === tatripid);

            if (!trip) {
                if (vid) { // if no trip, go by vid
                trip = acc.find((t: any) => t.vid === vid);
                }
            }

            if (!trip) { // if no trip, create one
                trip = { tatripid, vid, stops: [] };
                acc.push(trip);
            } else { // merge with existing trip
                if (!trip.tatripid) {
                trip.tatripid = tatripid;
                }
                if (!trip.vid && vid) {
                trip.vid = vid;
                }
            }

            let stop = trip.stops.find((s: any) => s.stpnm === stopName && s.stpid === stopId);
            if (!stop) {
                stop = { stpnm: stopName, stpid: stopId, prdctdn: null, rt: null, rtdir : null };
                trip.stops.push(stop);
            }
            stop.rtdir = rtdir;
            stop.rt = rt;
            stop.prdctdn = prdctdn;
            });
        }
        return acc;
        }, []);

        // Cache predictions by vid and stopId
        cachedPredsByVid = {};
        cachedPredsByStopId = {};
        predictions.flat().forEach((predictionChunk) => {
            const prds = predictionChunk['bustime-response']?.['prd'];
            if (!prds) return;

            prds.forEach((prd: Prediction) => {
                const { vid, stpid } = prd;
                // stpid -> [pred, pred...]
                if (!cachedPredsByStopId[stpid]) {
                cachedPredsByStopId[stpid] = [];
                }
                cachedPredsByStopId[stpid].push(prd); // store reference

                if (!vid) return;
                // vid -> [pred, pred...]
                if (!cachedPredsByVid[vid]) {
                cachedPredsByVid[vid] = [];
                }
                cachedPredsByVid[vid].push(prd);

            });
        });

        // Cache predictions per route in routeTimingCache for extrapolation

        // Record of stop ids in order using routes
        const routeInfoFilter: Record<string, { stpid: string; rtdir: string }[]> = {};
        for (const [routeName, routeList] of Object.entries(cachedRoutes as Record<string, any[]>)) {
            for (const route of routeList) {
                const rtdir = route.rtdir;
                const routeKey = routeName + rtdir;
                if (!routeInfoFilter[routeKey]) {
                    routeInfoFilter[routeKey] = [];
                }
                for (const point of route.pt) {
                if (point.typ !== "W" && point.stpid) {
                    routeInfoFilter[routeKey].push({ stpid: point.stpid, rtdir });
                }
                }
            }
        }

        const stopIdToName: Record<string, string> = {};
        formattedPredictions.forEach((trip: any) => {
            trip.stops.forEach((stop: any) => {
                if (stop.stpid && stop.stpnm) stopIdToName[stop.stpid] = stop.stpnm;
            });
        });

        // Create indices for route -> stop order
        const routeStopIndexMaps = new Map<string, Map<string, number>>();
        for (const [routeId, stopOrder] of Object.entries(routeInfoFilter)) {
            const stopIndexMap = new Map(stopOrder.map(({ stpid }, i) => [stpid, i]));
            routeStopIndexMaps.set(routeId, stopIndexMap);
        }

        formattedPredictions.forEach((trip: any) => {
            if(trip.stops.length == 0) return;   
            const minPrdctdn = Math.min(...trip.stops.map((s : any) => parseInt(s.prdctdn, 10)));
            const firstRoute = trip.stops.find((s: any) => parseInt(s.prdctdn, 10) === minPrdctdn)?.rt;

            if (!firstRoute) return;
            // Sort by predicted time
            trip.stops.sort((a: any, b: any) => {
                const diffTime = parseInt(a.prdctdn, 10) - parseInt(b.prdctdn, 10);
                if (diffTime !== 0) return diffTime; // primary sort

                // If not same route, put first route in front
                if (a.rt + a.rtdir !== b.rt + b.rtdir) {
                    if (a.rt === firstRoute) return -1;
                    if (b.rt === firstRoute) return 1;

                    return a.rt.localeCompare(b.rt);
                }        
                // If same route, sort by stop order 
                const aMap = routeStopIndexMaps.get(a.rt + a.rtdir);
                const bMap = routeStopIndexMaps.get(b.rt + b.rtdir);
        
                const aIdx = aMap?.get(a.stpid) ?? Number.MAX_SAFE_INTEGER;
                const bIdx = bMap?.get(b.stpid) ?? Number.MAX_SAFE_INTEGER;
                return aIdx - bIdx;
            });
            // Create edges based on sorted order
            for (let i = 0; i < trip.stops.length - 1; i++) {
                const from = trip.stops[i];
                const to = trip.stops[i + 1];
                const diff = parseInt(to.prdctdn, 10) - parseInt(from.prdctdn, 10);
                const rt = from.rt;

                const stopIndexMap = routeStopIndexMaps.get(from.rt + from.rtdir);
                if (!stopIndexMap) continue;

                const fromIdx = stopIndexMap.get(from.stpid);
                const toIdx   = stopIndexMap.get(to.stpid);
                // Ensure valid follow up stop by idx or end of idx
                const isValidFollowUp = (
                    fromIdx !== undefined &&
                    toIdx   !== undefined &&
                    (toIdx === fromIdx + 1 || fromIdx === stopIndexMap.size - 1)
                );
                if (!isValidFollowUp) continue;

                if (!routeTimingCache[rt]) routeTimingCache[rt] = {};
                const fromKey = from.stpid + (from.rtdir || "");
                if (!routeTimingCache[rt][fromKey]) routeTimingCache[rt][fromKey] = {};
                routeTimingCache[rt][fromKey][to.stpid] = {
                    diff : diff,
                    rtdir: to.rtdir,
                    rtNext: to.rt
                };
            }
        });
        
        // Extrapolate future stops based on routeTimingCache
        formattedPredictions.forEach((trip: any) => {
            let stopsAdded = 0;
            while (stopsAdded < 20 && trip.stops.length > 0) {
                const lastStop = trip.stops[trip.stops.length - 1];
                const rt = lastStop.rt;
                if (!rt) break;

                const fromKey = lastStop.stpid + (lastStop.rtdir || "");
                const nextStops = routeTimingCache[rt]?.[fromKey];
                if (!nextStops) break;

                const nextEntries = Object.entries(nextStops);
                if (nextEntries.length === 0) break;

                const [nextStopId, { diff, rtdir, rtNext}] = nextEntries[0];
                const nextPrdctdn = (parseInt(lastStop.prdctdn, 10) + diff).toString();

                trip.stops.push({
                    stpnm: stopIdToName[nextStopId] || nextStopId,
                    stpid: nextStopId,
                    prdctdn: nextPrdctdn,
                    rt : rtNext,
                    rtdir : rtdir
                });
                stopsAdded++;
            }
        });

        return formattedPredictions;
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("Error in getAllBusPredictions:", message);
        return [];
    }
};

const client = axios.create({
    baseURL: 'https://mbus.ltp.umich.edu/bustime/api/v3/',
    params: {
        key: API_KEY,
        format: 'json'
    }
});

const getBuses = async () => {
    const getChunk = async (routesChunk: string[]) => {
    try {
        const res = await client.get('/getvehicles', {
        params: { requestType: 'getvehicles', rt: routesChunk.join(',') },
        });

        if (
        'bustime-response' in res.data &&
        'vehicle' in res.data['bustime-response']
        ) {
        return res.data['bustime-response']['vehicle'];
        }

        return [];
    } catch (error) {
        console.warn('getChunk failed for routes', routesChunk, error instanceof Error ? error.message : error);
        return [];
    }
    };

    const chunks = []
    for (let i = 0; i < routes.length; i += 10) {
        chunks.push(routes.slice(i, i + 10));
    }

    let buses = await Promise.all(chunks.map(getChunk));
    buses = buses.flat();

    return buses;
}

const updateBusPositions = async () => {
    curBusPositions.buses = await getBuses();
}

const addToCachedRoutes = async (rt: string) => {
    try {
        const res = await client.get('/getpatterns', {
            params: {
                requestType: 'getpatterns',
                rtpidatafeed: 'bustime',
                rt: rt
            }
        });

        if (res.data['bustime-response'] && res.data['bustime-response']['ptr']) {
            cachedRoutes[rt] = res.data['bustime-response']['ptr'];
        }
    } catch (e) {
        console.log(`Error while getting routes: ${e}`);
    }
}

const getSelectableRoutes = () => {
    axios.get(`https://mbus.ltp.umich.edu/bustime/api/v3/getroutes?requestType=getroutes&locale=en&key=${API_KEY}&format=json`).then(res => {
        curRouteSelections = res.data;
        validRoutes.clear();
        try {
            res.data['bustime-response']['routes'].forEach((e: Route) => {
                validRoutes.add(e['rt']);
                addToCachedRoutes(e['rt']);
            });
        } catch (e) {

        }
    })
        .catch((err) => console.log(`Error while getting selectable routes: ${err}`))
        .finally(async () => {
            // Update transfers
            try {
                if (!cachedGraph) {
                    cachedGraph = {
                        trips: [],
                        transfers: {},
                        interchange: {}
                    };
                }
                // Rebuild stop locations cache from cached routes
                cachedStopLocations = {};
                console.log("Caching Transfers..")
                Object.values(cachedRoutes).forEach((routePatterns: any) => {
                    if (Array.isArray(routePatterns)) {
                        routePatterns.forEach((pattern: any) => {
                            if (pattern.pt && Array.isArray(pattern.pt)) {
                                pattern.pt.forEach((point: any) => {
                                    if (point.stpid && point.lat && point.lon) {
                                        cachedStopLocations[point.stpid] = {
                                            name: point.stpnm,
                                            lat: parseFloat(point.lat),
                                            lon: parseFloat(point.lon)
                                        };
                                    }
                                });
                            }
                        });
                    }
                });
                
                console.log(`Number of stop locations: ${Object.keys(cachedStopLocations).length}`);

                const WALKING_SPEED_KMH = 4;
                const WALKING_SPEED_MS = WALKING_SPEED_KMH * 1000 / 3600; // Convert to m/s

                const routeStops = new Set<string>();
                Object.values(cachedRoutes).forEach((routePatterns: any) => {
                    if (Array.isArray(routePatterns)) {
                        routePatterns.forEach((pattern: any) => {
                            if (pattern.pt && Array.isArray(pattern.pt)) {
                                pattern.pt.forEach((point: any) => {
                                    if (point.stpid) {
                                        routeStops.add(point.stpid);
                                    }
                                });
                            }
                        });
                    }
                });

                routeStops.forEach(stopId => {
                    cachedGraph.transfers[stopId] = [];
                });

                routeStops.forEach(stopId => {
                    if (!cachedGraph.interchange[stopId]) {
                        cachedGraph.interchange[stopId] = 60; // 1 minute interchange time
                    }
                });

                // Create transfers between all stops
                routeStops.forEach(stopId => {
                    routeStops.forEach(otherStopId => {
                        if (stopId !== otherStopId) {
                            const stop1 = cachedStopLocations[stopId];
                            const stop2 = cachedStopLocations[otherStopId];
                            
                            let transferDuration: number;
                            
                            if (stop1 && stop2) {
                                // Compute diff with lat and lon
                                const latDiff = (stop2.lat - stop1.lat) * 111320; 
                                const lonDiff = (stop2.lon - stop1.lon) * 111320 * Math.cos(stop1.lat * Math.PI / 180);
                                const distance = Math.sqrt(latDiff * latDiff + lonDiff * lonDiff);                                                        
                                let walkingTimeSeconds = distance / WALKING_SPEED_MS;                                
                                // if (distance > 1200) {
                                //     walkingTimeSeconds *= 1.5; // penatly for too big distances
                                // }
                                transferDuration = Math.round(walkingTimeSeconds);
                            } else {
                                console.log('Invalid stop');
                                transferDuration = 60000; 
                            }
                            const existingTransfer = cachedGraph.transfers[stopId].find(t => t.destination === otherStopId);
                            
                            if (existingTransfer) {
                                existingTransfer.duration = transferDuration;
                            } else {
                                const transfer: Transfer = {
                                    origin: stopId,
                                    destination: otherStopId,
                                    duration: transferDuration,
                                    startTime: 0,
                                    endTime: Number.MAX_SAFE_INTEGER 
                                };
                                cachedGraph.transfers[stopId].push(transfer);
                            }
                        }
                    });
                });
                
                const totalTransfers = Object.values(cachedGraph.transfers).reduce((total, transfers) => total + transfers.length, 0);
                console.log(`Total transfers in cachedGraph: ${totalTransfers}`);
            } catch (error) {
                console.error('Error updating transfers:', error);
            }
        });
}

export { 
    curBusPositions, 
    cachedRoutes, 
    cachedPredsByVid, 
    cachedPredsByStopId, 
    validRoutes, 
    curRouteSelections, 
    routes, 
    cachedStopLocations, 
    routeTimingCache,
    cachedGraph, 
    stopIdToName, 
    tatripidToRt,
    getAllBusPredictions,
    updateBusPositions,
    getSelectableRoutes,
    rebuildGraph
};

