import express from "express";
import * as path from "path";
import { fileURLToPath } from "url";
import * as process from "node:process";
import axios from "axios";
import * as z from "zod";
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

// Under vitest, tests import the handlers directly and must not spin up the
// polling loops (network fetches, Firebase init).
if (process.env.VITEST !== 'true') {
    startBackgroundJobs();
}

// Assets resolve relative to this module, not process.cwd(), so the server
// works regardless of the directory it is launched from.
const ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets');

/** Parses a request body against a zod schema, answering 400 on failure. */
function parseBody<S extends z.ZodTypeAny>(schema: S, req: express.Request, res: express.Response): z.infer<S> | null {
    const result = schema.safeParse(req.body);
    if (!result.success) {
        res.status(400).send(result.error.message);
        return null;
    }
    return result.data;
}

/** Answers a route-lookup miss. When either feed's route set is still empty
 *  (startup window, a single-feed outage, or DEV_CACHE mode) an unknown rtid
 *  cannot be distinguished from a not-yet-loaded one, so signal a retryable
 *  503; only with both feeds loaded is it a genuine 400. */
function respondUnknownRoute(rtid: string, res: express.Response): void {
    if (state.validRoutes.size === 0 || state.validRideRoutes.size === 0) {
        res.status(503).send(`Route data for ${rtid} is unavailable right now; retry shortly`);
    } else {
        res.status(400).send(`Invalid route ${rtid}`);
    }
}

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
    const assetPath = path.join(ASSETS_DIR, 'main2025');

    const image = meta.getRouteImage(route);
    if (!image) {
        // 400 marks the route as unknown (clients rely on the status; see
        // test/api.test.ts) while still sending the default icon as the body.
        res.status(400).sendFile(path.join(assetPath, 'bus_CN.png'), (err) => {
            if (err && !res.headersSent) res.status(404).send('Image file not found.');
        });
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
    res.sendFile(path.join(ASSETS_DIR, 'building-data.json'));
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
    // Params go through URLSearchParams: the path param is user-controlled and
    // must not be interpolated into a query string that carries the API key.
    const base = process.env.MBUS_URL || 'https://mbus.ltp.umich.edu/bustime/api/v3/';
    const params = new URLSearchParams({
        requestType: 'getpredictions',
        locale: 'en',
        vid: req.params.busId,
        top: '4',
        tmres: 's',
        rtpidatafeed: 'bustime',
        key: API_KEY ?? '',
        format: 'json',
    });
    axios.get(`${base.replace(/\/$/, '')}/getpredictions?${params.toString()}`).then(apiRes => {
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
    // Use the graph's own time frame so countdowns stay correct in the window
    // after 00:00 UTC while the cached graph still holds pre-midnight times.
    const currentTime = graphBuilder.currentGraphTimeSeconds();

    const reconstructed = state.cachedGraph.trips
        .filter(t => t.vid)
        .map(t => ({
            vid: t.vid,
            stops: t.stopTimes.map(st => ({
                stpid: st.stop,
                stpnm: state.stopIdToName[st.stop] || "Unknown", // Re-lookup name
                rt: st.rt,
                prdctdn: Math.max(0, Math.floor((st.arrivalTime - currentTime) / 60)).toString()
            }))
        }));

    res.json(reconstructed);
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
        const parsedK = parseInt(k as string);
        const numStops = Number.isFinite(parsedK) && parsedK > 0 ? parsedK : 2;

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

        const oLat = parseFloat(originLat as string);
        const oLon = parseFloat(originLon as string);
        const dLat = parseFloat(destLat as string);
        const dLon = parseFloat(destLon as string);
        if (![oLat, oLon, dLat, dLon].every(Number.isFinite)) {
            res.status(400).json({ error: 'coordinates must be numeric' });
            return;
        }

        const penalty = walkingPenalty !== undefined ? parseFloat(walkingPenalty as string) : undefined;
        if (penalty !== undefined && (!Number.isFinite(penalty) || penalty < 0)) {
            res.status(400).json({ error: 'walkingPenalty must be a non-negative number' });
            return;
        }

        const rangeSeconds = range !== undefined ? parseInt(range as string) : undefined;
        if (rangeSeconds !== undefined && (!Number.isFinite(rangeSeconds) || rangeSeconds < 0)) {
            res.status(400).json({ error: 'range must be a non-negative number of seconds' });
            return;
        }

        // Time in the cached graph's frame (see currentGraphTimeSeconds).
        const secondsSinceMidnight = graphBuilder.currentGraphTimeSeconds();

        const results = await journeyService.planJourney(
            oLat, oLon, dLat, dLon,
            secondsSinceMidnight,
            { walkingPenalty: penalty, range: rangeSeconds }
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
        // Matches main: 2.0.2 locks out client versions with a shipped bug.
        min_supported_version: "2.0.2",
        why_update_message: { title: "Update Needed", subtitle: "You need to update to the latest version for the app to work properly." },
        persistant_message: { title: "", subtitle: ""},
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

// thresh is minutes: unbounded values (negative, 0, absurd) create reminders
// whose trigger condition can never be satisfied.
const ReminderThresh = z.number().min(1).max(120);
const SetReminderBody = z.object({ token: z.string(), stpid: z.string().min(1), rtid: z.string().min(1), thresh: ReminderThresh });
/**
 * @param req - Express request, expects `SetReminderBody` in the body
 * @param res - Express response, error message as string if error occurs
 */
export function setReminder(req: express.Request, res: express.Response) {
    const body = parseBody(SetReminderBody, req, res);
    if (body === null) return;

    const { token, stpid, rtid, thresh } = body;
    const info = reminderService.infoToUseForRoute(rtid);
    if (info === null) {
        respondUnknownRoute(rtid, res);
        return;
    }
    const { reminderSubscriptions, predsByStopId } = info;
    reminderSubscriptions.add(
        reminderService.baseEvent({ stpid, rtid }),
        thresh,
        reminderService.registrationToken(token),
        predsByStopId,
        Date.now(),
    );
    res.sendStatus(200);
}
router.post('/setReminder', setReminder);

const UnsetReminderBody = z.object({ token: z.string(), stpid: z.string(), rtid: z.string() });
/**
 * @param req - Express request, `UnsetReminderBody` in the body
 * @param res - Express response, error message as string if error occurs
 */
export function unsetReminder(req: express.Request, res: express.Response) {
    const body = parseBody(UnsetReminderBody, req, res);
    if (body === null) return;

    const { token, stpid, rtid } = body;
    const info = reminderService.infoToUseForRoute(rtid);
    if (info === null) {
        respondUnknownRoute(rtid, res);
        return;
    }
    const { reminderSubscriptions } = info;
    reminderSubscriptions.remove(
        reminderService.baseEvent({ stpid, rtid }), reminderService.registrationToken(token)
    );
    res.sendStatus(200);
}
router.post('/unsetReminder', unsetReminder);

const SwapTokenBody = z.object({ oldTok: z.string(), newTok: z.string() });
/**
 * @param req - Express request, `SwapTokenBody` in the body
 * @param res - Express response, error message as string if error occurs
 * 
 * Upon responding with 200, future calls to /setReminder, /unsetReminder, and /activeReminders
 * will need the new token
 */
export function swapToken(req: express.Request, res: express.Response) {
    const body = parseBody(SwapTokenBody, req, res);
    if (body === null) return;

    // From the validated data, not the raw req.body.
    const from = reminderService.registrationToken(body.oldTok);
    const to = reminderService.registrationToken(body.newTok);
    reminderService.universityReminderSubscriptions.swapToken(from, to);
    reminderService.rideReminderSubscriptions.swapToken(from, to);
    res.sendStatus(200);
}
router.post('/swapToken', swapToken);

export interface ActiveReminderInfo {
    stpid: string
    rtid: string
    thresh: number | null
    eta: number | null
};

/**
 * @param req - Express request, token is path encoded
 * @param res - Express response 
 */
export function activeRemindersForToken(
    req: express.Request,
    res: express.Response<{ reminders: Array<ActiveReminderInfo> }>
) {
    const subscriptionInfo = (r: reminderService.PreThreshold | reminderService.PostThreshold):
        ActiveReminderInfo =>
    {
        return {
            stpid: r.event.stpid,
            rtid: r.event.rtid,
            thresh: r.stage === 0 ? r.thresh : null,
            eta: r.stage === 0 ? r.candidateVidPredPrev : r.vidPredPrev
        };
    };
    const token = reminderService.registrationToken(req.params.registrationToken);
    console.log(`Got request for active reminders of ${token}`);
    res.status(200);
    const universityReminders = reminderService
        .universityReminderSubscriptions
        .activeRemindersFor(token)
        .map(subscriptionInfo);
    const rideReminders = reminderService
        .rideReminderSubscriptions
        .activeRemindersFor(token)
        .map(subscriptionInfo);
    res.send({
        reminders: universityReminders.concat(rideReminders)
    });
}
router.get('/activeReminders/:registrationToken', activeRemindersForToken);

const ModifyRemindersBody = z.object({
    token: z.string(),
    modifications: z.array(
        z.union([
            z.object({ action: z.literal("set"), stpid: z.string().min(1), rtid: z.string().min(1), thresh: ReminderThresh }),
            z.object({ action: z.literal("unset"), stpid: z.string(), rtid: z.string() })
        ])
    )
});
/** Lets you run the equivalent of several setReminder and unsetReminders in one call
 *  @param req - Express request expecting `ModifyRemindersBody` in body
 *  @param res - Express response
 */
export function modifyReminders(req: express.Request, res: express.Response) {
    const parsed = parseBody(ModifyRemindersBody, req, res);
    if (parsed === null) return;
    {
        const { token, modifications } = parsed;
        // Validate every route before applying anything, so a bad entry cannot
        // leave the batch half-applied.
        const infos = modifications.map(m => reminderService.infoToUseForRoute(m.rtid));
        const badIndex = infos.findIndex(info => info === null);
        if (badIndex !== -1) {
            respondUnknownRoute(modifications[badIndex].rtid, res);
            return;
        }
        for (let i = 0; i < modifications.length; i++) {
            const modification = modifications[i];
            const event = reminderService.baseEvent({ stpid: modification.stpid, rtid: modification.rtid });
            const { reminderSubscriptions, predsByStopId } = infos[i]!;
            if (modification.action == "set") {
                reminderSubscriptions.add(
                    event,
                    modification.thresh,
                    reminderService.registrationToken(token),
                    predsByStopId,
                    Date.now()
                );            
            } else {
                reminderSubscriptions.remove(
                    event, reminderService.registrationToken(token)
                );
            }
        }
        res.sendStatus(200);
    }
}
router.post('/modifyReminders', modifyReminders);

// testing purposes
export function notifyMeLater(req: express.Request, res: express.Response) {
    console.log("got notifyMeLater request");
    const registrationToken = req.body.token;
    if (registrationToken === undefined) {
        console.log("got request with no token");
        console.log(req.body);
        // status must be set before send: send() flushes the response.
        res.status(400).send("registration token missing");
        return;
    }
    setTimeout(() => {
        console.log(`sending test push notification to ${registrationToken}`);
        reminderService.sendNotifToAll({ title: "hi", body: "hello world!"}, new Set([registrationToken]));
        // 10s so the tester can background/close the app first: the endpoint
        // exists to exercise background push delivery.
    }, 10_000);
    res.sendStatus(200);
}
router.post('/notifyMeLater', notifyMeLater);

export default router;