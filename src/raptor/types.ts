/**
 * Unique identifier for a transit stop (e.g., "NRW").
 */
export type StopID = string;

/**
 * Time represented as seconds since midnight.
 * Values may exceed 86400 (24 hours) for trips extending into the next day.
 */
export type Time = number;

/**
 * A span of time measured in seconds.
 */
export type Duration = number;

/**
 * Represents a scheduled stop event within a trip (GTFS StopTime).
 */
export interface StopTime {
  /** The ID of the stop. */
  stop: StopID;
  arrivalTime: Time;
  departureTime: Time;
  /** Whether passengers can board the vehicle here. */
  pickUp: boolean;
  /** Whether passengers can alight from the vehicle here. */
  dropOff: boolean;
  /** Optional pre-calculated cost for routing heuristics. */
  heursticCost?: number; 
  /** Real-time status string (if available). */
  rt? : string;
  /** If the stop is predicted or not. */
  isExtrapolated? : boolean
}

/**
 * Abstract representation of a connection between two stops.
 */
export interface Leg {
  origin: StopID;
  destination: StopID;
}

/**
 * A specific segment of a scheduled trip with fixed times.
 */
export interface TimetableLeg extends Leg {
  stopTimes: StopTime[];
  trip: Trip;
}

/**
 * A walking connection between two stops with a defined duration.
 */
export interface Transfer extends Leg {
  duration: Duration;
  /** Valid start time for this transfer window. */
  startTime: Time;
  /** Valid end time for this transfer window. */
  endTime: Time;
}

/**
 * Unique identifier for a GTFS trip.
 */
export type TripID = string;

/**
 * Represents a transit vehicle run (GTFS Trip).
 */
export interface Trip {
  tripId: TripID;
  /** Vehicle ID, if available. */
  vid: string | null,
  /** Ordered list of stops made by this trip. */
  stopTimes: StopTime[];
}

/**
 * Lookup map for walking transfers, indexed by the origin Stop ID.
 */
export type TransfersByOrigin = Record<StopID, Transfer[]>;

/**
 * Map defining the minimum time required to switch vehicles at each stop.
 */
export type Interchange = Record<StopID, Time>;

/**
 * Classification of a user's relationship to nearby buses.
 */
export type OnBusStatus = 'on_bus' | 'near_bus' | 'waiting_at_stop' | 'not_near_bus';

/**
 * A single user location sample provided by the frontend for motion validation.
 */
export interface LocationSample {
  lat: number;
  lon: number;
  /** Epoch milliseconds. */
  timestamp: number;
  /** Speed in m/s from the device, if available. */
  speed?: number;
  /** Heading in degrees from the device, if available. */
  heading?: number;
}

/**
 * Result of classifying whether a user is on a bus, near one, or waiting at a stop.
 */
export interface OnBusClassification {
  status: OnBusStatus;
  /** Vehicle ID of the matched bus, when applicable. */
  vid?: string;
  /** Motion-correlation confidence score from 0 to 1. */
  confidence: number;
  /** Human-readable explanation of the classification. */
  reason: string;
}

/**
 * Context describing a stop the user is physically standing at.
 */
export interface AtStopContext {
  stopId: StopID;
  stopName: string;
  distanceMeters: number;
  /** 0 when the user is considered to be at the stop. */
  walkTimeSeconds: number;
}

/**
 * Routing context for a user confirmed to be aboard a specific bus.
 */
export interface OnBusContext {
  vid: string;
  tripId: TripID;
  rt: string;
  /** Virtual stop ID injected into the graph, e.g. "ON_BUS_341". */
  virtualStopId: StopID;
  /** Index in the original trip's stopTimes where the user can next alight. */
  boardStopIndex: number;
  busLat: number;
  busLon: number;
  /** Trip copy starting from the virtual on-bus stop. */
  trimmedTrip: Trip;
  classification: OnBusClassification;
  /** Physical stop the bus is currently at/servicing, if stopped at one. */
  currentStopId?: StopID;
  currentStopName?: string;
  isStoppedAtStop: boolean;
}