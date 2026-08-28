import * as z from 'zod';
import * as state from '../state/transitState';
import * as walking from '../walking/walkingMap';
import { McRaptorAlgorithm, Journey, JourneyLeg, JourneyLegTrip } from "@/raptor/McRaptorAlgorithm";
import { BusRouteLine, BusStop, LatLon, LatLonSchema } from './bustimeCommon';
import { toKey } from '@/types';

/**
 * Plans a journey between two coordinates using the McRaptor algorithm.
 * @param oLat Origin latitude
 * @param oLon Origin longitude
 * @param dLat Destination latitude
 * @param dLon Destination longitude
 * @param time Start time in seconds since midnight
 * @param options Optional parameters for walking penalty and search range
 */
export async function planJourney(
    oLat: number, oLon: number,
    dLat: number, dLon: number,
    time: number,
    options: { walkingPenalty?: number, range?: number }
) {
    const V_ORIGIN = 'VIRTUAL_ORIGIN';
    const V_DEST = 'VIRTUAL_DESTINATION';

    const walksFromOrigin = walking.getWalkingDistancesFrom(oLat, oLon, dLat, dLon);
    const walksToDest = walking.getWalkingDistancesFrom(dLat, dLon);

    const transferData = { ...state.cachedGraph.transfers };
    transferData[V_ORIGIN] = [];
    transferData[V_DEST] = [];

    walksFromOrigin.forEach(walk => {
        const dest = walk.stopId === "DIRECT_WALK" ? V_DEST : walk.stopId;
        transferData[V_ORIGIN].push({
            origin: V_ORIGIN, destination: dest,
            duration: walk.duration, startTime: time, endTime: Number.MAX_SAFE_INTEGER
        });
    });

    walksToDest.forEach(walk => {
        transferData[walk.stopId] = [...(transferData[walk.stopId] || [])];
        transferData[walk.stopId].push({
            origin: walk.stopId, destination: V_DEST,
            duration: walk.duration, startTime: time, endTime: Number.MAX_SAFE_INTEGER
        });
    });

    const requestTrips = state.cachedGraph.trips.map(trip => {
        if (trip.tripId === 'VIRTUAL_ORIGIN_TRIP') {
            return {
                ...trip,
                stopTimes: [{ stop: V_ORIGIN, arrivalTime: time, departureTime: time, pickUp: true, dropOff: true }]
            };
        }
        if (trip.tripId === 'VIRTUAL_DESTINATION_TRIP') {
            return {
                ...trip,
                stopTimes: [{ stop: V_DEST, arrivalTime: time, departureTime: time, pickUp: true, dropOff: true }]
            };
        }
        return trip;
    });

    const mcRaptor = new McRaptorAlgorithm(requestTrips, transferData, state.cachedGraph.interchange);
    mcRaptor.setWalkingPenalty(options.walkingPenalty || 1);

    const range = options.range;
    const journeys = range === undefined
        ? mcRaptor.getOptimizedJourneys(V_ORIGIN, V_DEST, time)
        : mcRaptor.getOptimizedJourneysInRange(
            V_ORIGIN,
            V_DEST,
            time,
            range ?? 45 * 60
        );

    return processJourneys(journeys, oLat, oLon, dLat, dLon);
}


const formattedLegCommonFields = {
    origin_id: z.string(),
    origin: z.string(),
    destination_id: z.string(),
    destination: z.string(),
    destinationName: z.string(),
    startTime: z.number(),
    endTime: z.number(),
    duration: z.number(),
    originID: z.string(),
    destinationID: z.string(),
};

const FormattedLegWalkSchema = z.object({
    ...formattedLegCommonFields,
    path_coords: z.array(LatLonSchema),
    mode: z.literal('walk')
}).meta({ id: 'FormattedLegWalk' });

// conains the fields of StopTime used in the frontend
const StopTimeSchema = z.object({
    stop: z.string(),
    arrivalTime: z.number(),
    departureTime: z.number(),
    pickUp: z.boolean(),
    dropOff: z.boolean(),
}).meta({ id: 'StopTime' });

const TripSchema = z.object({
  tripId: z.string(),
  vid: z.nullable(z.string()),
  stopTimes: z.array(StopTimeSchema),
}).meta({ id: 'Trip' });

