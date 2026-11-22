import * as state from '../state/transitState';
import * as walking from '../walking/walkingMap';
import * as onBusService from './onBus';
import { McRaptorAlgorithm, Journey, JourneyLeg } from "../raptor/McRaptorAlgorithm";
import { AtStopContext, LocationSample, OnBusContext, Trip } from "../raptor/types";

/** Optional on-bus routing input passed from the API layer. */
export interface OnBusOptions {
    /** Vehicle ID the frontend believes the user is on. */
    vid?: string;
    /** Recent user location samples for motion validation. */
    locationTrail?: LocationSample[];
}

/**
 * Adjusts DUE (predicted within ~1 minute) departures at a stop the user is
 * physically at, so they are boardable immediately instead of in 60 seconds.
 * Returns adjusted copies; never mutates the cached graph trips.
 * @param trips List of trips to adjust
 * @param stopId The stop the user is standing at
 * @param currentTime Current time in seconds since midnight (UTC)
 */
export function adjustDueTripsAtStop(trips: Trip[], stopId: string, currentTime: number): Trip[] {
    return trips.map(trip => {
        if (trip.tripId === 'VIRTUAL_ORIGIN_TRIP' || trip.tripId === 'VIRTUAL_DESTINATION_TRIP') return trip;
        let changed = false;
        const stopTimes = trip.stopTimes.map(st => {
            const delta = st.arrivalTime - currentTime;
            if (st.stop === stopId && delta >= -60 && delta <= 60) {
                changed = true;
                return { ...st, arrivalTime: currentTime, departureTime: currentTime };
            }
            return st;
        });
        return changed ? { ...trip, stopTimes } : trip;
    });
}

/**
 * Plans a journey between two coordinates using the McRaptor algorithm.
 * @param oLat Origin latitude
 * @param oLon Origin longitude
 * @param dLat Destination latitude
 * @param dLon Destination longitude
 * @param time Start time in seconds since midnight
 * @param options Optional parameters for walking penalty, search range, and on-bus routing
 * @returns Object with `journeys` and, when on-bus routing was requested, `originContext`
 */
