import * as z from 'zod';

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
