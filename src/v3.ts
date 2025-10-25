import express from "express";
import dotenv from "dotenv";
import { 
    Transfer, 
    StopID, 
    TimetableLeg
} from "./raptor/types";
import { RaptorAlgorithm } from "./raptor/RaptorAlgorithm";
import { RaptorAlgorithmFactory } from "./raptor/RaptorAlgorithmFactory";
import { DepartAfterQuery } from "./query/DepartAfterQuery";
import { JourneyFactory } from "./results/JourneyFactory";
import { earliestArrival, leastChanges, leastWalking } from "./results/filter/MultipleCriteriaFilter";

import * as metadata from "./assets/route-data.json";
import * as valid_assets from "./assets/valid_assets.json";
import * as path from "node:path";
import { MaxPriorityQueue } from '@datastructures-js/priority-queue';


import { 
    curBusPositions,
    curRidePositions, 
    cachedRoutes, 
    cachedPredsByVid, 
    cachedPredsByStopId,
    cachedRidePredsByVid, 
    cachedRidePredsByStopId, 
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
    updateRidePositions,
    getSelectableRoutes,
    rebuildGraph
} from './busService';
import axios from "axios";

// Simple Bus Color System
interface BusRoute {
    routeId: string;
    color: string;
    image: string;
}

class BusColorManager {
    private readonly routes: BusRoute[] = [
        { routeId: "BB", color: "#2F773F", image: "bus_BB.png" },
        { routeId: "CN", color: "#643076", image: "bus_CN.png" },
        { routeId: "CS", color: "#3559B8", image: "bus_CS.png" },
        { routeId: "CSX", color: "#1C2256", image: "bus_CSX.png" },
        { routeId: "DD", color: "#A9C534", image: "bus_DD.png" },
        { routeId: "MX", color: "#5EC7DE", image: "bus_MX.png" },
        { routeId: "NE", color: "#C55188", image: "bus_NE.png" },
        { routeId: "NW", color: "#AE3636", image: "bus_NW.png" },
        { routeId: "NX", color: "#DA4343", image: "bus_NX.png" },
        { routeId: "OS", color: "#E8A43C", image: "bus_OS.png" },
        { routeId: "NES", color: "#C55188", image: "bus_NES.png" },
        { routeId: "WS", color: "#BA5231", image: "bus_WS.png" },
        { routeId: "WX", color: "#E8663E", image: "bus_WX.png" },
        // the ride
        { routeId: "3", color: "#0B9D57", image: "3.png" },
        { routeId: "4", color: "#9D3E97", image: "4.png" },
        { routeId: "5", color: "#086CB6", image: "5.png" },
        { routeId: "6", color: "#F58220", image: "6.png" },
        { routeId: "22", color: "#F5B94E", image: "22.png" },
        { routeId: "23", color: "#086CB6", image: "23.png" },
        { routeId: "25", color: "#0B9D57", image: "25.png" },
        { routeId: "26", color: "#086CB6", image: "26.png" },
        { routeId: "27", color: "#F5B94E", image: "27.png" },
        { routeId: "28", color: "#F58220", image: "28.png" },
        { routeId: "29", color: "#086CB6", image: "29.png" },
        { routeId: "30", color: "#9D3E97", image: "30.png" },
        { routeId: "31", color: "#0B9D57", image: "31.png" },
        { routeId: "32", color: "#A36D30", image: "32.png" },
        { routeId: "33", color: "#086CB6", image: "33.png" },
        { routeId: "34", color: "#D7242A", image: "34.png" },
        { routeId: "42", color: "#D7242A", image: "42.png" },
        { routeId: "43", color: "#F58220", image: "43.png" },
        { routeId: "44", color: "#75BA44", image: "44.png" },
        { routeId: "45", color: "#F5B94E", image: "45.png" },
        { routeId: "46", color: "#A36D30", image: "46.png" },
        { routeId: "47", color: "#0B9D57", image: "47.png" },
        { routeId: "61", color: "#F5B94E", image: "61.png" },
        { routeId: "62", color: "#A36D30", image: "62.png" },
        { routeId: "63", color: "#F58220", image: "63.png" },
        { routeId: "64", color: "#D7242A", image: "64.png" },
        { routeId: "65", color: "#75BA44", image: "65.png" },
        { routeId: "66", color: "#A36D30", image: "66.png" },
        { routeId: "67", color: "#F5B94E", image: "67.png" },
        { routeId: "68", color: "#D7242A", image: "68.png" },
        { routeId: "104", color: "#9D3E97", image: "104.png" },
    ];