const FormattedLegBusSchema = z.object({
    ...formattedLegCommonFields,
    busPathSegments: z.array(
        z.object({ rt: z.nullable(z.string()), path: z.array(LatLonSchema) })
            .meta({ id: 'FormattedLegBusPathRouteSegment' })
    ),
    stopCoords: z.array(
        z.object({
            rt: z.nullable(z.string()),
            location: LatLonSchema,
            segmentIdx: z.number(),
            idxInSegment: z.number()
        }).meta({ id: 'FormattedLegBusStopCoord' })
    ),
    mode: z.literal('bus'),
    stopTimes: z.array(StopTimeSchema),
    trip: TripSchema,
    tripId: z.string(),
    rt: z.string(),
    vid: z.nullable(z.string()),
}).meta({ id: 'FormattedLegBus' });


export const FormattedLegSchema = z.discriminatedUnion('mode', [FormattedLegWalkSchema, FormattedLegBusSchema])
    .meta({ id: 'FormattedLeg' })
export type FormattedLeg = z.infer<typeof FormattedLegSchema>;

export const ProcessedJourneySchema = z.object({
    legs: z.array(FormattedLegSchema),
    arrivalTime: z.number(),
    departureTime: z.number(),
    criteria: z.object({
        arrivalTime: z.number(),
        walkingDistance: z.number(),
        transferCount: z.number(),   
    }),
}).meta({ id: 'ProcessedJourney' });
export type ProcessedJourney = z.infer<typeof ProcessedJourneySchema>;

async function processJourneys(
    journeys: Journey[], oLat: number, oLon: number, dLat: number, dLon: number
): Promise<ProcessedJourney[]> {

    const processLeg = async (leg: JourneyLeg) => {
        const isWalk = leg.type === 'Transfer';

        let formattedLeg: FormattedLeg;
        const formattedLegCommon  = {
            origin_id: leg.origin,
            origin: leg.origin === 'VIRTUAL_ORIGIN' ? 'Start' : (leg.origin === 'VIRTUAL_DESTINATION' ? 'End' : (state.stopIdToName[leg.origin] || leg.origin)),
            destination_id: leg.destination,
            destination: leg.destination === 'VIRTUAL_DESTINATION' ? 'End' : (state.stopIdToName[leg.destination] || leg.destination),
            destinationName: leg.destination === 'VIRTUAL_DESTINATION' ? 'End' : (state.stopIdToName[leg.destination] || leg.destination),
            startTime: Math.round(leg.startTime),
            endTime: Math.round(leg.endTime),
            duration: Math.round(leg.duration),
            originID: leg.originID,
            destinationID: leg.destinationID,
        };

        if (!isWalk) {
            // fallback to route of the first stop or the route associated with the trip id
            const rt: string | undefined = leg.rt || leg.trip.stopTimes[0].rt || state.tatripidToRt[leg.trip.tripId];
            const { segments, stops } = getBusLegPolyline(leg);
            formattedLeg = {
                ...formattedLegCommon,
                mode: 'bus',
                stopTimes: leg.stopTimes,
                trip: leg.trip,
                tripId: leg.trip.tripId,
                vid: leg.trip.vid,
                rt: rt ?? 'UNKNOWN',
                busPathSegments: segments,
                stopCoords: stops,
            };
        } else {
            const cached = walking.getCachedWalk(leg.origin, leg.destination);

            if (cached) {
                formattedLeg = {...formattedLegCommon, ...cached, mode: 'walk'}
            } else {
                const l1 = leg.origin === 'VIRTUAL_ORIGIN' ? { lat: oLat, lon: oLon } : state.cachedStopLocations[leg.origin];
                const l2 = leg.destination === 'VIRTUAL_DESTINATION' ? { lat: dLat, lon: dLon } : state.cachedStopLocations[leg.destination];

                if (l1 && l2) {
                    try {
                        const data = await walking.getWalkingResponse(l1.lat, l1.lon, l2.lat, l2.lon);
                        data.duration = Math.round(data.duration);
                        formattedLeg = {...formattedLegCommon, ...data, mode: 'walk'};
                    } catch (e) {
                        formattedLeg = {...formattedLegCommon, path_coords: [], mode: 'walk'};
                    }
                } else {
                    formattedLeg = {...formattedLegCommon, path_coords: [], mode: 'walk'};
                }
            }
        }

        return formattedLeg;
    };

    const processedList = await Promise.all(journeys.map(async (journey: Journey) => {
        if (!journey) return null;

        const legs = await Promise.all(journey.legs.map(processLeg));

        return {
            legs,
            departureTime: journey.criteria.arrivalTime - (legs.reduce((acc, leg) => acc + leg.duration, 0)),
            arrivalTime: journey.criteria.arrivalTime,
            criteria: journey.criteria
        };
    }));

    return processedList
        .filter((j) => j !== null)
        .sort((a, b) =>
            a.arrivalTime - b.arrivalTime ||
            a.criteria.walkingDistance - b.criteria.walkingDistance
        );
}

