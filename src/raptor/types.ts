/**
 * StopID e.g. NRW
 */
export type StopID = string;

/**
 * Time in seconds since midnight (note this may be greater than 24 hours).
 */
export type Time = number;

/**
 * Duration in seconds
 */
export type Duration = number;

/**
 * GTFS stop time
 */
export interface StopTime {
  stop: StopID;
  arrivalTime: Time;
  departureTime: Time;
  pickUp: boolean;
  dropOff: boolean;
}

/**
 * Leg of a journey
 */
export interface Leg {
  origin: StopID;
  destination: StopID;
}

/**
 * Leg with a defined departure and arrival time
 */
export interface TimetableLeg extends Leg {
  stopTimes: StopTime[];
  trip: Trip;
}

/**
 * Leg with a duration instead of departure and arrival time
 */
export interface Transfer extends Leg {
  duration: Duration;
  startTime: Time;
  endTime: Time;
}

/**
 * GTFS trip_id
 */
export type TripID = string;

/**
 * GTFS trip
 */
export interface Trip {
  tripId: TripID;
  stopTimes: StopTime[];
}

/**
 * Transfers indexed by origin stop
 */
export type TransfersByOrigin = Record<StopID, Transfer[]>;

/**
 * Interchange times indexed by stop
 */
export type Interchange = Record<StopID, Time>;
