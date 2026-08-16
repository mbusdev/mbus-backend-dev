import express from "express";
import * as path from "path";
import * as process from "node:process";
import axios from "axios";
import * as z from "zod";
import * as state from '../state/transitState';
import * as meta from '../services/metadata';
import * as journeyService from '../services/journey';
import * as reminderService from '../services/reminder';
import * as graphBuilder from '../services/graphBuilder';
import { startBackgroundJobs } from '../jobs';
import * as documented from "./documented";

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
    const now = new Date();
    const currentTime = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();

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
        const numStops = parseInt(k as string);

        const nearest = graphBuilder.findNearestStops(originLat, originLon, numStops);
        res.json({ nearestStops: nearest });
    } catch (error) {
        console.error('Error in /nearest-stops:', error);
        res.status(400).json({ error: 'Invalid parameters or server error' });
    }
}
router.get('/nearest-stops', getNearestStops);

documented.addGetRoute(
    documented.globalContext, router, '/plan-journey',
    {
        ...documented.emptyFormat,
        query: z.object({
            originLat: z.coerce.number(),
            originLon: z.coerce.number(),
            destLat: z.coerce.number(),
            destLon: z.coerce.number(),
            walkingPenalty: z.optional(z.string())
                .transform((x) => x === undefined ? undefined : parseFloat(x))
                .pipe(z.optional(z.number())),
            range: z.optional(z.string())
                .transform((x) => x === undefined ? undefined : parseInt(x))
                .pipe(z.optional(z.number())),
        }),
        resBody: z.any(),
    },
    async (_, { originLat, originLon, destLat, destLon, walkingPenalty, range }) => {
        try {
            const now = new Date();
            const secondsSinceMidnight = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();

            const results = await journeyService.planJourney(
                originLat, originLon,
                destLat, destLon,
                secondsSinceMidnight,
                { walkingPenalty, range },
            );

            return documented.makeSuccessResponse({ journeys: results });
        } catch (error) {
            console.error("Journey plan error:", error);
            return documented.makeFailureResponse(500, 'Journey planning failed');
        }
    },
    { description: 'Plans a journey between origin and destination coordinates.' },
);

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
        min_supported_version: "2.0.0",
        why_update_message: { title: "Update Needed", subtitle: "You need to update to the latest version for the app to work properly." },
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

const SetReminderBody = z.object({ token: z.string(), stpid: z.string(), rtid: z.string(), thresh: z.number() });
documented.addPostRoute(
    documented.globalContext, router, '/setReminder', { ...documented.emptyFormat, reqBody: SetReminderBody },
    async (_, __, { token, stpid, rtid, thresh }) => {
        const info = reminderService.infoToUseForRoute(rtid);
        if (info === null) {
            return documented.makeFailureResponse(400, `Invalid route ${rtid}`);
        }
        const { reminderSubscriptions, predsByStopId } = info;
        reminderSubscriptions.add(
            reminderService.baseEvent({ stpid, rtid }),
            thresh,
            reminderService.registrationToken(token),
            predsByStopId,
            Date.now(),
        );
        return documented.makeSuccessResponse({});
    }
);

const UnsetReminderBody = z.object({ token: z.string(), stpid: z.string(), rtid: z.string() });
/**
 * @param req - Express request, `UnsetReminderBody` in the body
 * @param res - Express response, error message as string if error occurs
 */
export function unsetReminder(req: express.Request, res: express.Response) {
    const result = UnsetReminderBody.safeParse(req.body);
    if (!result.success) {
        res.status(400);
        res.send(result.error.message);
    } else {
        const { token, stpid, rtid } = result.data;
        const info = reminderService.infoToUseForRoute(rtid);
        if (info === null) {
            res.status(400);
            res.send(`Invalid route ${rtid}`);
            return;
        }
        const { reminderSubscriptions } = info;
        reminderSubscriptions.remove(
            reminderService.baseEvent({ stpid, rtid }), reminderService.registrationToken(token)
        );
        res.sendStatus(200);
    }
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
    const result = SwapTokenBody.safeParse(req.body)
    if (!result.success) {
        res.status(400);
        res.send(result.error.message);
    } else {
        const { oldTok, newTok } = req.body;
        reminderService.universityReminderSubscriptions.swapToken(oldTok, newTok);
        reminderService.rideReminderSubscriptions.swapToken(oldTok, newTok);
        res.sendStatus(200);
    }
}
router.post('/swapToken', swapToken);

const Token = z.string().meta({ id: "Token" })
const ActiveReminder = z.object({
    stpid: z.string(),
    rtid: z.string(),
    thresh: z.number().nullable(),
    eta: z.number().nullable(),
}).meta({ id: "Reminder" });