export async function planJourney(
    oLat: number, oLon: number,
    dLat: number, dLon: number,
    time: number,
    options: { walkingPenalty?: number, range?: number, onBus?: OnBusOptions }
) {
    const V_ORIGIN = 'VIRTUAL_ORIGIN';
    const V_DEST = 'VIRTUAL_DESTINATION';

    let originContext: any = null;
    let onBusContext: OnBusContext | null = null;
    let atStopContext: AtStopContext | null = null;

    if (options.onBus) {
        const trail = options.onBus.locationTrail || [];
        if (trail.length === 0) {
            originContext = {
                mode: 'walking', status: 'not_near_bus',
                validated: false, fallbackReason: 'trail_required'
            };
        } else {
            const classification = onBusService.classifyOnBusStatus(oLat, oLon, trail, options.onBus.vid);
            if (classification.status === 'on_bus' && classification.vid) {
                onBusContext = onBusService.resolveOnBusContext(
                    classification.vid, oLat, oLon, time, classification
                );
                if (onBusContext) {
                    originContext = {
                        mode: 'on_bus',
                        status: 'on_bus',
                        vid: onBusContext.vid,
                        tripId: onBusContext.tripId,
                        rt: onBusContext.rt,
                        validated: true,
                        confidence: classification.confidence,
                        isStoppedAtStop: onBusContext.isStoppedAtStop,
                        ...(onBusContext.isStoppedAtStop ? {
                            currentStopId: onBusContext.currentStopId,
                            currentStopName: onBusContext.currentStopName,
                            showsTransferOptions: true,
                        } : {})
                    };
                } else {
                    originContext = {
                        mode: 'walking', status: classification.status,
                        vid: classification.vid, validated: false,
                        confidence: classification.confidence, fallbackReason: 'bus_not_found'
                    };
                }
            } else {
                const fallbackReason =
                    classification.status === 'waiting_at_stop' ? 'waiting_at_stop' :
                    classification.status === 'near_bus' ? 'co_movement_failed' : 'not_near_bus';
                originContext = {
                    mode: 'walking', status: classification.status,
                    vid: classification.vid, validated: false,
                    confidence: classification.confidence, fallbackReason
                };
            }
        }

        // At-stop origin: applies whenever on-bus wasn't confirmed but the user
        // is physically standing at a stop (e.g. waiting for a bus there).
        if (!onBusContext) {
            atStopContext = onBusService.detectAtStopContext(oLat, oLon);
            if (atStopContext) {
                originContext = {
                    ...originContext,
                    mode: 'at_stop',
                    stopId: atStopContext.stopId,
                    stopName: atStopContext.stopName,
                };
            }
        }
    }

    const walksToDest = walking.getWalkingDistancesFrom(dLat, dLon);

    const transferData = { ...state.cachedGraph.transfers };
    transferData[V_ORIGIN] = [];
    transferData[V_DEST] = [];

    if (onBusContext) {
        // The user starts aboard the bus: a zero-cost hop onto the trimmed trip.
        transferData[V_ORIGIN].push({
            origin: V_ORIGIN, destination: onBusContext.virtualStopId,
            duration: 0, startTime: time, endTime: Number.MAX_SAFE_INTEGER
        });
        // If the bus is stopped at a physical stop, the user can also step off
        // right now and transfer there — inject a second zero-cost origin path.
        if (onBusContext.isStoppedAtStop && onBusContext.currentStopId) {
            transferData[V_ORIGIN].push({
                origin: V_ORIGIN, destination: onBusContext.currentStopId,
                duration: 0, startTime: time, endTime: Number.MAX_SAFE_INTEGER
            });
        }
    } else if (atStopContext) {
        // User is standing at the stop: route directly from it with no walk penalty.
        transferData[V_ORIGIN].push({
            origin: V_ORIGIN, destination: atStopContext.stopId,
            duration: 0, startTime: time, endTime: Number.MAX_SAFE_INTEGER
        });
        // Keep the direct origin-to-destination walk available.
        const walksFromOrigin = walking.getWalkingDistancesFrom(oLat, oLon, dLat, dLon);
        const direct = walksFromOrigin.find(w => w.stopId === 'DIRECT_WALK');
        if (direct) {
            transferData[V_ORIGIN].push({
                origin: V_ORIGIN, destination: V_DEST,
                duration: direct.duration, startTime: time, endTime: Number.MAX_SAFE_INTEGER
            });
        }
    } else {
        const walksFromOrigin = walking.getWalkingDistancesFrom(oLat, oLon, dLat, dLon);
        walksFromOrigin.forEach(walk => {
            const dest = walk.stopId === "DIRECT_WALK" ? V_DEST : walk.stopId;
            transferData[V_ORIGIN].push({
                origin: V_ORIGIN, destination: dest,
                duration: walk.duration, startTime: time, endTime: Number.MAX_SAFE_INTEGER
            });
        });
    }

    walksToDest.forEach(walk => {
        transferData[walk.stopId] = [...(transferData[walk.stopId] || [])];
        transferData[walk.stopId].push({
            origin: walk.stopId, destination: V_DEST,
            duration: walk.duration, startTime: time, endTime: Number.MAX_SAFE_INTEGER
        });
    });

    let requestTrips = state.cachedGraph.trips.map(trip => {
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

    if (onBusContext) {
        requestTrips.push(onBusContext.trimmedTrip);
        if (onBusContext.isStoppedAtStop && onBusContext.currentStopId) {
            requestTrips = adjustDueTripsAtStop(requestTrips, onBusContext.currentStopId, time);
        }
    } else if (atStopContext) {
        requestTrips = adjustDueTripsAtStop(requestTrips, atStopContext.stopId, time);
    }

    const interchangeData = onBusContext
        ? { ...state.cachedGraph.interchange, [onBusContext.virtualStopId]: 0 }
        : state.cachedGraph.interchange;

    const mcRaptor = new McRaptorAlgorithm(requestTrips, transferData, interchangeData);
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

    const processed = await processJourneys(journeys, oLat, oLon, dLat, dLon, { onBusContext, atStopContext });
    return { journeys: processed, originContext };
}

async function processJourneys(
    journeys: Journey[],
    oLat: number, oLon: number,
    dLat: number, dLon: number,
    context: { onBusContext?: OnBusContext | null, atStopContext?: AtStopContext | null } = {}
) {
    const onBusCtx = context.onBusContext || null;
    const atStopCtx = context.atStopContext || null;

    const processLeg = async (leg: JourneyLeg) => {
        const isWalk = !leg.trip;
        const isOnBusOrigin = onBusCtx !== null && leg.origin === onBusCtx.virtualStopId;

        const formattedLeg: any = {
            origin_id: leg.origin,
            origin: leg.origin === 'VIRTUAL_ORIGIN' ? 'Start'
                : isOnBusOrigin ? 'On Bus'
                : (leg.origin === 'VIRTUAL_DESTINATION' ? 'End' : (state.stopIdToName[leg.origin] || leg.origin)),
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

        let rawLegs = journey.legs;
        // Drop the synthetic zero-duration hop from VIRTUAL_ORIGIN in
        // on-bus / at-stop modes (the user is already there).
        if ((onBusCtx || atStopCtx) && rawLegs.length > 1
            && rawLegs[0].type === 'Transfer'
            && rawLegs[0].origin === 'VIRTUAL_ORIGIN'
            && rawLegs[0].duration === 0) {
            rawLegs = rawLegs.slice(1);
        }

        const legs = await Promise.all(rawLegs.map(processLeg));

        const criteria = { ...journey.criteria };
        if (onBusCtx && legs.length > 0) {
            const firstBusLeg = legs.find((l: any) => l.mode === 'bus');
            if (firstBusLeg && firstBusLeg.vid === onBusCtx.vid) {
                legs[0].originChoice = 'continue_on_bus';
                firstBusLeg.busPosition = { lat: onBusCtx.busLat, lon: onBusCtx.busLon };
                // The ride the user is already on isn't a new boarding
                criteria.transferCount = Math.max(0, criteria.transferCount - 1);
            } else if (firstBusLeg) {
                legs[0].originChoice = 'alight_and_transfer';
            }
        }

        return {
            legs,
            departureTime: criteria.arrivalTime - (legs.reduce((acc: number, leg: any) => acc + leg.duration, 0)),
            arrivalTime: criteria.arrivalTime,
            criteria
        };
    }));

    return processedList
        .filter((j: any) => j !== null)
        .sort((a: any, b: any) =>
            a.arrivalTime - b.arrivalTime ||
            a.criteria.walkingDistance - b.criteria.walkingDistance
        );
}
