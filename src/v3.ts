import * as process from "node:process";

import express from "express";
import axios from 'axios';
import dotenv from "dotenv";
import { Route } from "@/types";
import { 
    Trip, 
    StopTime, 
    TimetableLeg, 
    Transfer, 
    StopID, 
    Time, 
    TransfersByOrigin, 
    Interchange
} from "./raptor/types";
import { RaptorAlgorithm } from "./raptor/RaptorAlgorithm";
import { RaptorAlgorithmFactory } from "./raptor/RaptorAlgorithmFactory";
import { JourneyFactory } from "./results/JourneyFactory";
import { DepartAfterQuery } from "./query/DepartAfterQuery";
import { Journey, AnyLeg } from "./results/Journey";

import * as metadata from "./assets/route-data.json";
import * as valid_assets from "./assets/valid_assets.json";
import * as path from "node:path";

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

const message = {id: "gradamatation", title: "Congrats Grads 🥳", message: "Congrats to everyone who is gradamatating! Enjoy some grad hats on the buses, and don't forget to celebrate!", buildVersion: '99'}

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
        .catch((err) => console.log(`Error while getting selectable routes: ${err}`));
}

setInterval(updateBusPositions, 7500);
setInterval(getSelectableRoutes, 60000);
getSelectableRoutes();


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
        const buses = curBusPositions.buses;
        const chunks = [];
        
        for (let i = 0; i < buses.length; i += 10) {
            chunks.push(buses.slice(i, i + 10));
        }

        const predictions = await Promise.all(
            chunks.map(async (chunk) => {
                const vids = chunk.map(bus => bus.vid).join(',');
                const response = await axios.get(`https://mbus.ltp.umich.edu/bustime/api/v3/getpredictions`, {
                    params: {
                        requestType: 'getpredictions',
                        locale: 'en',
                        vid: vids,
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
                    const vid = prd.vid;
                    const stopName = prd.stpnm;
                    const stopId = prd.stpid;
                    let prdctdn = prd.prdctdn;
                    prdctdn = prdctdn === "DUE" ? "1" : prdctdn;

                    let bus = acc.find((b: any) => b.vid === vid);
                    if (!bus) {
                        bus = { vid, stops: [] };
                        acc.push(bus);
                    }

                    let stop = bus.stops.find((s: any) => s.name === stopName && s.id === stopId);
                    if (!stop) {
                        stop = { stpnm: stopName, stpid: stopId, prdctdn: null };
                        bus.stops.push(stop);
                    }

                    stop.prdctdn = prdctdn;
                });
            }
            return acc;
        }, []);

        res.send(formattedPredictions);
    } catch (err) {
        console.log(err);
        res.sendStatus(500);
    }
});

router.get('/get-startup-messages', (req, res) => {
    res.send(JSON.stringify(message));
});

