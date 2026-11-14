import * as z from 'zod';
import { describe, it, expect } from 'vitest';
import {
    Directions,
    DirectionsSchema,
    DirectionStepSchema,
    DirectionInstructionSchema,
    TurnDirectionSchema,
} from '../src/walking/directions';

const base = { path_index: 0, distance: 10, onto: null, landmark: null };

const example: Directions = [
    { path_index: 0, distance: 40, onto: 'State St', landmark: null, instruction: { type: 'depart' } },
    { path_index: 5, distance: 20, onto: null, landmark: 'Hatcher Library', instruction: { type: 'turn', direction: 'left' } },
    { path_index: 7, distance: 10, onto: 'Diag', landmark: null, instruction: { type: 'continue' } },
    { path_index: 8, distance: 15, onto: null, landmark: null, instruction: { type: 'cross', street: 'S University Ave' } },
    { path_index: 12, distance: 0, onto: null, landmark: null, instruction: { type: 'arrive' } },
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
            expect(DirectionStepSchema.safeParse({ ...base, instruction: { type: 'turn', direction } }).success).toBe(true);
        }
    });

    it('accepts null and string names', () => {
        expect(DirectionStepSchema.safeParse({ ...base, instruction: { type: 'cross', street: null } }).success).toBe(true);
        expect(DirectionStepSchema.safeParse({ ...base, onto: 'State St', landmark: 'Union', instruction: { type: 'depart' } }).success).toBe(true);
    });
});

describe('DirectionStepSchema rejects', () => {
    const rejects = (step: unknown) => expect(DirectionStepSchema.safeParse(step).success).toBe(false);

    it('unknown instruction types', () => {
        rejects({ ...base, instruction: { type: 'teleport' } });
    });

    it('unknown turn directions', () => {
        rejects({ ...base, instruction: { type: 'turn', direction: 'up' } });
    });

    it('a turn without a direction', () => {
        rejects({ ...base, instruction: { type: 'turn' } });
    });

    it('a cross without a street field', () => {
        rejects({ ...base, instruction: { type: 'cross' } });
    });

    it('a missing instruction', () => {
        rejects(base);
    });

    it('the old flat format with type on the step', () => {
        rejects({ ...base, type: 'depart' });
    });

    it('missing shared fields instead of null', () => {
        rejects({ path_index: 0, distance: 0, instruction: { type: 'depart' } });
        rejects({ distance: 0, onto: null, landmark: null, instruction: { type: 'arrive' } });
    });

    it('a non-integer path_index', () => {
        rejects({ ...base, path_index: 1.5, instruction: { type: 'depart' } });
    });

    it('wrongly typed fields', () => {
        rejects({ ...base, distance: '10', instruction: { type: 'depart' } });
        rejects({ ...base, onto: 5, instruction: { type: 'depart' } });
    });
});

describe('JSON schema', () => {
    it('generates without error and names the instruction types', () => {
        const schema = JSON.stringify(z.toJSONSchema(DirectionsSchema));
        for (const type of ['depart', 'turn', 'continue', 'cross', 'arrive']) {
            expect(schema).toContain(`"${type}"`);
        }
    });

    it('keeps shared fields out of the instruction variants', () => {
        // each schema has a meta id, so variants come out as named $defs referenced from the union
        const { $defs } = z.toJSONSchema(DirectionInstructionSchema) as any;
        const variants: any[] = $defs.DirectionInstruction.oneOf
            .map((v: { $ref: string }) => $defs[v.$ref.replace('#/$defs/', '')]);
        expect(variants).toHaveLength(5);
        const keySets = variants.map(v => Object.keys(v.properties));
        const shared = keySets.reduce((acc, keys) => acc.filter(k => keys.includes(k)));
        expect(shared).toEqual(['type']);
    });

    it('maps every instruction type to its variant in the discriminator', () => {
        const { $defs } = z.toJSONSchema(DirectionInstructionSchema) as any;
        const { oneOf, discriminator } = $defs.DirectionInstruction;
        expect(discriminator.propertyName).toBe('type');
        const expected = Object.fromEntries(oneOf.map((v: { $ref: string }) => {
            const name = v.$ref.replace('#/$defs/', '');
            return [$defs[name].properties.type.const, `#/components/schemas/${name}`];
        }));
        expect(discriminator.mapping).toEqual(expected);
    });
});
