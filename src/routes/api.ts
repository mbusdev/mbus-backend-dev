import express from "express";
import * as path from "path";
import * as process from "node:process";
import axios from "axios";
import { getMessaging } from "firebase-admin/messaging";
import * as state from '../state/transitState';
import * as meta from '../services/metadata';
import * as journeyService from '../services/journey';
import * as reminderService from '../services/reminder';
import * as graphBuilder from '../services/graphBuilder';
import { startBackgroundJobs } from '../jobs';

/**
 * Express router for the MBus API v3.
 * Handles routes for static data, state debugging, journey planning, and startup info.
 */
const router = express.Router();
const API_KEY = process.env.MBUS_API_KEY;

startBackgroundJobs();

/**
 * Returns static route metadata including names, images, and colors.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON object containing `routeIdToName`, `routeImages`, `metadata`, and `routeColors`.
 */
export function getRouteInformation(req: express.Request, res: express.Response) {
    res.json({
        routeIdToName: meta.staticData.routeIdToName,
        routeImages: meta.staticData.routeImages,
        metadata: meta.staticData.metadata,
        routeColors: meta.getAllRouteConfig()
    });
}
router.get('/getRouteInformation', getRouteInformation);

/**
 * Returns a list of all selectable routes with their names and colors.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON object with a `bustime-response` containing a list of routes.
 */
export function getSelectableRoutes(req: express.Request, res: express.Response) {
    const routes = meta.getAllRouteConfig().map(r => ({
        rt: r.routeId,
        rtnm: (meta.staticData.routeIdToName as any)[r.routeId] || r.routeId,
        rtclr: r.color,
    }));
    res.json({ "bustime-response": { "routes": routes } });
}
router.get('/getSelectableRoutes', getSelectableRoutes);

/**
 * Returns the current version of the route information.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON object with the `version` string.
 */
export function getRouteInfoVersion(req: express.Request, res: express.Response) {
    res.send(JSON.stringify({ version: meta.staticData.metadata.version }));
}
router.get('/getRouteInfoVersion', getRouteInfoVersion);

/**
 * Returns configuration (colors and images) for all routes.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON object with a `routes` array containing route configs.
 */
export function getRouteColors(req: express.Request, res: express.Response) {
    res.json({ routes: meta.getAllRouteConfig() });
}
router.get('/getRouteColors', getRouteColors);

/**
 * Returns the color and image for a specific route ID.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON object with `routeId`, `color`, and `image`.
 */
export function getRouteColor(req: express.Request, res: express.Response) {
    const { routeId } = req.params;
    const color = meta.getRouteColor(routeId);
    const image = meta.getRouteImage(routeId);

    if (!color) {
        res.status(404).json({ error: `Route '${routeId}' not found` });
        return;
    }

    res.json({ routeId, color, image });
}
router.get('/getRouteColor/:routeId', getRouteColor);

/**
 * Returns aggregated data for the frontend, including route configs and metadata.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON object with `routes` (array of route details) and `metadata`.
 */
