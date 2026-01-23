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