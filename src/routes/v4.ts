/**
 * Changes to the served api that are NOT backwards compatible with mb2 should go here.
 *
 * Try to use documented instead of raw express.
 * @module
 */

import express from 'express';
import * as z from 'zod';
import * as state from '@/state/transitState';
import { BusRouteLineSchema } from '@/services/bustimeCommon';
import { ProcessedJourneySchema, ProcessedJourney } from '@/services/journey';
import * as documented from './documented';

const router = express.Router();
const ctx = documented.globalContext;

documented.addGetRoute(
    ctx, router, '/all-mbus-routes',
    { ...documented.emptyFormat, resBody: z.array(BusRouteLineSchema) },
    async () => documented.makeSuccessResponse(Object.values(state.cachedRoutes).flat(1)),
    { description: 'get all cached route patterns' }
);

documented.addGetRoute(
    ctx, router, '/all-ride-routes',
    { ...documented.emptyFormat, resBody: z.array(BusRouteLineSchema) },
    async () => documented.makeSuccessResponse(Object.values(state.cachedRideRoutes).flat(1)),
    { description: 'get all cached ride route patterns' },
)

documented.addGetRoute(
    ctx, router, '/plan-journey-from-bus',
    {
        ...documented.emptyFormat,
        query: z.object({
            /** route the user is currently riding */
            rt: z.string(),
            /** id of the last stop the bus passed */
            lastStopId: z.string(),
            /** fraction of the way from the last stop to the next stop, from 0 to 1 */
            progress: z.coerce.number<string | undefined>().min(0).max(1),
            destLat: z.coerce.number(),
            destLon: z.coerce.number(),
        }),
        resBody: z.object({ journeys: z.array(ProcessedJourneySchema) }),
    },
    async (_, query) => documented.makeSuccessResponse({ journeys: [makeDummyJourney(query)] }),
    {
        summary: 'Plans a journey starting from a bus the user is already on.',
        description: 'Same response format as `/plan-journey`. '
            + '**Currently a stub:** it returns a sample journey built from the inputs '
    },
);

/**
 * Builds a dummy journey for the `/plan-journey-from-bus` stub:
 * stay on `rt` for 5 minutes, then walk 5 minutes to the destination.
 * TODO: replace with a real planner
 */
function makeDummyJourney(q: {
    rt: string, lastStopId: string, destLat: number, destLon: number,
}): ProcessedJourney {
    const now = new Date();
    const start = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
    const busEnd = start + 5 * 60;
    const end = busEnd + 5 * 60;

    const lastStopName = state.stopIdToName[q.lastStopId] ?? q.lastStopId;
    const lastStopLoc = state.cachedStopLocations[q.lastStopId] ?? { lat: q.destLat, lon: q.destLon };
    const exitStopId = 'DUMMY_EXIT_STOP';
    const exitStopName = 'Dummy Exit Stop';
    const exitStopLoc = { lat: (lastStopLoc.lat + q.destLat) / 2, lon: (lastStopLoc.lon + q.destLon) / 2 };
    const tripId = `DUMMY_FROM_BUS_${q.rt}`;

    const stopTimes = [
        { stop: q.lastStopId, arrivalTime: start, departureTime: start, pickUp: true, dropOff: true },
        { stop: exitStopId, arrivalTime: busEnd, departureTime: busEnd, pickUp: true, dropOff: true },
    ];
    const busPath = [{ lat: lastStopLoc.lat, lon: lastStopLoc.lon }, exitStopLoc];

    return {
        legs: [
            {
                mode: 'bus',
                origin_id: q.lastStopId,
                origin: lastStopName,
                destination_id: exitStopId,
                destination: exitStopName,
                destinationName: exitStopName,
                startTime: start,
                endTime: busEnd,
                duration: busEnd - start,
                busPathSegments: [{ rt: q.rt, path: busPath }],
                stopCoords: busPath.map((location, i) => ({
                    rt: q.rt, location, segmentIdx: 0, idxInSegment: i,
                })),
                stopTimes,
                trip: { tripId, vid: null, stopTimes },
                tripId,
                rt: q.rt,
                vid: null,
            },
            {
                mode: 'walk',
                origin_id: exitStopId,
                origin: exitStopName,
                destination_id: 'VIRTUAL_DESTINATION',
                destination: 'End',
                destinationName: 'End',
                startTime: busEnd,
                endTime: end,
                duration: end - busEnd,
                path_coords: [exitStopLoc, { lat: q.destLat, lon: q.destLon }],
            },
        ],
        departureTime: start,
        arrivalTime: end,
        criteria: { arrivalTime: end, walkingDistance: 0, transferCount: 0 },
    };
}

export default router;
