import * as state from '../state/transitState';
import * as walking from '../walking/walkingMap';
import { McRaptorAlgorithm, Journey, JourneyLeg } from "../raptor/McRaptorAlgorithm";

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

    // Use the cached trips array directly: it keeps the same identity for
    // every request between graph rebuilds, so the algorithm's per-graph route
    // index is built once per rebuild instead of once per request. The
    // VIRTUAL_*_TRIP placeholders are single-stop trips that can never be
    // ridden, so they need no per-request patching.
    const mcRaptor = new McRaptorAlgorithm(state.cachedGraph.trips, transferData, state.cachedGraph.interchange);
    // ?? not ||: an explicit walkingPenalty of 0 (walking is free) is valid.
    mcRaptor.setWalkingPenalty(options.walkingPenalty ?? 1);

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

async function processJourneys(journeys: Journey[], oLat: number, oLon: number, dLat: number, dLon: number) {

    const processLeg = async (leg: JourneyLeg) => {
        const isWalk = !leg.trip;

        const formattedLeg: any = {
            origin_id: leg.origin,
            origin: leg.origin === 'VIRTUAL_ORIGIN' ? 'Start' : (leg.origin === 'VIRTUAL_DESTINATION' ? 'End' : (state.stopIdToName[leg.origin] || leg.origin)),
            destination_id: leg.destination,
            destination: leg.destination === 'VIRTUAL_DESTINATION' ? 'End' : (state.stopIdToName[leg.destination] || leg.destination),
            destinationName: leg.destination === 'VIRTUAL_DESTINATION' ? 'End' : (state.stopIdToName[leg.destination] || leg.destination),
            startTime: Math.round(leg.startTime),
            endTime: Math.round(leg.endTime),
            duration: Math.round(leg.duration),
            mode: isWalk ? 'walk' : 'bus',
            originID: leg.originID,
            destinationID: leg.destinationID,
            stopTimes: leg.stopTimes,
            trip: leg.trip,
            rt: leg.rt
        };

        if (leg.trip) {
            formattedLeg.tripId = leg.trip.tripId;
            formattedLeg.vid = leg.trip.vid;
            if (!formattedLeg.rt) {
                const firstStop = leg.trip.stopTimes[0];
                formattedLeg.rt = firstStop.rt || state.tatripidToRt[leg.trip.tripId] || 'UNKNOWN';
            }
        }

        if (isWalk) {
            const cached = walking.getCachedWalk(leg.origin, leg.destination);

            if (cached) {
                Object.assign(formattedLeg, cached);
            } else {
                const l1 = leg.origin === 'VIRTUAL_ORIGIN' ? { lat: oLat, lon: oLon } : state.cachedStopLocations[leg.origin];
                const l2 = leg.destination === 'VIRTUAL_DESTINATION' ? { lat: dLat, lon: dLon } : state.cachedStopLocations[leg.destination];

                if (l1 && l2) {
                    try {
                        const data = await walking.getWalkingResponse(l1.lat, l1.lon, l2.lat, l2.lon);
                        Object.assign(formattedLeg, data);
                        // Keep the duration the journey was routed with so the
                        // leg stays consistent with its start/end times; the
                        // fresh response only contributes geometry/distance.
                        formattedLeg.duration = Math.round(leg.duration);
                    } catch (e) {
                        formattedLeg.path_coords = [];
                    }
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
            departureTime: legs.length > 0 ? legs[0].startTime : journey.criteria.arrivalTime,
            arrivalTime: journey.criteria.arrivalTime,
            criteria: journey.criteria
        };
    }));

    return processedList
        .filter((j: any) => j !== null)
        .sort((a: any, b: any) =>
            a.arrivalTime - b.arrivalTime ||
            a.criteria.walkingDistance - b.criteria.walkingDistance
        );
}