
import * as walking from './walking/walkingMap';
import * as metadata from "./assets/route-data.json";
import * as path from "node:path";
import * as fs from 'fs';

import express from "express";
import dotenv from "dotenv";
import axios from "axios";

import { McRaptorAlgorithm, Journey, JourneyLeg } from "./raptor/McRaptorAlgorithm";
import { MaxPriorityQueue } from '@datastructures-js/priority-queue';

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
} from './busService';

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


// Initialize bus color manager
const busColorManager = new BusColorManager();

dotenv.config();
const router = express.Router();
const routeImages: { [k: string]: string } = metadata.routeImages;

setInterval(updateBusPositions, 7500);
setInterval(getSelectableRoutes, 60000);
setInterval(rebuildGraph, 10 * 1000);
getSelectableRoutes();
rebuildGraph();

import * as process from "node:process";

const message = {
	id: "gradamatation",
	title: "Congrats Grads 🥳",
	message:
		"Congrats to everyone who is gradamatating! Enjoy some grad hats on the buses, and don't forget to celebrate!",
	buildVersion: "99",
};

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
	res.send({ routes: cachedRoutes });
});

router.get('/getrouteCache', (req, res) => {
	res.send({ routes: routeTimingCache });
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
	res.send(JSON.stringify({ version: metadata.metadata.version }));
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
			} else if (distance < heap.front()!.distance) {
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

router.get('/plan-journey', async (req, res) => {
	try {
        const originStopId = 'VIRTUAL_ORIGIN';
        const destStopId = 'VIRTUAL_DESTINATION';

        const { originLat, originLon, destLat, destLon, walkingPenalty: walkingPenaltyParam} = req.query;
        if (!originLat || !originLon || !destLat || !destLon) {
            return res.status(400).json({ error: 'Origin and destination coordinates are required' });
        }

        const oLat = parseFloat(originLat as string);
        const oLon = parseFloat(originLon as string);
        const dLat = parseFloat(destLat as string);
        const dLon = parseFloat(destLon as string);

        const now = new Date();
        const currentTime = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();

        if (!cachedGraph || !cachedGraph.trips || cachedGraph.trips.length === 0) {
            await rebuildGraph();
            if (!cachedGraph) {
                return res.status(404).json({ error: 'No routes available at this time' });
            }
        }

        // Clear all transfers for virtual stops
        cachedGraph.transfers[originStopId] = [];
        cachedGraph.transfers[destStopId] = [];
        Object.keys(cachedGraph.transfers).forEach(stopId => {
            cachedGraph.transfers[stopId] = cachedGraph.transfers[stopId].filter(
                t => t.destination !== destStopId
            );
        });

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

        // Get walking times from origin to all stops
        // Get walking times from all stops to dest
        const walksFromOrigin = walking.getWalkingDistancesFrom(oLat, oLon, dLat, dLon);
        const walksToDest = walking.getWalkingDistancesFrom(dLat, dLon);

        walksFromOrigin.forEach(walk => {
            if (walk.stopId === "DIRECT_WALK") {
                cachedGraph.transfers[originStopId].push({
                    origin: originStopId,
                    destination: destStopId,
                    duration: walk.duration,
                    startTime: currentTime,
                    endTime: Number.MAX_SAFE_INTEGER
                });
            } else {
                cachedGraph.transfers[originStopId].push({
                    origin: originStopId,
                    destination: walk.stopId,
                    duration: walk.duration, 
                    startTime: currentTime,
                    endTime: Number.MAX_SAFE_INTEGER
                });
            }
        });

        walksToDest.forEach(walk => {
            cachedGraph.transfers[walk.stopId].push({
                origin: walk.stopId,
                destination: destStopId,
                duration: walk.duration,
                startTime: currentTime,
                endTime: Number.MAX_SAFE_INTEGER
            });
        });

        const mcRaptor = new McRaptorAlgorithm(cachedGraph.trips, cachedGraph.transfers, cachedGraph.interchange);

        let walkingPenalty = 1;
        if (walkingPenaltyParam !== undefined) {
            const parsed = parseFloat(walkingPenaltyParam as string);
            if (!isNaN(parsed) && parsed > 0) {
                walkingPenalty = parsed;
            }
        }
        mcRaptor.setWalkingPenalty(walkingPenalty);

        let rangeInSeconds = 60*45;
        const { range } = req.query;
        if (range !== undefined) {
            const parsedRange = parseInt(range as string);
            if (!isNaN(parsedRange) && parsedRange > 0) {
                rangeInSeconds = parsedRange * 60;
            }
        }

        let journeys: Journey[];
        if(range !== undefined) {
            journeys = mcRaptor.getOptimizedJourneysInRange(originStopId, destStopId, currentTime, rangeInSeconds);
        } else {
            journeys = mcRaptor.getOptimizedJourneys(originStopId, destStopId, currentTime);
        }
        const processLeg = async (leg: JourneyLeg) => {
            const isWalk = !leg.trip;
            
            const formattedLeg: any = {
                origin_id: leg.origin,
                origin: leg.origin === 'VIRTUAL_ORIGIN' ? 'Start' : (leg.origin === 'VIRTUAL_DESTINATION' ? 'End' : (stopIdToName[leg.origin] || leg.origin)),
                destination_id: leg.destination,
                destination: leg.destination === 'VIRTUAL_DESTINATION' ? 'End' : (stopIdToName[leg.destination] || leg.destination),
                destinationName: leg.destination === 'VIRTUAL_DESTINATION' ? 'End' : (stopIdToName[leg.destination] || leg.destination),
                startTime: Math.round(leg.startTime),
                endTime: Math.round(leg.endTime),
                duration: Math.round(leg.duration),
                mode: isWalk ? 'walk' : 'bus',
                originID: leg.originID,
                destinationID: leg.destinationID,
                stopTimes: leg.stopTimes,
                trip: leg.trip,
                rt: leg.rt
            };

            if (leg.trip) {
                formattedLeg.tripId = leg.trip.tripId;
                formattedLeg.vid = leg.trip.vid;
                if (!formattedLeg.rt) {
                    const firstStop = leg.trip.stopTimes[0];
                    formattedLeg.rt = firstStop.rt || tatripidToRt[leg.trip.tripId] || 'UNKNOWN';
                }
            }

            if (isWalk) {
                const cached = walking.getCachedWalk(leg.origin, leg.destination);
                
                if (cached) {
                    Object.assign(formattedLeg, cached);
                } else {
                    const l1 = leg.origin === 'VIRTUAL_ORIGIN' ? { lat: oLat, lon: oLon } : cachedStopLocations[leg.origin];
                    const l2 = leg.destination === 'VIRTUAL_DESTINATION' ? { lat: dLat, lon: dLon } : cachedStopLocations[leg.destination];

                    if (l1 && l2) {
                        try {
                            const data = await walking.getWalkingResponse(l1.lat, l1.lon, l2.lat, l2.lon);
                            data.duration = Math.round(data.duration);
                            Object.assign(formattedLeg, data);
                        } catch (e) {
                            formattedLeg.path_coords = [];
                        }
                    }
                }
            }

            return formattedLeg;
        };

        const processJourneys = async (journeys: Journey[]) => {
            return Promise.all(journeys.map(async (journey: Journey) => {
                if (!journey) return null;

                const legs = await Promise.all(journey.legs.map(processLeg));

                return {
                    legs,
                    departureTime: journey.criteria.arrivalTime - (legs.reduce((acc, leg) => acc + leg.duration, 0)),
                    arrivalTime: journey.criteria.arrivalTime,
                    criteria: journey.criteria
                };
            }));
        };
        const processedList = await processJourneys(journeys);
        const sortedJourneys = processedList
            .filter((j: any) => j !== null) 
            .sort((a: any, b: any) => 
                a.arrivalTime - b.arrivalTime || 
                a.criteria.walkingDistance - b.criteria.walkingDistance
            );
        res.json({ 
                journeys: sortedJourneys 
        });

    } catch (error) {
        console.error('Error planning journey:', error);
        res.status(500).json({ error: 'Failed to plan journey' });
    }
});


router.get('/save-graph', async (req, res) => {
	if (process.env.DEV_SAVE !== 'true') {
		return res.status(403).json({ error: 'Endpoint only available in DEV mode' });
	}

	try {
		const filePath = path.resolve(process.cwd(), 'saved_graph.json');
		const fullState = {
			graph: cachedGraph,
			stopLocations: cachedStopLocations,
			stopNames: stopIdToName,
			predsByVid: cachedPredsByVid,
			predsByStopId: cachedPredsByStopId
		};
		const data = JSON.stringify(fullState, null, 2);
		fs.writeFileSync(filePath, data);
		res.json({ message: `Graph and state saved to ${filePath}` });
	} catch (error) {
		console.error('Error saving graph:', error);
		res.status(500).json({ error: 'Failed to save graph' });
	}
});

export default router;
