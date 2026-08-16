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
import * as documented from './documented';

const router = express.Router();
const ctx = documented.globalContext;

documented.addGetRoute(
    ctx, router, '/getAllMbusRoutes',
    { ...documented.emptyFormat, resBody: z.array(BusRouteLineSchema) },
    async () => documented.makeSuccessResponse(Object.values(state.cachedRoutes).flat(1)),
    { description: 'get all cached route patterns' }
);

documented.addGetRoute(
    ctx, router, '/getAllRideRoutes',
    { ...documented.emptyFormat, resBody: z.array(BusRouteLineSchema) },
    async () => documented.makeSuccessResponse(Object.values(state.cachedRideRoutes).flat(1)),
    { description: 'get all cached ride route patterns' },
)

export default router;