router.get('/plan-journey', async (req, res) => {
    try {
        const { origin, destination } = req.query;
        if (!origin || !destination) {
            return res.status(400).json({ error: 'Origin and destination are required' });
        }

        const now = new Date();
        const currentTime = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

        const predictionsResponse = await axios.get('http://localhost:3000/mbus/api/v3/getAllPredictions');
        const predictions = predictionsResponse.data;

        if (!predictions || predictions.length === 0) {
            return res.status(404).json({ error: 'No buses available at this time' });
        }

        const transfers: TransfersByOrigin = {};
        const interchange: Interchange = {};
        
        const allStops = new Set<StopID>();
        predictions.forEach((bus: any) => {
            bus.stops.forEach((stop: any) => {
                allStops.add(stop.stpid);
            });
        });
        
        allStops.forEach(stopId => {
            transfers[stopId] = [];
            interchange[stopId] = 60; // 1 minute interchange time
        });
        
        const stopPredictions: Record<string, any[]> = {};
        predictions.forEach((bus: any) => {
            bus.stops.forEach((stop: any) => {
                if (!stopPredictions[stop.stpid]) {
                    stopPredictions[stop.stpid] = [];
                }
                stopPredictions[stop.stpid].push({
                    stpid: stop.stpid,
                    prdctdn: stop.prdctdn,
                    tatripid: bus.vid
                });
            });
        });

        allStops.forEach(stopId => {
            allStops.forEach(otherStopId => {
                if (stopId !== otherStopId) {
                    (stopPredictions[stopId] || []).forEach((pred: any) => {
                        const transfer: Transfer = {
                            origin: stopId,
                            destination: otherStopId,
                            duration: 6000, 
                            startTime: currentTime + (parseInt(pred.prdctdn) * 60), 
                            endTime: Number.MAX_SAFE_INTEGER 
                        };
                        transfers[stopId].push(transfer);
                    });
                }
            });
        });

        const trips: Trip[] = [];
        const tripPredictions: Record<string, any[]> = {};
        
        predictions.forEach((bus: any) => {
            if (!tripPredictions[bus.vid]) {
                tripPredictions[bus.vid] = [];
            }
            bus.stops.forEach((stop: any) => {
                tripPredictions[bus.vid].push({
                    stpid: stop.stpid,
                    prdctdn: stop.prdctdn
                });
            });
        });

        Object.entries(tripPredictions).forEach(([tripId, preds]) => {
            const firstLoopStopTimes: StopTime[] = preds.map((pred: any) => ({
                stop: pred.stpid,
                arrivalTime: currentTime + (parseInt(pred.prdctdn) * 60),
                departureTime: currentTime + (parseInt(pred.prdctdn) * 60),
                pickUp: true,
                dropOff: true
            }));

            // Create second loop
            const secondLoopStopTimes: StopTime[] = preds.map((pred: any) => ({
                stop: pred.stpid,
                arrivalTime: currentTime + (parseInt(pred.prdctdn) * 60) + 1800, // 30 minutes later
                departureTime: currentTime + (parseInt(pred.prdctdn) * 60) + 1800,
                pickUp: true,
                dropOff: true
            }));

            const combinedStopTimes = [...firstLoopStopTimes, ...secondLoopStopTimes];

            trips.push({
                tripId,
                stopTimes: combinedStopTimes
            });
        });

        RaptorAlgorithm.setDebug(false);
        const raptor = RaptorAlgorithmFactory.create(trips, transfers, interchange);
        
        const journeyPlanner = new DepartAfterQuery(raptor, {
            getResults: (kConnections, dest) => {
                if (!kConnections || !kConnections[dest]) {
                    return [];
                }
                
                const connections = kConnections[dest];
                if (!connections || Object.keys(connections).length === 0) {
                    return [];
                }

                return Object.entries(connections).map(([k, connection]) => {
                    if (!connection) return null;
                    
                    if (Array.isArray(connection)) {
                        const [trip, startIndex, endIndex] = connection;
                        return {
                            legs: [{
                                origin: trip.stopTimes[startIndex].stop,
                                destination: trip.stopTimes[endIndex].stop,
                                stopTimes: trip.stopTimes.slice(startIndex, endIndex + 1),
                                trip
                            }],
                            departureTime: trip.stopTimes[startIndex].departureTime,
                            arrivalTime: trip.stopTimes[endIndex].arrivalTime
                        };
                    } else {
                        return {
                            legs: [{
                                origin: connection.origin,
                                destination: connection.destination,
                                duration: connection.duration,
                                startTime: connection.startTime,
                                endTime: connection.endTime
                            }],
                            departureTime: connection.startTime,
                            arrivalTime: connection.startTime + connection.duration
                        };
                    }
                }).filter(Boolean) as Journey[];
            }
        });
        
        const journeys = journeyPlanner.plan(
            origin as StopID,
            destination as StopID,
            currentTime
        );

        res.json({ journeys });
    } catch (error) {
        console.error('Error planning journey:', error);
        res.status(500).json({ error: 'Failed to plan journey' });
    }
});

export default router;