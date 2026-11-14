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
import { getWalkingResponse } from '@/walking/walkingMap';
import * as documented from './documented';
import { PlanJourneyQuerySchema, PlanWalkingResponseSchema } from './planningSchemas';

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

export const planWalking = documented.addGetRoute(
    ctx, router, '/plan-walking',
    {
        ...documented.emptyFormat,
        query: PlanJourneyQuerySchema,
        resBody: PlanWalkingResponseSchema,
    },
    async (_, { originLat, originLon, destLat, destLon }) => {
        try {
            const data = await getWalkingResponse(originLat, originLon, destLat, destLon);
            return documented.makeSuccessResponse({
                path_coords: data.path_coords,
                duration: Math.round(data.duration),
            });
        } catch (error) {
            console.error('Walking plan error:', error);
            return documented.makeFailureResponse(500, 'Walking planning failed');
        }
    },
    {
        summary: 'Plan a walking path',
        description: 'Returns a walking path on the local walking graph with duration estimated in seconds at 5 km/h. ' +
            'Falls back to a straight line if no graph path is found. ' +
            'walkingPenalty and range are accepted for compatibility with /plan-journey and ignored. ' +
            'Errors return { error: string } with status 400 for invalid query parameters or 500 for unexpected failures.',
    },
);

export default router;
