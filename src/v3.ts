import express from "express";
import dotenv from "dotenv";
import { 
    Transfer, 
    StopID, 
} from "./raptor/types";
import { RaptorAlgorithm } from "./raptor/RaptorAlgorithm";
import { RaptorAlgorithmFactory } from "./raptor/RaptorAlgorithmFactory";
import { DepartAfterQuery } from "./query/DepartAfterQuery";
import { JourneyFactory } from "./results/JourneyFactory";
import { earliestArrival, leastChanges, leastWalking } from "./results/filter/MultipleCriteriaFilter";

import * as metadata from "./assets/route-data.json";
import * as valid_assets from "./assets/valid_assets.json";
import * as path from "node:path";

import { 
    curBusPositions, 
    cachedPredsByStopId, 
    cachedRoutes, 
    cachedPredsByVid, 
    cachedStopLocations, 
    curRouteSelections,
    stopIdToName,
    tatripidToRt,
    getAllBusPredictions,
    cachedGraph,
    updateBusPositions,
    getSelectableRoutes,
    rebuildGraph
} from './busService';
import axios from "axios";

dotenv.config();
const router = express.Router();
const routeImages: {[k: string]: string} = metadata.routeImages;

const message = {id: "gradamatation", title: "Congrats Grads 🥳", message: "Congrats to everyone who is gradamatating! Enjoy some grad hats on the buses, and don't forget to celebrate!", buildVersion: '99'}


setInterval(updateBusPositions, 7500);
setInterval(getSelectableRoutes, 60000);
setInterval(rebuildGraph, 2 * 60 * 1000);
getSelectableRoutes();
rebuildGraph(); 

import * as process from "node:process";



dotenv.config();

const API_KEY = process.env.MBUS_API_KEY;
router.get('/getBusPredictions1/:busId', (req, res) => {
    axios.get(`https://mbus.ltp.umich.edu/bustime/api/v3/getpredictions?requestType=getpredictions&locale=en&vid=${req.params.busId}&top=4&tmres=s&rtpidatafeed=bustime&key=${API_KEY}&format=json&xtime=1626028950462`).then(apiRes => {
        res.send(apiRes.data);
    }).catch(err => {
        console.log(err);
        res.sendStatus(500);

    });
});

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
    const busId = req.params.busId;
    const preds = cachedPredsByVid[busId];

    if (!preds) {
        return res.json({
            "bustime-response": { "prd": [] }
        });
    }
    res.json({
        "bustime-response": { "prd": preds }
    });
});

router.get('/getStopPredictions/:stopId', (req, res) => {
    const stopId = req.params.stopId;
    const preds = cachedPredsByStopId[stopId];

    if (!preds) {
        return res.json({
            "bustime-response": { "prd": [] }
        });
    }

    res.json({
        "bustime-response": { "prd": preds }
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

router.get('/getAllStops', (req, res) => {
    const stopsList = Object.entries(cachedStopLocations).map(([stpid, stopInfo]) => ({
    stpid,
    ...stopInfo,
  }));
    res.json(Object.values(stopsList));
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

        const { originLat, originLon, destLat, destLon, walkingPenalty: walkingPenaltyParam } = req.query;
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

        const WALKING_SPEED_KMH = 4;
        const WALKING_SPEED_MS = WALKING_SPEED_KMH * 1000 / 3600;

        // Add transfers from origin to all real stops
        Object.keys(cachedStopLocations).forEach(stopId => {
            const stopLocation = cachedStopLocations[stopId];
            if (stopLocation) {
                const latDiff = (stopLocation.lat - originLatNum) * 111320;
                const lonDiff = (stopLocation.lon - originLonNum) * 111320 * Math.cos(originLatNum * Math.PI / 180);
                const distance = Math.sqrt(latDiff * latDiff + lonDiff * lonDiff);
                
                let walkingTimeSeconds = distance / WALKING_SPEED_MS;
                // if (distance > 1200) {
                //     walkingTimeSeconds *= 1.5; // penalty for too big distances
                // }
                
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
                // if (distance > 1200) {
                //     walkingTimeSeconds *= 1.5;
                // }
                
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
        // if (directDistance > 1200) {
        //     directWalkingTimeSeconds *= 1.5;
        // }
        
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
        let walkingPenalty = 1; // default no penalty
        if (walkingPenaltyParam !== undefined) {
            const parsed = parseFloat(walkingPenaltyParam as string);
            if (!isNaN(parsed) && parsed > 0) {
                walkingPenalty = parsed;
            }
        }
        raptor.setWalkingPenalty(walkingPenalty);

        const resultsFactory = new JourneyFactory();
        const journeyPlanner = new DepartAfterQuery(raptor, resultsFactory);
        const journeys = journeyPlanner.plan(
            originStopId as StopID,
            destStopId as StopID,
            currentTime
        );

        // Enrich journey legs with stop names
        const formatJourney = (journey: any) => {
            if (!journey) return null;
            return {
                ...journey,
                legs: journey.legs.map((leg: any) => {
                    const formattedLeg: any = {
                        ...leg,
                        origin_id: leg.origin,
                        origin: leg.origin === 'VIRTUAL_ORIGIN' ? 'Start' : (leg.origin === 'VIRTUAL_DESTINATION' ? 'End' : (stopIdToName[leg.origin] || leg.origin)),
                        destination_id: leg.destination,
                        destination: leg.destination === 'VIRTUAL_ORIGIN' ? 'Start' : (leg.destination === 'VIRTUAL_DESTINATION' ? 'End' : (stopIdToName[leg.destination] || leg.destination))
                    };
                    if (leg.trip && leg.trip.tripId) {
                        formattedLeg.tripId = leg.trip.tripId;
                        if (tatripidToRt[leg.trip.tripId]) {
                            formattedLeg.rt = tatripidToRt[leg.trip.tripId];
                        }
                        // Add duration for bus legs
                        if (leg.stopTimes && leg.stopTimes.length > 0) {
                            const firstStop = leg.stopTimes[0];
                            const lastStop = leg.stopTimes[leg.stopTimes.length - 1];
                            formattedLeg.duration = lastStop.arrivalTime - firstStop.departureTime;
                        }
                    } else if (typeof leg.duration === 'number') {
                        // Add duration for transfer legs
                        formattedLeg.duration = leg.duration;
                    }
                    return formattedLeg;
                })
            };
        };

        const fastest = journeys.length > 0 ? journeys.reduce((best, j) => earliestArrival(best, j) ? j : best, journeys[0]) : null;
        const leastTransfers = journeys.length > 0 ? journeys.reduce((best, j) => leastChanges(best, j) ? j : best, journeys[0]) : null;
        const leastWalk = journeys.length > 0 ? journeys.reduce((best, j) => leastWalking(best, j) ? j : best, journeys[0]) : null;
        const uniqueJourneys = [fastest, leastTransfers, leastWalk]
          .filter((j, i, arr) => j && arr.findIndex(x => x === j) === i)
          .map(formatJourney);
        res.json({ journeys: uniqueJourneys.slice(0, 3) });
    } catch (error) {
        console.error('Error planning journey:', error);
        res.status(500).json({ error: 'Failed to plan journey' });
    }
});

export default router;