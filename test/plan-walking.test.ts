import express from 'express';
import { describe, it, expect, beforeAll } from 'vitest';

import * as documented from '@/routes/documented';
import router, { planWalking } from '@/routes/v4';
import { PlanWalkingResponseSchema } from '@/routes/planningSchemas';

describe('planWalking', () => {
    const query = { originLat: '0', originLon: '0', destLat: '0', destLon: '0.001' };

    beforeAll(() => {
        if (!documented.ENABLED) {
            throw new Error('documented must be enabled');
        }
        documented.addRouter(documented.globalContext, express(), '/api/v4', router);
    });

    it('should return a straight line and a rounded duration in seconds', async () => {
        const result = await planWalking({ params: {}, query, body: {} });
        expect(result.status).toBe(200);
        // 0.001 degrees along the equator is about 111.2 meters, or 80 seconds at 5 km/h.
        expect(result.json).toEqual({
            path_coords: [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }],
            duration: 80,
        });
        expect(PlanWalkingResponseSchema.parse(result.json)).toEqual(result.json);
    });

    it('should return zero duration for identical coordinates', async () => {
        const result = await planWalking({ params: {}, query: { ...query, destLon: '0' }, body: {} });
        expect(result).toEqual({
            status: 200,
            json: { path_coords: [{ lat: 0, lon: 0 }, { lat: 0, lon: 0 }], duration: 0 },
        });
    });

    it('should accept and ignore walkingPenalty and range', async () => {
        const result = await planWalking({ params: {}, query, body: {} });
        const withOptions = await planWalking({
            params: {}, query: { ...query, walkingPenalty: '8', range: '300' }, body: {},
        });
        expect(withOptions).toEqual(result);
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
        expect(route.description).toContain('straight-line placeholder');
    });
});