documented.addGetRoute(
    documented.globalContext, router, '/activeReminders/:token',
    {
        params: z.object({ token: Token }),
        query: z.object(),
        resBody: z.object({ reminders: z.array(ActiveReminder) }),
    },
    async ({ token }, _) => {
        const regTok = reminderService.registrationToken(token);
        const subscriptionInfo = (r: reminderService.PreThreshold | reminderService.PostThreshold) => {
            return {
                stpid: r.event.stpid,
                rtid: r.event.rtid,
                thresh: r.stage === 0 ? r.thresh : null,
                eta: r.stage === 0 ? r.candidateVidPredPrev : r.vidPredPrev
            };
        };
        console.log(`Got request for active reminders of ${token}`);
        const universityReminders = reminderService
            .universityReminderSubscriptions
            .activeRemindersFor(regTok)
            .map(subscriptionInfo);
        const rideReminders = reminderService
            .rideReminderSubscriptions
            .activeRemindersFor(regTok)
            .map(subscriptionInfo);
        return documented.makeSuccessResponse({ reminders: universityReminders.concat(rideReminders) });
    },
    {
        summary: "active reminders",
        description: `big long description idk, gets the reminders associated with a **registration token**, which is gotten from fcm or smth`
    },
)

const ModifyRemindersBody = z.object({
    token: z.string(),
    modifications: z.array(
        z.union([
            z.object({ action: z.literal("set"), stpid: z.string(), rtid: z.string(), thresh: z.number() }),
            z.object({ action: z.literal("unset"), stpid: z.string(), rtid: z.string() })
        ])
    )
});
/** Lets you run the equivalent of several setReminder and unsetReminders in one call
 *  @param req - Express request expecting `ModifyRemindersBody` in body
 *  @param res - Express response
 */
export function modifyReminders(req: express.Request, res: express.Response) {
    const result = ModifyRemindersBody.safeParse(req.body);
    if (!result.success) {
        res.status(400);
        res.send(result.error.message);
    } else {
        const { token, modifications } = result.data;
        for (const modification of modifications) {
            const event = reminderService.baseEvent({ stpid: modification.stpid, rtid: modification.rtid });
            const info = reminderService.infoToUseForRoute(modification.rtid);
            if (info === null) {
                res.status(400);
                res.send(`Invalid route ${modification.rtid}`);
                return;
            }
            const { reminderSubscriptions, predsByStopId } = info;
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
        res.send("registration token missing");
        res.status(400);
        return;
    }
    setTimeout(() => {
        console.log(`sending test push notification to ${registrationToken}`);
        reminderService.sendNotifToAll({ title: "hi", body: "hello world!" }, new Set([registrationToken]));
    }, 0);
    res.sendStatus(200);
}
router.post('/notifyMeLater', notifyMeLater);

const Point = z.object({ x: z.number(), y: z.number() })
    .meta({
        id: "Point",
        description: "increasing `x` represents going northward, increasing `y` represents going eastward",
    });

const LatLon = z.object({ lon: z.number(), lat: z.number() }).meta({ id: "LatLon" });

const Area = z.object({
    polygon: z.array(z.number())
        .meta({ description: 'indexes into `points`, adjacent points (1st and last included) have an edge between them' }),
    classification: z.literal(['hallway', 'classroom', 'bathroom', 'stairway', 'elevator',]),
    label: z.union([
        z.object({ type: z.literal('text'), value: z.string() }),
        z.object({
            type: z.literal('icon'),
            of: z.literal([
                "bathroomWomen", "bathroomMen", "bathroomNeutral", "information",
                "food", "stairs", "escalator", "elevator",
            ])
        })
    ]),
    labelPos: Point,
    doors: z.array(z.number())
        .meta({ description: 'indexes into `polygon`, orientation determined by neighboring edges' }),
}).meta({ id: "Area" });

const FloorPlanVisuals = z.object({
    points: z.array(Point),
    areas: z.array(Area),
    boundingBox: z.object({ sw: LatLon, ne: LatLon }),
}).meta({ id: "FloorPlanVisuals" });
documented.addGetRoute(
    documented.globalContext,
    router, '/indoor/visuals',
    {
        params: z.object({}),
        query: z.object({ buildingId: z.string(), floor: z.coerce.number() }),
        resBody: FloorPlanVisuals,
    },
    async (_, { buildingId, floor }) => {
        const data: z.infer<typeof FloorPlanVisuals> = {
            points: [
                { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 1 }, { x: 3, y: 1 },
                { x: 3, y: 4 }, { x: 2, y: 4 }, { x: 2, y: 3 }, { x: 1, y: 3 }, { x: 1, y: 4 }, { x: 0, y: 4 }
            ],
            areas: [
                {
                    polygon: [0, 1, 2, 3, 4, 5, 6, 8],
                    classification: 'bathroom',
                    label: { type: 'icon', of: 'bathroomNeutral' },
                    labelPos: { x: 0.5, y: 1.25 },
                    doors: [7],
                },
                {
                    polygon: [6, 8, 9, 11, 10, 7],
                    classification: 'classroom',
                    label: { type: 'text', value: '3178' },
                    labelPos: { x: 1.5, y: 3.5 },
                    doors: [4, 5],
                }
            ],
            boundingBox: { sw: { lat: 42.290808, lon: -83.716188 }, ne: { lat: 42.291575, lon: -83.715149 } },
        };
        return documented.makeSuccessResponse(
            data,
        )
    }
)

export default router;