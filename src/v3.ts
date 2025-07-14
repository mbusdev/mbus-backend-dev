import * as process from "node:process";

import express from "express";
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
import { RaptorAlgorithm } from "./raptor/RaptorAlgorithm";
import { RaptorAlgorithmFactory } from "./raptor/RaptorAlgorithmFactory";
import { DepartAfterQuery } from "./query/DepartAfterQuery";
import { Journey, AnyLeg } from "./results/Journey";
import { JourneyFactory } from "./results/JourneyFactory";
import { earliestArrival, leastChanges, leastWalking } from "./results/filter/MultipleCriteriaFilter";

import * as metadata from "./assets/route-data.json";
import * as valid_assets from "./assets/valid_assets.json";
import * as path from "node:path";
import { transferableAbortSignal } from "node:util";

dotenv.config();
const router = express.Router();
const validAssets = new Set(valid_assets.validAssets);
const routeImages: {[k: string]: string} = metadata.routeImages;

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
const validRoutes = new Set();
let curRouteSelections = {};
const routes = ["BB", "CN", "CS", "CSX", "DD", "MX", "NE", "NW", "NX", "OS", "NES", "WS", "WX"];
let cachedStopLocations: { [stopId: string]: { lat: number, lon: number } } = {};

const message = {id: "gradamatation", title: "Congrats Grads 🥳", message: "Congrats to everyone who is gradamatating! Enjoy some grad hats on the buses, and don't forget to celebrate!", buildVersion: '99'}