    public getRouteColor(routeId: string): string | null {
        const route = this.routes.find(r => r.routeId === routeId);
        return route ? route.color : null;
    }

    public getRouteImage(routeId: string): string | null {
        const route = this.routes.find(r => r.routeId === routeId);
        return route ? route.image : null;
    }

    public getAllRoutes(): BusRoute[] {
        return [...this.routes];
    }

    public getRouteInfo(routeId: string): BusRoute | null {
        return this.routes.find(r => r.routeId === routeId) || null;
    }
}

// Initialize bus color manager
const busColorManager = new BusColorManager();

dotenv.config();
const router = express.Router();
const routeImages: {[k: string]: string} = metadata.routeImages;

setInterval(updateBusPositions, 7500);
setInterval(updateRidePositions, 7500);
setInterval(getSelectableRoutes, 60000);
setInterval(rebuildGraph, 10 * 1000);
getSelectableRoutes();
rebuildGraph(); 

import * as process from "node:process";



dotenv.config();

const API_KEY = process.env.MBUS_API_KEY;
const RIDE_API_KEY = process.env.RIDE_API_KEY;

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

router.get('/getRidePositions', (req, res) => {
    res.send(curRidePositions);
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

router.get('/getrouteCache', (req, res) => {
    res.send({routes: routeTimingCache});
});

router.get('/getVehicleImage/:route', (req, res) => {
   const { route } = req.params;

   const dirname = import.meta.dirname;
   const assetPath = path.join(dirname, 'assets');
   const imagePath = path.join(assetPath, 'main2025');

    if (!route || !(route in routeImages)) {
        res.sendFile(path.join(assetPath, 'bus_CN.png'));
        return res.sendStatus(400);
    }

    res.sendFile(path.join(imagePath, routeImages[route]));
});

router.get('/getRouteInfoVersion', (req, res) => {
    res.send(JSON.stringify({version: metadata.metadata.version}));
});

router.get('/getRouteInformation', (req, res) => {
    const infoToSend = {
        routeIdToName: metadata.routeIdToName,
        routeImages: metadata.routeImages,
        metadata: metadata.metadata,
        routeColors: busColorManager.getAllRoutes().map(route => ({
            routeId: route.routeId,
            color: route.color,
            image: route.image
        }))
    }
    res.send(infoToSend);
});

router.get('/getStartupInfo', (req, res) => {
    res.json({
        // updating this will disable older versions of the app
        min_supported_version: "1.0.0",
        why_update_message: {
            title: "New Update Available",
            subtitle: "Please update to the latest version for the best experience."
        },
        // adding data here will show a persistant message on launch 
        persistant_message: {
            title: "",
            subtitle: ""
        },
        // adding data here will show a one-time message on launch (not yet implemented)
        one_time_message: {
            title: "",
            subtitle: ""
        },
        // updating this will make bus images redownload on frontend
        bus_image_version: "1",
    });
});;

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

router.get('/getRidePredictions/:busId', (req, res) => {
    const busId = req.params.busId;
    const preds = cachedRidePredsByVid[busId];

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

router.get('/getRideStopPredictions/:stopId', (req, res) => {
    const stopId = req.params.stopId;
    const preds = cachedRidePredsByStopId[stopId];

    if (!preds) {
        return res.json({
            "bustime-response": { "prd": [] }
        });
    }

    res.json({
        "bustime-response": { "prd": preds }
    });
});

router.get('getRideStopPredictions/:stopId', (req, res) =>)

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

// Simple bus color endpoints
router.get('/getRouteColors', (req, res) => {
    const routes = busColorManager.getAllRoutes();
    res.json({
        routes: routes.map(route => ({
            routeId: route.routeId,
            color: route.color,
            image: route.image
        }))
    });
});

router.get('/getRouteColor/:routeId', (req, res) => {
    const { routeId } = req.params;
    const routeInfo = busColorManager.getRouteInfo(routeId);
    
    if (!routeInfo) {
        return res.status(404).json({ error: `Route '${routeId}' not found` });
    }
    
    res.json({
        routeId: routeInfo.routeId,
        color: routeInfo.color,
        image: routeInfo.image
    });
});

// Simple endpoint for frontend, gets everything needed for UI
router.get('/getFrontendData', (req, res) => {
    try {
        const routes = busColorManager.getAllRoutes();
        
        const response = {
            routes: routes.map(route => ({
                routeId: route.routeId,
                name: (metadata.routeIdToName as any)[route.routeId] || route.routeId,
                image: route.image,
                color: route.color,
                imageUrl: `/mbus/api/v3/getVehicleImage/${route.routeId}`
            })),
            metadata: {
                ...metadata.metadata,
                lastUpdated: new Date().toISOString()
            }
        };
        
        res.json(response);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get frontend data' });
    }
});


router.get('/nearest-stops', (req, res) => {
  try {
    const { lat, lon, k = '2' } = req.query;

    const originLat = parseFloat(lat as string);
    const originLon = parseFloat(lon as string);
    const numStops = parseInt(k as string);

    if (isNaN(originLat) || isNaN(originLon)) {
      return res.status(400).json({ error: 'Invalid or missing lat/lon' });
    }
    if (isNaN(numStops) || numStops <= 0) {
      return res.status(400).json({ error: 'Parameter k must be a positive integer' });
    }

    const heap = new MaxPriorityQueue<{ stpid: string; name: string; lat: number; lon: number; distance: number }>({
      compare: (a, b) => a.distance - b.distance
    });

    for (const [stpid, stop] of Object.entries(cachedStopLocations)) {
      const latDiff = (stop.lat - originLat) * 111320;
      const lonDiff = (stop.lon - originLon) * 111320 * Math.cos(originLat * Math.PI / 180);
      const distance = Math.sqrt(latDiff ** 2 + lonDiff ** 2);

      const stopWithDist = {
        stpid,
        name: stop.name,
        lat: stop.lat,
        lon: stop.lon,
        distance
      };

      if (heap.size() < numStops) {
        heap.enqueue(stopWithDist);
      } else if (distance < heap.front().distance) {
        heap.dequeue();
        heap.enqueue(stopWithDist);
      }
    }

    const nearestStops = heap.toArray().sort((a, b) => a.distance - b.distance);
    res.json({ nearestStops });
  } catch (error) {
    console.error('Error in /nearest-stops:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function optimizeWalkingFastest(journey: any, cachedGraph: any): any {
  if (!journey) return journey;

  const optimizedLegs: any[] = [];
  const WALKING_SPEED_KMH = 4;
  const WALKING_SPEED_MS = WALKING_SPEED_KMH * 1000 / 3600;

  function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dx = (lat2 - lat1) * 111320;
    const dy = (lon2 - lon1) * 111320 * Math.cos(lat1 * Math.PI / 180);
    return Math.sqrt(dx * dx + dy * dy);
  }

  for (let i = 0; i < journey.legs.length; i++) {
    const leg = journey.legs[i];

    // Look for a transfer followed by a bus trip
    if (leg.trip && i > 0 && "duration" in journey.legs[i - 1]) {
      const transfer = journey.legs[i - 1] as Transfer;
      const tripLeg = leg as TimetableLeg;
      const trip = tripLeg.trip;

      const originalBoardStop = tripLeg.stopTimes[0].stop;
      const boardIdx = trip.stopTimes.findIndex(st => st.stop === originalBoardStop);
      const walkStartTime = transfer.startTime;

      let bestStop = originalBoardStop;
      let bestIdx = boardIdx;
      let bestDistance = Number.MAX_SAFE_INTEGER;

      const originLoc = cachedStopLocations[transfer.origin];
      if (!originLoc) {
        optimizedLegs.push(leg);
        continue;
      }

      for (let j = boardIdx; j < trip.stopTimes.length; j++) {
        const candidate = trip.stopTimes[j];
        const stopLoc = cachedStopLocations[candidate.stop];
        if (!stopLoc) continue;

        const dist = distanceMeters(originLoc.lat, originLoc.lon, stopLoc.lat, stopLoc.lon);
        const walkArrival = walkStartTime + dist / WALKING_SPEED_MS;
        const busArrival = candidate.arrivalTime - (cachedGraph.interchange[candidate.stop] ?? 0);

        if (walkArrival <= busArrival && dist < bestDistance) {
          bestStop = candidate.stop;
          bestIdx = j;
          bestDistance = dist;
        }
      }

      if (bestStop !== originalBoardStop) {
        console.log(`Optimized walking to ${bestStop} instead of ${originalBoardStop}, saving ${Math.round(bestDistance)} meters`);
        // Update transfer
        transfer.destination = bestStop;
        transfer.duration = Math.round(bestDistance / WALKING_SPEED_MS);

        // Trim trip leg to start from bestStop
        tripLeg.stopTimes = trip.stopTimes.slice(bestIdx);

        // Refresh trip leg duration
        if (tripLeg.stopTimes.length > 1) {
          const firstStop = tripLeg.stopTimes[0];
          const lastStop = tripLeg.stopTimes[tripLeg.stopTimes.length - 1];
          (tripLeg as any).duration = lastStop.arrivalTime - firstStop.departureTime;
        }
      }
    }

    optimizedLegs.push(leg);
  }

  return { ...journey, legs: optimizedLegs };
}

router.get('/plan-journey', async (req, res) => {
    try {
        const originStopId = 'VIRTUAL_ORIGIN';
        const destStopId = 'VIRTUAL_DESTINATION';

        const { originLat, originLon, destLat, destLon, walkingPenalty: walkingPenaltyParam } = req.query;
        if (!originLat || !originLon || !destLat || !destLon) {
            return res.status(400).json({ error: 'Origin and destination coordinates are required' });
        }

        const now = new Date();
        const currentTime = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();

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
        
        const directTransferDuration = Math.round(directWalkingTimeSeconds);
        //console.log(`Walking Distance: ${directTransferDuration}`);

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
                    if(leg.trip && leg.trip.tripId){
                        // Add duration for bus legs
                        if (leg.stopTimes && leg.stopTimes.length > 0) {
                            const firstStop = leg.stopTimes[0];
                            const lastStop = leg.stopTimes[leg.stopTimes.length - 1];
                            formattedLeg.duration = lastStop.arrivalTime - firstStop.departureTime;
                            formattedLeg.rt = firstStop.rt;
                            formattedLeg.vid = leg.vid;

                        }
                    } else if (typeof leg.duration === 'number') {
                        // Add duration for transfer legs
                        formattedLeg.duration = leg.duration;
                    }
                    return formattedLeg;
                })
            };
        };

        let fastest = journeys.length > 0 ? journeys.reduce((best, j) => earliestArrival(best, j) ? j : best, journeys[0]) : null;
        // if (fastest) {
        //     fastest = optimizeWalkingFastest(fastest, cachedGraph);
        // }
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