function getBusLegPolyline(leg: JourneyLegTrip): {
    segments: Array<{ rt: string | null, path: LatLon[] }>,
    stops: Array<{ rt: string | null, location: LatLon, segmentIdx: number, idxInSegment: number }>
} {
    // the + 1 is in case the use of rounding w/ dep/arr times ever does something in the future
    // (should all be whole numbers currently)
    const relevantSts = (() => {
        // debug: see whole trip
        // return leg.trip.stopTimes;

        // find the subset of the trip that will actually be ridden on
        const sts = leg.trip.stopTimes;
        const relevantStart = sts.findIndex((st) => st.departureTime <= leg.startTime + 1 && st.stop === leg.originID);
        const relevantEnd = sts.findIndex((st, i) => i > relevantStart && st.stop === leg.destinationID);
        return relevantStart != -1 && relevantEnd != -1 ? sts.slice(relevantStart, relevantEnd) : sts;
    })();

    const fallback = (() => {
        const fallbackStopPoints = relevantSts
            .map((st, i) => {
                return {
                    rt: st.rt ?? null,
                    location: state.cachedStopLocations[st.stop],
                    segmentIdx: i, // first (and only) point of each segment
                    idxInSegment: 0,
                };
            });
        // the whole path should get rendered with the transfer route style if falling back
        return {
            segments: fallbackStopPoints.map((x) => { return { rt: x.rt, path: [x.location] }; }),
            stops: fallbackStopPoints,
        };
    })();
    // debug: show fallback
    // return fallback;

    // relevant portion should always be one route in practice but trips do often contain multiple (e.g. CN->CS)
    // and this remains supported
    const lines = (() => {
        const routes = new Set<string>();
        relevantSts
            .map((st) => st.rt)
            .filter((rt) => rt !== undefined)
            .forEach((rt) => routes.add(rt));
        return Array.from(routes).flatMap((r) => state.cachedRoutes[r]);
    })();
    if (!lines.length) {
        console.warn('getBusLegPolyline had to use fallback: no route info');
        return fallback;
    }

    if (!relevantSts.length) {
        console.warn('getBusLegPolyline had to use fallback: no relevant stop times');
        return fallback;
    }

    const pathEdges = relevantSts
        .slice(1)
        .map(({ rt, stop: to }, i) => {
            if (!rt) return null;
            const from = relevantSts[i].stop;
            const path = state.cachedStopToStopPaths.get(toKey({ rt: rt, from, to }));
            if (!path) return null;
            return { rt, path };
        })
        .filter((x) => x !== null);

    return pathEdges.reduce<ReturnType<typeof getBusLegPolyline>>(
        ({ segments, stops }, edge) => {
            // start a new segment
            if (!segments.length || segments[segments.length - 1].rt !== edge.rt) {
                // add both stops of `edge` if present
                const edgeStart = edge.path.length > 0
                    ? [{ rt: edge.rt, location: edge.path[0], segmentIdx: segments.length, idxInSegment: 0 }]
                    : [];
                const edgeEnd = edge.path.length > 1
                    ? [{
                        rt: edge.rt,
                        location: edge.path[edge.path.length - 1],
                        segmentIdx: segments.length,
                        idxInSegment: edge.path.length - 1,
                    }]
                    : [];
                return { segments: [...segments, edge], stops: [...stops, ...edgeStart, ...edgeEnd]};
            }
            // extend the existing segment
            // starting point is already included in previously added edge
            segments[segments.length - 1].path.push(...edge.path.slice(1)); 
            // add ending stop of `edge`
            const edgeEnd = edge.path.length > 1
                ? [{
                    rt: edge.rt,
                    location: edge.path[edge.path.length - 1],
                    segmentIdx: segments.length - 1,
                    idxInSegment: segments[segments.length - 1].path.length - 1,
                }]
                : [];
            return { segments, stops: [...stops, ...edgeEnd] };
        },
        { segments: [], stops: [] },
    );
}