let cachedGraph: {
    trips: Trip[];
    transfers: TransfersByOrigin;
    interchange: Interchange;
}

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

        const now = new Date();
        const currentTime = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

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
        const tripPredictions: Record<string, any[]> = {};
        
        predictions.forEach((trip: any) => {
            if (!tripPredictions[trip.tatripid]) {
                tripPredictions[trip.tatripid] = [];
            }
            trip.stops.forEach((stop: any) => {
                tripPredictions[trip.tatripid].push({
                    stpid: stop.stpid,
                    prdctdn: stop.prdctdn
                });
            });
        });

        Object.entries(tripPredictions).forEach(([tripId, preds]) => {
            // Create stop times with prediction times
            const stopTimes: StopTime[] = preds.map((pred: any) => ({
                stop: pred.stpid,
                arrivalTime: currentTime + (parseInt(pred.prdctdn) * 60),
                departureTime: currentTime + (parseInt(pred.prdctdn) * 60),
                pickUp: true,
                dropOff: true
            }));

            // Sort stop times by their sequence in the route
            const sortedStopTimes = sortStopTimesByRouteSequence(stopTimes);

            trips.push({
                tripId,
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
                    let prdctdn = prd.prdctdn;
                    prdctdn = prdctdn === "DUE" ? "1" : prdctdn;

                    let trip = acc.find((t: any) => t.tatripid === tatripid);
                    if (!trip) {
                        trip = { tatripid, stops: [] };
                        acc.push(trip);
                    }

                    let stop = trip.stops.find((s: any) => s.name === stopName && s.id === stopId);
                    if (!stop) {
                        stop = { stpnm: stopName, stpid: stopId, prdctdn: null };
                        trip.stops.push(stop);
                    }

                    stop.prdctdn = prdctdn;
                });
            }
            return acc;
        }, []);

        return formattedPredictions;
    } catch (err) {
        console.log(err);
        throw err;
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
    const getChunk = async (routes: string[]) => {
        const res = await client.get('/getvehicles', {
            params: {
                requestType: 'getvehicles',
                rt: routes.join(',')
            }
        });

        if ('bustime-response' in res.data && 'vehicle' in res.data['bustime-response']) {
            return res.data['bustime-response']['vehicle'];
        }
        
        return [];
    }

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

router.get('/getStopPredictions/:stopId', async (req, res) => {
    const { stopId } = req.params;

    const stopPreds = await client.get('/getpredictions', {
        params: {
            requestType: 'getpredictions',
            locale: 'en',
            stpid: stopId,
            rt: routes.join(','),
            rtpidatafeed: 'bustime',
            top: 4,
        }
    });

    res.send(stopPreds.data);
});


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

                const WALKING_SPEED_KMH = 5;
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
                                if (distance > 1200) {
                                    walkingTimeSeconds *= 1.5; // penatly for too big distances
                                }
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

setInterval(updateBusPositions, 7500);
setInterval(getSelectableRoutes, 6000);
setInterval(rebuildGraph, 2 * 60 * 1000);
getSelectableRoutes();
rebuildGraph(); 


router.get('/getBusPositions', (req, res) => {
    res.send(curBusPositions);
});

router.get('/getVehiclePositions', (req, res) => {
    res.send(curBusPositions);
});

router.get('/getSelectableRoutes', (req, res) => {
    res.send(curRouteSelections);
});

router.get('/getAllRoutes', (req, res) => {
    res.send({routes: cachedRoutes});
});

router.get('/getVehicleImage/:route', (req, res) => {
   const { route } = req.params;
   const isColorblind = req.query.colorblind === "Y";

   const dirname = import.meta.dirname;

   const assetPath = path.join(dirname, 'assets');
   const colorBlindPath = path.join(assetPath, 'colorblind');
   const regularPath = path.join(assetPath, 'grad-24');

    if (!route || !(route in routeImages)) {
        res.sendFile(path.join(assetPath, 'bus_CN.png'));
        return res.sendStatus(400);
    }


    if (isColorblind) {
        res.sendFile(path.join(colorBlindPath, routeImages[route]));
    } else {
        res.sendFile(path.join(regularPath, routeImages[route]));
    }
});

router.get('/getRouteInfoVersion', (req, res) => {
    res.send(JSON.stringify({version: metadata.metadata.version}));
});

router.get('/getRouteInformation', (req, res) => {
    const isColorblind = req.query.colorblind;
    const infoToSend = {
        routeIdToName: metadata.routeIdToName,
        routeImages: metadata.routeImages,
        metadata: metadata.metadata,
        routeColors: {}
    }
    if (isColorblind === "Y") {
        infoToSend.routeColors = metadata.routeColorsColorblind;
    } else {
        infoToSend.routeColors = metadata.routeColorsRegular;
    }
    res.send(infoToSend);
});

router.get('/getUpdateNotes', (req, res) => {
    res.send({message: "- ·Fixed Northeast Shuttle Icons\n- ·Working bus icons for Northeast Shuttle\n- ·General improvements", version: "7"});
});

router.get('/getBusPredictions/:busId', (req, res) => {
    axios.get(`https://mbus.ltp.umich.edu/bustime/api/v3/getpredictions?requestType=getpredictions&locale=en&vid=${req.params.busId}&top=4&tmres=s&rtpidatafeed=bustime&key=${API_KEY}&format=json&xtime=1626028950462`).then(apiRes => {
        res.send(apiRes.data);
    }).catch(err => {
        console.log(err);
        res.sendStatus(500);
    });
});

router.get('/getAllPredictions', async (req, res) => {
    try {
        const predictions = await getAllBusPredictions();
        res.send(predictions);
    } catch (err) {
        console.log(err);
        res.sendStatus(500);
    }
});

router.get('/getBuildingLocations', (req, res) => {
    res.sendFile(path.join(import.meta.dirname, 'assets', 'building-data.json'));
});

router.get('/get-startup-messages', (req, res) => {
    res.send(JSON.stringify(message));
});

router.get('/plan-journey', async (req, res) => {
    try {
        const originStopId = 'VIRTUAL_ORIGIN';
        const destStopId = 'VIRTUAL_DESTINATION';

        const { originLat, originLon, destLat, destLon } = req.query;
        if (!originLat || !originLon || !destLat || !destLon) {
            return res.status(400).json({ error: 'Origin and destination coordinates are required' });
        }

        const now = new Date();
        const currentTime = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

        if (!cachedGraph || !cachedGraph.trips || cachedGraph.trips.length === 0) {
            await rebuildGraph(); // try to build
            if (!cachedGraph) {
                return res.status(404).json({ error: 'No routes available at this time' });
            }
        }

        // Clear all transfers from the virtual origin
        cachedGraph.transfers[originStopId] = [];
        cachedGraph.transfers[destStopId] = [];
        // Clear all transfers to virtual destination
        Object.keys(cachedGraph.transfers).forEach(stopId => {
            cachedGraph.transfers[stopId] = cachedGraph.transfers[stopId].filter(
                t => t.destination !== destStopId
            );
        });

        // Update the times for the virtual trips
        const vOriginTrip = cachedGraph.trips.find(t => t.tripId === 'VIRTUAL_ORIGIN_TRIP');
        if (vOriginTrip) {
            vOriginTrip.stopTimes[0].arrivalTime = currentTime;
            vOriginTrip.stopTimes[0].departureTime = currentTime;
        }
        const vDestTrip = cachedGraph.trips.find(t => t.tripId === 'VIRTUAL_DESTINATION_TRIP');
        if (vDestTrip) {
            vDestTrip.stopTimes[0].arrivalTime = currentTime;
            vDestTrip.stopTimes[0].departureTime = currentTime;
        }

        // Calculate transfers from origin to all real stops
        const originLatNum = parseFloat(originLat as string);
        const originLonNum = parseFloat(originLon as string);
        const destLatNum = parseFloat(destLat as string);
        const destLonNum = parseFloat(destLon as string);

        const WALKING_SPEED_KMH = 5;
        const WALKING_SPEED_MS = WALKING_SPEED_KMH * 1000 / 3600;

        // Add transfers from origin to all real stops
        Object.keys(cachedStopLocations).forEach(stopId => {
            const stopLocation = cachedStopLocations[stopId];
            if (stopLocation) {
                const latDiff = (stopLocation.lat - originLatNum) * 111320;
                const lonDiff = (stopLocation.lon - originLonNum) * 111320 * Math.cos(originLatNum * Math.PI / 180);
                const distance = Math.sqrt(latDiff * latDiff + lonDiff * lonDiff);
                
                let walkingTimeSeconds = distance / WALKING_SPEED_MS;
                if (distance > 1200) {
                    walkingTimeSeconds *= 1.5; // penalty for too big distances
                }
                
                const transferDuration = Math.round(walkingTimeSeconds);
                
                const transfer: Transfer = {
                    origin: originStopId,
                    destination: stopId,
                    duration: transferDuration,
                    startTime: currentTime,
                    endTime: Number.MAX_SAFE_INTEGER
                };
                cachedGraph.transfers[originStopId].push(transfer);
            }
        });

        // Add transfers from all real stops to destination
        Object.keys(cachedStopLocations).forEach(stopId => {
            const stopLocation = cachedStopLocations[stopId];
            if (stopLocation) {
                const latDiff = (destLatNum - stopLocation.lat) * 111320;
                const lonDiff = (destLonNum - stopLocation.lon) * 111320 * Math.cos(stopLocation.lat * Math.PI / 180);
                const distance = Math.sqrt(latDiff * latDiff + lonDiff * lonDiff);
                
                let walkingTimeSeconds = distance / WALKING_SPEED_MS;
                if (distance > 1200) {
                    walkingTimeSeconds *= 1.5;
                }
                
                const transferDuration = Math.round(walkingTimeSeconds);
                
                const transfer: Transfer = {
                    origin: stopId,
                    destination: destStopId,
                    duration: transferDuration,
                    startTime: currentTime,
                    endTime: Number.MAX_SAFE_INTEGER
                };
                cachedGraph.transfers[stopId].push(transfer);
            }
        });

        // Direct transfer from VIRTUAL_ORIGIN to VIRTUAL_DESTINATION
        const directLatDiff = (destLatNum - originLatNum) * 111320;
        const directLonDiff = (destLonNum - originLonNum) * 111320 * Math.cos(originLatNum * Math.PI / 180);
        const directDistance = Math.sqrt(directLatDiff * directLatDiff + directLonDiff * directLonDiff);

        let directWalkingTimeSeconds = directDistance / WALKING_SPEED_MS;
        if (directDistance > 1200) {
            directWalkingTimeSeconds *= 1.5;
        }
        
        const directTransferDuration = Math.round(directWalkingTimeSeconds);
        console.log(`Walking Distance: ${directTransferDuration}`);

        const directTransfer: Transfer = {
            origin: originStopId,
            destination: destStopId,
            duration: directTransferDuration,
            startTime: currentTime,
            endTime: Number.MAX_SAFE_INTEGER
        };
        cachedGraph.transfers[originStopId].push(directTransfer);

        RaptorAlgorithm.setDebug(false);
        const raptor = RaptorAlgorithmFactory.create(cachedGraph.trips, cachedGraph.transfers, cachedGraph.interchange);
        
        const resultsFactory = new JourneyFactory();
        const journeyPlanner = new DepartAfterQuery(raptor, resultsFactory);
        const journeys = journeyPlanner.plan(
            originStopId as StopID,
            destStopId as StopID,
            currentTime
        );

        const fastest = journeys.length > 0 ? journeys.reduce((best, j) => earliestArrival(best, j) ? j : best, journeys[0]) : null;
        const leastTransfers = journeys.length > 0 ? journeys.reduce((best, j) => leastChanges(best, j) ? j : best, journeys[0]) : null;
        const leastWalk = journeys.length > 0 ? journeys.reduce((best, j) => leastWalking(best, j) ? j : best, journeys[0]) : null;
        const uniqueJourneys = [fastest, leastTransfers, leastWalk]
          .filter((j, i, arr) => j && arr.findIndex(x => x === j) === i);
        res.json({ journeys: uniqueJourneys.slice(0, 3) });
    } catch (error) {
        console.error('Error planning journey:', error);
        res.status(500).json({ error: 'Failed to plan journey' });
    }
});

export default router;