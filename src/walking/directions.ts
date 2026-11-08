import * as z from 'zod';

/**
 * Turn by turn directions for a walking path.
 *
 * Each step says what instruction to show and where along `path_coords` it applies,
 * so the frontend picks the icon/wording from `instruction.type` instead of interpreting raw angles.
 * Enum values can be added as the directions algorithm improves; the frontend should
 * fall back to a generic instruction for values it doesn't recognize.
 *
 * Fields shared by every step live on {@link DirectionStepSchema}, not in the instruction variants,
 * since generated clients (e.g. swagger_parser) don't pull common fields out of a union.
 */

/** Which way and how sharply to turn. */
export const TurnDirectionSchema = z.enum([
    'slight_left',
    'left',
    'sharp_left',
    'slight_right',
    'right',
    'sharp_right',
]).meta({ id: 'TurnDirection' });

export type TurnDirection = z.infer<typeof TurnDirectionSchema>;

/** Start walking. Always the first step. */
export const DepartInstructionSchema = z.object({
    type: z.literal('depart'),
}).meta({ id: 'DepartInstruction' });

/** Turn at an intersection or a bend sharp enough to call out. */
export const TurnInstructionSchema = z.object({
    type: z.literal('turn'),
    direction: TurnDirectionSchema,
}).meta({ id: 'TurnInstruction' });

/** Go straight through an intersection where another branch could be mistaken for the route. */
export const ContinueInstructionSchema = z.object({
    type: z.literal('continue'),
}).meta({ id: 'ContinueInstruction' });

/** Cross a street (crosswalk or otherwise). */
export const CrossInstructionSchema = z.object({
    type: z.literal('cross'),
    /** Name of the street being crossed, if known. */
    street: z.nullable(z.string()),
}).meta({ id: 'CrossInstruction' });

/** Reached the end of the walking path. Always the last step. */
export const ArriveInstructionSchema = z.object({
    type: z.literal('arrive'),
}).meta({ id: 'ArriveInstruction' });

/**
 * What to tell the user to do at a step.
 *
 * The OpenAPI discriminator makes generated clients pick the variant by `type`; without it,
 * swagger_parser tries each variant in order and decodes everything as the first one that fits.
 */
export const DirectionInstructionSchema = z.discriminatedUnion('type', [
    DepartInstructionSchema,
    TurnInstructionSchema,
    ContinueInstructionSchema,
    CrossInstructionSchema,
    ArriveInstructionSchema,
]).meta({
    id: 'DirectionInstruction',
    discriminator: {
        propertyName: 'type',
        mapping: {
            depart: '#/components/schemas/DepartInstruction',
            turn: '#/components/schemas/TurnInstruction',
            continue: '#/components/schemas/ContinueInstruction',
            cross: '#/components/schemas/CrossInstruction',
            arrive: '#/components/schemas/ArriveInstruction',
        },
    },
});

export type DirectionInstruction = z.infer<typeof DirectionInstructionSchema>;

/** Which instruction a step represents. */
export type DirectionInstructionType = DirectionInstruction['type'];

/** A single turn by turn instruction and where it applies. */
export const DirectionStepSchema = z.object({
    /** Index into the walking path's `path_coords` where this step happens. */
    path_index: z.number().int(),
    /** Meters walked from this step until the next one (0 for `arrive`). */
    distance: z.number(),
    /** Name of the street/path walked along after this step, if it has one. */
    onto: z.nullable(z.string()),
    /** Nearby landmark to anchor the instruction (e.g. "at Hatcher Library"), if any. */
    landmark: z.nullable(z.string()),
    instruction: DirectionInstructionSchema,
}).meta({ id: 'DirectionStep' });

export type DirectionStep = z.infer<typeof DirectionStepSchema>;

/** Ordered turn by turn directions for one walking path, from `depart` to `arrive`. */
export const DirectionsSchema = z.array(DirectionStepSchema).meta({ id: 'Directions' });

export type Directions = z.infer<typeof DirectionsSchema>;
