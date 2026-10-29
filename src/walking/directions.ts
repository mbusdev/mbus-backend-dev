import * as z from 'zod';

/**
 * Turn by turn directions for a walking path.
 *
 * Each step says what instruction to show and where along `path_coords` it applies,
 * so the frontend picks the icon/wording from `type` instead of interpreting raw angles.
 * Enum values can be added as the directions algorithm improves; the frontend should
 * fall back to a generic instruction for values it doesn't recognize.
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

/** Fields shared by every step. */
export const DirectionStepBase = {
    /** Index into the walking path's `path_coords` where this step happens. */
    path_index: z.number().int(),
    /** Meters walked from this step until the next one (0 for `arrive`). */
    distance: z.number(),
    /** Name of the street/path walked along after this step, if it has one. */
    onto: z.nullable(z.string()),
    /** Nearby landmark to anchor the instruction (e.g. "at Hatcher Library"), if any. */
    landmark: z.nullable(z.string()),
};

/** Start walking. Always the first step. */
export const DepartStepSchema = z.object({
    ...DirectionStepBase,
    type: z.literal('depart'),
}).meta({ id: 'DepartStep' });

/** Turn at an intersection or a bend sharp enough to call out. */
export const TurnStepSchema = z.object({
    ...DirectionStepBase,
    type: z.literal('turn'),
    direction: TurnDirectionSchema,
}).meta({ id: 'TurnStep' });

/** Go straight through an intersection where another branch could be mistaken for the route. */
export const ContinueStepSchema = z.object({
    ...DirectionStepBase,
    type: z.literal('continue'),
}).meta({ id: 'ContinueStep' });

/** Cross a street (crosswalk or otherwise). */
export const CrossStepSchema = z.object({
    ...DirectionStepBase,
    type: z.literal('cross'),
    /** Name of the street being crossed, if known. */
    street: z.nullable(z.string()),
}).meta({ id: 'CrossStep' });

/** Reached the end of the walking path. Always the last step. */
export const ArriveStepSchema = z.object({
    ...DirectionStepBase,
    type: z.literal('arrive'),
}).meta({ id: 'ArriveStep' });

/** A single turn by turn instruction. */
export const DirectionStepSchema = z.discriminatedUnion('type', [
    DepartStepSchema,
    TurnStepSchema,
    ContinueStepSchema,
    CrossStepSchema,
    ArriveStepSchema,
]).meta({ id: 'DirectionStep' });

export type DirectionStep = z.infer<typeof DirectionStepSchema>;

/** Which instruction a step represents. */
export type DirectionStepType = DirectionStep['type'];

/** Ordered turn by turn directions for one walking path, from `depart` to `arrive`. */
export const DirectionsSchema = z.array(DirectionStepSchema).meta({ id: 'Directions' });

export type Directions = z.infer<typeof DirectionsSchema>;
