import express from 'express';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

import * as documented from '@/routes/documented';
import router, { planWalking } from '@/routes/v4';
import { PlanWalkingResponseSchema } from '@/routes/planningSchemas';
import * as walking from '@/walking/walkingMap';

describe('planWalking', () => {
    const query = {
        originLat: '42.264356', originLon: '-83.744354', destLat: '42.268068', destLon: '-83.747307',
    };

    beforeAll(() => {
        if (!documented.ENABLED) {
            throw new Error('documented must be enabled');
        }
        documented.addRouter(documented.globalContext, express(), '/api/v4', router);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should return walking path coordinates and a rounded duration in seconds', async () => {
        const data = {
            path_coords: [
                { lat: 42.264356, lon: -83.744354 },
                { lat: 42.2665, lon: -83.745 },
                { lat: 42.268068, lon: -83.747307 },
            ],
            distance: 552.2,
            duration: 397.6,
        };
        const getWalkingResponse = vi.spyOn(walking, 'getWalkingResponse').mockResolvedValue(data);
        const result = await planWalking({ params: {}, query, body: {} });
        expect(getWalkingResponse).toHaveBeenCalledWith(42.264356, -83.744354, 42.268068, -83.747307);
        expect(result.status).toBe(200);
        expect(result.json).toEqual({ path_coords: data.path_coords, duration: 398 });
        expect(data.duration).toBe(397.6);
        expect(PlanWalkingResponseSchema.parse(result.json)).toEqual(result.json);
    });

    it('should return zero duration for identical coordinates', async () => {
        const result = await planWalking({
            params: {}, query: { ...query, destLat: query.originLat, destLon: query.originLon }, body: {},
        });
        expect(result).toEqual({
            status: 200,
            json: {
                path_coords: [{ lat: 42.264356, lon: -83.744354 }, { lat: 42.264356, lon: -83.744354 }],
                duration: 0,
            },
        });
    });

    it('should accept and ignore walkingPenalty and range', async () => {
        const data = await walking.getWalkingResponse(42.264356, -83.744354, 42.268068, -83.747307);
        const result = await planWalking({ params: {}, query, body: {} });
        const withOptions = await planWalking({
            params: {}, query: { ...query, walkingPenalty: '8', range: '300' }, body: {},
        });
        expect(withOptions).toEqual(result);
        expect(result.json).toEqual({ path_coords: data.path_coords, duration: Math.round(data.duration) });
    });

    it('should return 500 when walking planning fails', async () => {
        vi.spyOn(walking, 'getWalkingResponse').mockRejectedValue(new Error('Routing failed'));
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const result = await planWalking({ params: {}, query, body: {} });
        expect(result).toEqual({ status: 500, json: { error: 'Walking planning failed' } });
    });

    it.each(['originLat', 'originLon', 'destLat', 'destLon'])('should reject missing %s', async (field) => {
        const result = await planWalking({ params: {}, query: { ...query, [field]: undefined }, body: {} });
        expect(result).toMatchObject({
            status: 400,
            json: { error: expect.stringContaining(field) },
        });
    });

    it.each(['originLat', 'originLon', 'destLat', 'destLon', 'walkingPenalty', 'range'])(
        'should reject nonnumeric %s',
        async (field) => {
            const result = await planWalking({ params: {}, query: { ...query, [field]: 'invalid' }, body: {} });
            expect(result).toMatchObject({
                status: 400,
                json: { error: expect.stringContaining(field) },
            });
        },
    );

    it('should document the v4 path, query parameters, and response format', () => {
        const spec = documented.docsFor(documented.globalContext);
        const route = spec.paths['/api/v4/plan-walking'].get!;
        expect(route.parameters.map(({ name, required }) => ({ name, required }))).toEqual([
            { name: 'originLat', required: true },
            { name: 'originLon', required: true },
            { name: 'destLat', required: true },
            { name: 'destLon', required: true },
            { name: 'walkingPenalty', required: false },
            { name: 'range', required: false },
        ]);
        expect(route.responses['200'].content?.['application/json'].schema).toEqual({
            $ref: '#/components/schemas/PlanWalkingResponse',
        });
        expect(spec.components.schemas.PlanWalkingResponse).toMatchObject({
            type: 'object',
            required: ['path_coords', 'duration'],
            properties: {
                path_coords: { type: 'array', items: { $ref: '#/components/schemas/LatLon' } },
                duration: { type: 'number' },
            },
        });
        expect(route.description).toContain('local walking graph');
        expect(route.description).toContain('Falls back to a straight line');
    });
});
