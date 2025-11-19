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
    getWalkingDistancesFrom, 
    getWalkingResponse, 
    WALKING_SPEED,
} from './walking/a_star'; // Adjust path as needed

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
    routeTimingCache,
    cachedGraph,
    updateBusPositions,
    getSelectableRoutes,
    rebuildGraph,
    stopNodeMap,
    walkingCache
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
        { routeId: "WX", color: "#E8663E", image: "bus_WX.png" }
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

const message = { id: "gradamatation", title: "Congrats Grads 🥳", message: "Congrats to everyone who is gradamatating! Enjoy some grad hats on the buses, and don't forget to celebrate!", buildVersion: '99' }

// Initialize bus color manager
const busColorManager = new BusColorManager();

dotenv.config();
const router = express.Router();
const routeImages: {[k: string]: string} = metadata.routeImages;

setInterval(updateBusPositions, 7500);
setInterval(getSelectableRoutes, 60000);
setInterval(rebuildGraph, 10 * 1000);
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

router.get('/getrouteCache', (req, res) => {
    res.send({routes: routeTimingCache});
});

router.get('/getVehicleImage/:route', (req, res) => {
   const { route } = req.params;

   const dirname = import.meta.dirname;
   const assetPath = path.join(dirname, 'assets');
   const imagePath = path.join(assetPath, 'main2025');
    if (!route || !(route in routeImages)) {
        res.status(400).sendFile(path.join(imagePath, 'bus_CN.png'));
        return; 
    }
    res.sendFile(path.join(imagePath, routeImages[route]), (err) => {
        if (err) {
            console.error(`Error sending requested image for route ${route}: ${err.message}`);
            if (!res.headersSent) res.status(404).send('Image file not found on server.');
        }
    });
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
            return res.status(400).json({ error: 'coordinates are required' });
        }

        const oLat = parseFloat(originLat as string);
        const oLon = parseFloat(originLon as string);
        const dLat = parseFloat(destLat as string);
        const dLon = parseFloat(destLon as string);

        const now = new Date();
        const currentTime = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
        
        if (!cachedGraph || !cachedGraph.trips) {
            await rebuildGraph();
            if (!cachedGraph) return res.status(404).json({ error: 'No routes' });
        }

        cachedGraph.transfers[originStopId] = [];
        cachedGraph.transfers[destStopId] = [];
        Object.keys(cachedGraph.transfers).forEach(stopId => {
            cachedGraph.transfers[stopId] = cachedGraph.transfers[stopId].filter(t => t.destination !== destStopId);
        });

        
        const dijkstraFromOrigin = getWalkingDistancesFrom(oLat, oLon);

        const dijkstraFromDest = getWalkingDistancesFrom(dLat, dLon);

        Object.keys(cachedStopLocations).forEach(stopId => {
            const mapData = stopNodeMap[stopId];
            if (!mapData) return; // Stop not mapped to graph (rare)

            const distOnGraph = dijkstraFromOrigin.nodeDistances.get(mapData.nodeId);
            
            if (distOnGraph !== undefined) {
                const totalDist = dijkstraFromOrigin.distanceToNode + distOnGraph + mapData.distToNode;
                const duration = Math.ceil(totalDist / WALKING_SPEED); // WALKING_SPEED from a_star.ts

                cachedGraph.transfers[originStopId].push({
                    origin: originStopId,
                    destination: stopId,
                    duration: duration,
                    startTime: currentTime,
                    endTime: Number.MAX_SAFE_INTEGER
                });
                
            }
        });

        Object.keys(cachedStopLocations).forEach(stopId => {
            const mapData = stopNodeMap[stopId];
            if (!mapData) return;

            const distOnGraph = dijkstraFromDest.nodeDistances.get(mapData.nodeId);
            
            if (distOnGraph !== undefined) {
                const totalDist = mapData.distToNode + distOnGraph + dijkstraFromDest.distanceToNode;
                const duration = Math.ceil(totalDist / WALKING_SPEED);

                cachedGraph.transfers[stopId].push({
                    origin: stopId,
                    destination: destStopId,
                    duration: duration,
                    startTime: currentTime,
                    endTime: Number.MAX_SAFE_INTEGER
                });
            
            }
        });

        const startNodeDist = dijkstraFromOrigin.distanceToNode;
        const endNodeId = dijkstraFromDest.nearestNodeId;
        const endNodeDist = dijkstraFromDest.distanceToNode;
        const graphDistance = dijkstraFromOrigin.nodeDistances.get(endNodeId);
        if (graphDistance){
            cachedGraph.transfers[originStopId].push({
                origin: originStopId,
                destination: destStopId,
                duration: Math.ceil((startNodeDist + graphDistance + endNodeDist) / WALKING_SPEED),
                startTime: currentTime,
                endTime: Number.MAX_SAFE_INTEGER
            });
        }

        RaptorAlgorithm.setDebug(false);
        const raptor = RaptorAlgorithmFactory.create(cachedGraph.trips, cachedGraph.transfers, cachedGraph.interchange);
        raptor.setWalkingPenalty(walkingPenaltyParam ? parseFloat(walkingPenaltyParam as string) : 1);
        
        const resultsFactory = new JourneyFactory();
        const journeyPlanner = new DepartAfterQuery(raptor, resultsFactory);
        const rawJourneys = journeyPlanner.plan(originStopId as StopID, destStopId as StopID, currentTime);

        
        // Helper to format and fetch coords
        const hydrateJourney = async (journey: any) => {
            if (!journey) return null;
            
            const hydratedLegs = await Promise.all(journey.legs.map(async (leg: any) => {
                const formattedLeg: any = {
                    ...leg,
                    origin_id: leg.origin,
                    destination_id: leg.destination,
                    origin: leg.origin === 'VIRTUAL_ORIGIN' ? 'Start' : (leg.origin === 'VIRTUAL_DESTINATION' ? 'End' : (stopIdToName[leg.origin] || leg.origin)),
                    destination: leg.destination === 'VIRTUAL_ORIGIN' ? 'Start' : (leg.destination === 'VIRTUAL_DESTINATION' ? 'End' : (stopIdToName[leg.destination] || leg.destination))
                };

                // If it's a walking leg (no tripId)
                if (!leg.trip || !leg.trip.tripId) {
                formattedLeg.mode = 'walk';
                
                const cacheKey = `${leg.origin}_TO_${leg.destination}`;
                const isVirtual = leg.origin === 'VIRTUAL_ORIGIN' || leg.destination === 'VIRTUAL_DESTINATION';

                if (!isVirtual && walkingCache[cacheKey]) {
                    const cached = walkingCache[cacheKey];
                    formattedLeg.path_coords = cached.path_coords;
                    formattedLeg.distance = cached.distance;
                } 
                else {
                    let legOriginLat, legOriginLon, legDestLat, legDestLon;

                    // Resolve Start Coordinates
                    if (leg.origin === 'VIRTUAL_ORIGIN') {
                        legOriginLat = oLat; legOriginLon = oLon;
                    } else {
                        const stop = cachedStopLocations[leg.origin];
                        legOriginLat = stop.lat; legOriginLon = stop.lon;
                    }

                    // Resolve End Coordinates
                    if (leg.destination === 'VIRTUAL_DESTINATION') {
                        legDestLat = dLat; legDestLon = dLon;
                    } else {
                        const stop = cachedStopLocations[leg.destination];
                        legDestLat = stop.lat; legDestLon = stop.lon;
                    }

                    try {
                        const walkData = await getWalkingResponse(legOriginLat, legOriginLon, legDestLat, legDestLon);
                        formattedLeg.path_coords = walkData.path_coords;
                        formattedLeg.distance = walkData.distance;
                    } catch (e) {
                        console.error("Failed to get walk path", e);
                        formattedLeg.path_coords = []; 
                    }
                }
                } else {
                    formattedLeg.mode = 'bus';
                    // ... existing bus leg logic (calculating duration from stopTimes)
                     if (leg.stopTimes && leg.stopTimes.length > 0) {
                        const first = leg.stopTimes[0];
                        const last = leg.stopTimes[leg.stopTimes.length - 1];
                        formattedLeg.duration = last.arrivalTime - first.departureTime;
                        formattedLeg.rt = first.rt;
                        formattedLeg.vid = leg.vid;
                    }
                }
                return formattedLeg;
            }));

            return { ...journey, legs: hydratedLegs };
        };

        // Logic to pick best 3 (Fastest, Least Transfers, Least Walk)
        let fastest = rawJourneys.length > 0 ? rawJourneys.reduce((best, j) => earliestArrival(best, j) ? j : best, rawJourneys[0]) : null;
        const leastTransfers = rawJourneys.length > 0 ? rawJourneys.reduce((best, j) => leastChanges(best, j) ? j : best, rawJourneys[0]) : null;
        const leastWalk = rawJourneys.length > 0 ? rawJourneys.reduce((best, j) => leastWalking(best, j) ? j : best, rawJourneys[0]) : null;
        
        const distinctJourneys = [fastest, leastTransfers, leastWalk]
            .filter((j, i, arr) => j && arr.findIndex(x => x === j) === i); // Deduplicate

        // Hydrate them in parallel
        const finalJourneys = await Promise.all(distinctJourneys.map(j => hydrateJourney(j)));

        res.json({ journeys: finalJourneys });

    } catch (error) {
        console.error('Error planning journey:', error);
        res.status(500).json({ error: 'Failed to plan journey' });
    }
});

export default router;
