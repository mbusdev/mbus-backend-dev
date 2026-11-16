import * as z from 'zod';
import { LatLonSchema } from '@/services/bustimeCommon';

export const PlanJourneyQuerySchema = z.object({
    originLat: z.coerce.number<string>(),
    originLon: z.coerce.number<string>(),
    destLat: z.coerce.number<string>(),
    destLon: z.coerce.number<string>(),
    walkingPenalty: z.optional(z.string())
        .transform((x) => x === undefined ? undefined : parseFloat(x))
        .pipe(z.optional(z.number())),
    range: z.optional(z.string())
        .transform((x) => x === undefined ? undefined : parseInt(x))
        .pipe(z.optional(z.number())),
}).meta({ id: 'PlanJourneyQuery' });

export const PlanWalkingResponseSchema = z.object({
    path_coords: z.array(LatLonSchema).describe('Ordered path coordinates from origin to destination.'),
    duration: z.number().describe('Walking duration in seconds, rounded to the nearest whole second.'),
}).meta({ id: 'PlanWalkingResponse' });
export type PlanWalkingResponse = z.infer<typeof PlanWalkingResponseSchema>;
