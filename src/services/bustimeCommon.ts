import z from "zod";

const PatternPtSchema = z.object({
    seq: z.int(),
    typ: z.string(),
    stpid: z.optional(z.string()),
    stpnm: z.optional(z.string()),
    pdist: z.optional(z.number()),
    lat: z.number(),
    lon: z.number(),
}).meta({ id: 'PatternPt' });

export const PatternSchema = z.object({
    pid: z.int(),
    ln: z.number(),
    rtdir: z.string(),
    pt: z.array(PatternPtSchema),
    dtrid: z.optional(z.string()),
    dtrpt: z.optional(z.array(PatternPtSchema)),
}).meta({ id: 'Pattern' });
export type Pattern = z.infer<typeof PatternSchema>

export const PatternsArraySchema = z.array(PatternSchema);

export const LatLonSchema = z.object({ lat: z.number(), lon: z.number() }).meta({ name: 'LatLon' });

export const BusStopSchema = z.object({
    id: z.string(),
    name: z.string(),
    location: LatLonSchema,
    routeId: z.string(),
    rotation: z.number(),
    isRide: z.boolean(),
}).meta({ id: 'BusStop' });
export type BusStop = z.infer<typeof BusStopSchema>;

export function makeBusStop(
    { id, name, lat, lon }: { id?: string, name?: string, lat?: number, lon?: number },
    routeId: string, rotation: number, isRide: boolean
): BusStop {
    return {
        id: id ?? '',
        name: name ? normalizeStopName(name) : '',
        location: { lat: lat ?? 0, lon: lon ?? 0 },
        routeId, rotation, isRide,
    };
}

/** doesn't include color or image url, which are still handled by the frontend */
export const BusRouteLineSchema = z.object({
    routeId: z.string(),
    routeDirection: z.string(),
    points: z.array(LatLonSchema),
    stops: z.array(z.object({ index: z.int(), stop: BusStopSchema })),
}).meta({ id: 'BusRouteLine' });
export type BusRouteLine = z.infer<typeof BusRouteLineSchema>;

export function makeBusRouteLines(rt: string, pattern: Pattern, isRide: boolean): BusRouteLine[] {

    const process = (pointList: Pattern['pt']): {
        points: BusRouteLine['points'],
        stops: BusRouteLine['stops']
    } => {
        const points = [];
        const stops = [];
        for (let i = 0; i < pointList.length; i++) {
            const point = pointList[i];
            const isLast = i == pointList.length - 1; // bool to check if last
            points.push({ lat: point.lat, lon: point.lon });
            if (point.typ === 'S') {
                // get rotation of stop
                let stopRotation;
                if (isLast) {
                    // use the previous 2 points to calculate rotation
                    stopRotation = pointRotation(
                        pointList[i - 2]?.lat ?? 0,
                        pointList[i - 2]?.lon ?? 0,
                        pointList[i - 1]?.lat ?? 0,
                        pointList[i - 1]?.lon ?? 0,
                    );
                } else {
                    // use the next 2 points to calculate rotation
                    stopRotation = pointRotation(
                        pointList[i + 1]?.lat ?? 0,
                        pointList[i + 1]?.lon ?? 0,
                        pointList[i + 2]?.lat ?? 0,
                        pointList[i + 2]?.lon ?? 0,
                    );
                }
                stops.push({
                    index: i,
                    stop : makeBusStop(
                        { id: point.stpid, name: point.stpnm, lat: point.lat, lon: point.lon },
                        rt, stopRotation, isRide
                    )
                });
            }
        }
        return { points, stops };
    }
    
    const lines: BusRouteLine[] = [];
    {
        const { points, stops } = process(pattern.pt);
        lines.push({ routeId: rt, points, stops, routeDirection: pattern.rtdir });
    }

    // Handle detour points if present
    if (pattern.dtrpt) {
        const { points, stops } = process(pattern.dtrpt);
        lines.push({ routeId: rt, points, stops, routeDirection: pattern.rtdir });
    }

    return lines;
}

/**
 * Function to calculate rotation angle between two geographical points
 * (used for bus stop icon orientation)
 */
export function pointRotation(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = lat2 - lat1;
    const dLon = lon2 - lon1;

    // Scale longitude by cos(lat) to correct for east-west distance
    const x = dLon * (Math.cos(lat1 * Math.PI / 180.0));
    const y = dLat;

    let angle = Math.atan2(x, y) * 180.0 / Math.PI;

    // Normalize to [0, 360)
    if (angle < 0) angle += 360;

    return angle;
}

// KEEP THIS IN SYNC WITH THE CORRESPONDING FUNCTION IN THE FRONTEND
function normalizeStopName(rawStopName: string): string {
    return rawStopName
        .replaceAll('%', '')
        .replaceAll(/\s+/g, ' ')
        .trim();
}

