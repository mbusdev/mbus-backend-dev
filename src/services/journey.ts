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

    const range = options.range || 45 * 60;
    const journeys = mcRaptor.getOptimizedJourneysInRange(V_ORIGIN, V_DEST, time, range);

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
                        data.duration = Math.round(data.duration);
                        Object.assign(formattedLeg, data);
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
            departureTime: journey.criteria.arrivalTime - (legs.reduce((acc, leg) => acc + leg.duration, 0)),
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