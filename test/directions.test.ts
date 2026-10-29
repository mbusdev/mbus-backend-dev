import * as z from 'zod';
import { describe, it, expect } from 'vitest';
import {
    Directions,
    DirectionsSchema,
    DirectionStepSchema,
    TurnDirectionSchema,
} from '../src/walking/directions';

const base = { path_index: 0, distance: 10, onto: null, landmark: null };

const example: Directions = [
    { type: 'depart', path_index: 0, distance: 40, onto: 'State St', landmark: null },
    { type: 'turn', direction: 'left', path_index: 5, distance: 20, onto: null, landmark: 'Hatcher Library' },
    { type: 'continue', path_index: 7, distance: 10, onto: 'Diag', landmark: null },
    { type: 'cross', street: 'S University Ave', path_index: 8, distance: 15, onto: null, landmark: null },
    { type: 'arrive', path_index: 12, distance: 0, onto: null, landmark: null },
];

describe('DirectionsSchema', () => {
    it('parses a full set of directions unchanged', () => {
        expect(DirectionsSchema.parse(example)).toEqual(example);
    });

    it('survives a JSON round trip', () => {
        expect(DirectionsSchema.parse(JSON.parse(JSON.stringify(example)))).toEqual(example);
    });

    it('accepts an empty list', () => {
        expect(DirectionsSchema.parse([])).toEqual([]);
    });

    it('accepts every turn direction', () => {
        for (const direction of TurnDirectionSchema.options) {
            expect(DirectionStepSchema.safeParse({ ...base, type: 'turn', direction }).success).toBe(true);
        }
    });

    it('accepts null and string names', () => {
        expect(DirectionStepSchema.safeParse({ ...base, type: 'cross', street: null }).success).toBe(true);
        expect(DirectionStepSchema.safeParse({ ...base, type: 'depart', onto: 'State St', landmark: 'Union' }).success).toBe(true);
    });
});

describe('DirectionStepSchema rejects', () => {
    const rejects = (step: unknown) => expect(DirectionStepSchema.safeParse(step).success).toBe(false);

    it('unknown step types', () => {
        rejects({ ...base, type: 'teleport' });
    });

    it('unknown turn directions', () => {
        rejects({ ...base, type: 'turn', direction: 'up' });
    });

    it('a turn without a direction', () => {
        rejects({ ...base, type: 'turn' });
    });

    it('a cross without a street field', () => {
        rejects({ ...base, type: 'cross' });
    });

    it('missing shared fields instead of null', () => {
        rejects({ type: 'depart', path_index: 0, distance: 0 });
        rejects({ type: 'arrive', distance: 0, onto: null, landmark: null });
    });

    it('a non-integer path_index', () => {
        rejects({ ...base, type: 'depart', path_index: 1.5 });
    });

    it('wrongly typed fields', () => {
        rejects({ ...base, type: 'depart', distance: '10' });
        rejects({ ...base, type: 'depart', onto: 5 });
    });
});

describe('JSON schema', () => {
    it('generates without error and names the step types', () => {
        const schema = JSON.stringify(z.toJSONSchema(DirectionsSchema));
        for (const type of ['depart', 'turn', 'continue', 'cross', 'arrive']) {
            expect(schema).toContain(`"${type}"`);
        }
    });
});
