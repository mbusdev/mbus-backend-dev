import z from "zod";

const PatternPtSchema = z.object({
    seq: z.number(),
    typ: z.string(),
    stpid: z.optional(z.string()),
    stpnm: z.optional(z.string()),
    pdist: z.optional(z.number()),
    lat: z.number(),
    lon: z.number(),
});

export const PatternSchema = z.object({
    pid: z.number(),
    ln: z.number(),
    rtdir: z.string(),
    pt: z.array(PatternPtSchema),
    dtrid: z.optional(z.string()),
    dtrpt: z.optional(z.array(PatternPtSchema)),
});

export const PatternsArraySchema = z.array(PatternSchema);

export type Pattern = z.infer<typeof PatternSchema>