export function getFrontendData(req: express.Request, res: express.Response) {
    try {
        const routes = meta.getAllRouteConfig();
        res.json({
            routes: routes.map(route => ({
                routeId: route.routeId,
                name: (meta.staticData.routeIdToName as any)[route.routeId] || route.routeId,
                image: route.image,
                color: route.color,
                imageUrl: `/mbus/api/v3/getVehicleImage/${route.routeId}`
            })),
            metadata: {
                ...meta.staticData.metadata,
                lastUpdated: new Date().toISOString()
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get frontend data' });
    }
}
router.get('/getFrontendData', getFrontendData);

/**
 * Serves the image file for a specific route.
 * @param req - Express request
 * @param res - Express response
 * @returns Image file (PNG).
 */
export function getVehicleImage(req: express.Request, res: express.Response) {
    const { route } = req.params;
    const assetPath = path.resolve(process.cwd(), 'src/assets/main2025');

    const image = meta.getRouteImage(route);
    if (!image) {
        res.status(400).sendFile(path.join(assetPath, 'bus_CN.png'));
        return;
    }
    res.sendFile(path.join(assetPath, image), (err) => {
        if (err && !res.headersSent) res.status(404).send('Image file not found.');
    });
}
router.get('/getVehicleImage/:route', getVehicleImage);

/**
 * Serves the building locations JSON file.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON file containing building data.
 */
export function getBuildingLocations(req: express.Request, res: express.Response) {
    res.sendFile(path.resolve(process.cwd(), 'src/assets/building-data.json'));
}
router.get('/getBuildingLocations', getBuildingLocations);

/**
 * Returns current positions of all michgan buses.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON object with `buses` array.
 */
export function getBusPositions(req: express.Request, res: express.Response) {
    res.json(state.curBusPositions);
}
router.get('/getBusPositions', getBusPositions);

/**
 * Alias for getBusPositions.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON object with `buses` array.
 */
export function getVehiclePositions(req: express.Request, res: express.Response) {
    res.json(state.curBusPositions);
}
router.get('/getVehiclePositions', getVehiclePositions);


/**
 * returns positions of all ride busses
 * @param req - Express request
 * @param res - Express response
 * @returns JSON object with `buses` array.
 */
export function getRidePositions(req: express.Request, res: express.Response) {
    res.json(state.curRidePositions);
}
router.get('/getRidePositions', getRidePositions);

/**
 * Returns all cached route patterns.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON object with `routes` mapping route IDs to patterns.
 */
export function getAllRoutes(req: express.Request, res: express.Response) {
    res.json({ routes: state.cachedRoutes });
}
router.get('/getAllRoutes', getAllRoutes);

/**
 * Returns all cached ride route patterns.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON object with `routes` mapping route IDs to patterns.
 */
export function getAllRideRoutes(req: express.Request, res: express.Response) {
    res.json({ routes: state.cachedRideRoutes });
}
router.get('/getAllRideRoutes', getAllRideRoutes);

/**
 * Returns the route timing cache used for extrapolation.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON object with `routes` containing timing data.
 */
export function getRouteCache(req: express.Request, res: express.Response) {
    res.send({ routes: state.routeTimingCache });
}
router.get('/getrouteCache', getRouteCache);

/**
 * Returns predictions for a specific bus ID.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON object with `bustime-response` containing `prd` (predictions).
 */
export function getBusPredictions(req: express.Request, res: express.Response) {
    const preds = state.cachedPredsByVid[req.params.busId] || [];
    res.json({ "bustime-response": { "prd": preds } });
}
router.get('/getBusPredictions/:busId', getBusPredictions);


/**
 * Returns predictions for a specific ride bus ID.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON object with `bustime-response` containing `prd` (predictions).
 */
export function getRidePredictions(req: express.Request, res: express.Response) {
    const preds = state.cachedRidePredsByVid[req.params.busId] || [];
    res.json({ "bustime-response": { "prd": preds } });
}
router.get('/getRidePredictions/:busId', getRidePredictions);

/**
 * Legacy/test endpoint for bus predictions.
 * @param req - Express request
 * @param res - Express response
 */
export function getBusPredictionsLegacy(req: express.Request, res: express.Response) {
    const url = `https://mbus.ltp.umich.edu/bustime/api/v3/getpredictions?requestType=getpredictions&locale=en&vid=${req.params.busId}&top=4&tmres=s&rtpidatafeed=bustime&key=${API_KEY}&format=json&xtime=1626028950462`;
    axios.get(url).then(apiRes => {
        res.send(apiRes.data);
    }).catch(err => {
        console.log(err);
        res.sendStatus(500);
    });
}
router.get('/getBusPredictions1/:busId', getBusPredictionsLegacy);

/**
 * Returns predictions for a specific stop ID.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON object with `bustime-response` containing `prd` (predictions).
 */
export function getStopPredictions(req: express.Request, res: express.Response) {
    const preds = state.cachedPredsByStopId[req.params.stopId] || [];
    res.json({ "bustime-response": { "prd": preds } });
}
router.get('/getStopPredictions/:stopId', getStopPredictions);

/**
 * Returns predictions for a specific ride stop ID.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON object with `bustime-response` containing `prd` (predictions).
 */
export function getRideStopPredictions(req: express.Request, res: express.Response) {
    const preds = state.cachedRidePredsByStopId[req.params.stopId] || [];
    res.json({ "bustime-response": { "prd": preds } });
}
router.get('/getRideStopPredictions/:stopId', getRideStopPredictions);

/**
 * Returns all active bus predictions grouped by vehicle ID.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON array of objects, each with `vid` and `stops` (predictions).
 */
export function getAllPredictions(req: express.Request, res: express.Response) {
    const allPreds = Object.entries(state.cachedPredsByVid).map(([vid, preds]) => ({
        vid,
        stops: preds
    }));
    res.json(allPreds);
}
router.get('/getAllPredictions', getAllPredictions);

/**
 * Returns a list of all known stops with their locations.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON array of stop objects.
 */
export function getAllStops(req: express.Request, res: express.Response) {
    const stopsList = Object.entries(state.cachedStopLocations).map(([stpid, stopInfo]) => ({
        stpid,
        ...stopInfo,
    }));
    res.json(Object.values(stopsList));
}
router.get('/getAllStops', getAllStops);


/**
 * Returns a list of all known stops with their locations.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON array of stop objects.
 */
export function getAllRideStops(req: express.Request, res: express.Response) {
    const stopsList = Object.entries(state.cachedRideStopLocations).map(([stpid, stopInfo]) => ({
        stpid,
        ...stopInfo,
    }));
    res.json(Object.values(stopsList));
}
router.get('/getAllRideStops', getAllRideStops);

/**
 * Returns the nearest k stops to a given latitude and longitude.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON object with `nearestStops` array.
 */
export function getNearestStops(req: express.Request, res: express.Response) {
    try {
        const { lat, lon, k = '2' } = req.query;
        const originLat = parseFloat(lat as string);
        const originLon = parseFloat(lon as string);
        const numStops = parseInt(k as string);

        const nearest = graphBuilder.findNearestStops(originLat, originLon, numStops);
        res.json({ nearestStops: nearest });
    } catch (error) {
        console.error('Error in /nearest-stops:', error);
        res.status(400).json({ error: 'Invalid parameters or server error' });
    }
}
router.get('/nearest-stops', getNearestStops);

/**
 * Plans a journey between origin and destination coordinates.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON object with `journeys` array containing possible routes.
 */
export async function planJourney(req: express.Request, res: express.Response) {
    try {
        const { originLat, originLon, destLat, destLon, walkingPenalty, range } = req.query;

        if (!originLat || !originLon || !destLat || !destLon) {
            res.status(400).json({ error: 'coordinates are required' });
            return;
        }

        const now = new Date();
        const secondsSinceMidnight = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();

        const results = await journeyService.planJourney(
            parseFloat(originLat as string), parseFloat(originLon as string),
            parseFloat(destLat as string), parseFloat(destLon as string),
            secondsSinceMidnight,
            {
                walkingPenalty: walkingPenalty ? parseFloat(walkingPenalty as string) : undefined,
                range: range ? parseInt(range as string) : undefined
            }
        );

        res.json({ journeys: results });
    } catch (error) {
        console.error("Journey plan error:", error);
        res.status(500).json({ error: 'Journey planning failed' });
    }
}
router.get('/plan-journey', planJourney);

/**
 * Saves the current graph state to a file (DEV mode only).
 * @param req - Express request
 * @param res - Express response
 * @returns JSON message confirming the save path.
 */
export async function saveGraph(req: express.Request, res: express.Response) {
    if (process.env.DEV_SAVE !== 'true') {
        res.status(403).json({ error: 'Endpoint only available in DEV mode' });
        return;
    }
    try {
        const path = graphBuilder.saveGraphState();
        res.json({ message: `Graph and state saved to ${path}` });
    } catch (error) {
        console.error('Error saving graph:', error);
        res.status(500).json({ error: 'Failed to save graph' });
    }
}
router.get('/save-graph', saveGraph);

/**
 * Returns startup configuration info including supported versions and messages.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON object with version info and messages.
 */
export function getStartupInfo(req: express.Request, res: express.Response) {
    res.json({
        min_supported_version: "1.0.0",
        why_update_message: { title: "New Update Available", subtitle: "Please update to the latest version." },
        persistant_message: { title: "", subtitle: "" },
        one_time_message: { title: "", subtitle: "" },
        bus_image_version: "1",
    });
}
router.get('/getStartupInfo', getStartupInfo);

/**
 * Returns special startup messages (e.g., holiday greetings).
 * @param req - Express request
 * @param res - Express response
 * @returns JSON object with message details.
 */
export function getStartupMessages(req: express.Request, res: express.Response) {
    res.json({
        id: "gradamatation",
        title: "Congrats Grads 🥳",
        message: "Congrats to everyone who is gradamatating! Enjoy some grad hats on the buses, and don't forget to celebrate!",
        buildVersion: '99'
    });
}
router.get('/get-startup-messages', getStartupMessages);

/**
 * Returns key stops.
 * @param req - Express request
 * @param res - Express response
 * @returns JSON object with message details.
 */
export function getKeyStops(req: express.Request, res: express.Response) {
    const KEY_STOPS = {
        // Key stops are shown larger in the list of upcoming stops for each bus.
        "C250": "Central Campus Transit Center", // South side CCTC
        "C251": "Central Campus Transit Center", // North side CCTC
        "N551": "Pierpont Commons", // Murfin Inbound, to Central Campus
        "N553": "Pierpont Commons", // Bonisteel Inbound, to central campus
        "N552": "Pierpont Commons", // Art & Architecture: Eastbound to FXB
        "N550": "Pierpont Commons", // Murfin Outbound, to Bursley
        "N407": "Bursley Hall", // Bursley Hall Inbound (Westbound)
        "N408": "Bursley Hall", // Bursley Hall Outbound (Eastbound)
        "N406": "FXB Building", // FXB Outbound (Northbound)
        "N405": "FXB Building", // FXB Inbound (Southbound)
        "S003": "Crisler Center/Michigan Stadium", // Transportation Gate (Northbound)
        "S002": "Crisler Center/Michigan Stadium", // Crisler Center Lot SC-5 (Southbound)
        "C206": "Oxford Housing", // Self-explanatory
        "M323": "Wall Street Parking Structure",
        "N422": "Northwood Fire Station", // "Top" of Northwood route
        "N437": "Northwood V",
    };
    res.send(KEY_STOPS);
}
router.get('/get-key-stops', getKeyStops);

// Notifications / Reminders

/**
 * @param req - Express request, expects {token: string, stpid: string, rtid: string, thresh: number} in the body
 * @param res - Express response, 200 if success
 */
export function setReminder(req: express.Request, res: express.Response) {
    const token = req.body.token as reminderService.RegistrationToken;
    const stpid: string = req.body.stpid;
    const rtid: string = req.body.rtid;
    const thresh: number = req.body.thresh;
    reminderService.reminderSubscriptions.add({ stpid, rtid } as reminderService.Event, thresh, token);
    res.sendStatus(200);
}
router.post('/setReminder', setReminder);

/**
 * @param req - Express request, expects {token: string, stpid: string, rtid: string} in the body
 * @param res - Express response, 200 if success
 */
export function unsetReminder(req: express.Request, res: express.Response) {
    const token = req.body.token as reminderService.RegistrationToken;
    const stpid: string = req.body.stpid;
    const rtid: string = req.body.rtid;
    reminderService.reminderSubscriptions.remove({ stpid, rtid } as reminderService.Event, token);
    res.sendStatus(200);
}
router.post('/unsetReminder', unsetReminder);

/**
 * @param req - Express request, expects {oldTok: string, newTok: string} in the body
 * @param res - Express response, 200 if success
 * 
 * Upon responding with 200, future calls to /setReminder, /unsetReminder, and /activeReminders
 * will need the new token
 */
export function swapToken(req: express.Request, res: express.Response) {
    const oldTok = req.body.oldTok as reminderService.RegistrationToken;
    const newTok = req.body.newTok as reminderService.RegistrationToken;
    reminderService.reminderSubscriptions.swapToken(oldTok, newTok);
    res.sendStatus(200);
}
router.post('/swapToken', swapToken);

/**
 * @param req - Express request, token is path encoded
 * @param res - Express response with
 * { reminders: Array<{ stpid: string, rtid: string, thresh: number | null }> } as the body
 */
export function activeRemindersForToken(req: express.Request, res: express.Response) {
    const token = req.params.registrationToken as reminderService.RegistrationToken;
    console.log(`Got request for active reminders of ${token}`);
    res.status(200);
    res.send({ reminders: reminderService.reminderSubscriptions.activeRemindersFor(token) });
}
router.get('/activeReminders/:registrationToken', activeRemindersForToken);

/** Lets you run the equivalent of several setReminder and unsetReminders in one call
 *  @param req - Express request expecting
 *      {
 *          token: string,
 *          modifications: Array<
 *              { action: "set", stpid: string, rtid: string, thresh: number }
 *              | { action: "unset", stpid: string, rtid: string }
 *          >
 *      }
 *  @param res - Express response, 200 if success
 */
export function modifyReminders(req: express.Request, res: express.Response) {
    const token = req.body.token as reminderService.RegistrationToken;
    const modifications = req.body.modifications as Array<
        { action: "set", stpid: string, rtid: string, thresh: number }
        | { action: "unset", stpid: string, rtid: string }
    >;
    for (const modification of modifications) {
        const event = { stpid: modification.stpid, rtid: modification.rtid } as reminderService.Event;
        if (modification.action == "set") {
            reminderService.reminderSubscriptions.add(event, modification.thresh, token);            
        } else {
            reminderService.reminderSubscriptions.remove(event, token);
        }
    }
    res.sendStatus(200);
}
router.post('/modifyReminders', modifyReminders);

// testing purposes
router.post('/notifyMeLater', (req, res) => {
    console.log("got request");
    const registrationToken = req.body.token;
    if (registrationToken === undefined) {
        console.log("got request with no token");
        console.log(req.body);
        res.send("registration token missing");
        res.status(400);
        return;
    }
    setTimeout(() => {
        console.log("sending push notification..");
        getMessaging()
            .send({ notification: { title: "hi", body: "hello world!" }, token: registrationToken })
            .catch((e) => console.log("Failed to send message: ", e));
    }, 10000);
    res.sendStatus(200);
});

export default router;