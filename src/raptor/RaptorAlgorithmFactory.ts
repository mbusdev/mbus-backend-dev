import { Trip } from "./types";
import { Interchange, RaptorAlgorithm, TransfersByOrigin } from "./RaptorAlgorithm";
import { QueueFactory } from "./QueueFactory";
import { RouteScannerFactory, TripsIndexedByRoute } from "./RouteScanner";
import { ScanResultsFactory } from "./ScanResultsFactory";

/**
 * Prepares data for the raptor algorithm
 */
export class RaptorAlgorithmFactory {
  private static readonly DEFAULT_INTERCHANGE_TIME = 0;
  private static readonly OVERTAKING_ROUTE_SUFFIX = "overtakes";

  /**
   * Set up indexes that are required by the Raptor algorithm
   */
  public static create(
    trips: Trip[],
    transfers: TransfersByOrigin,
    interchange: Interchange
  ): RaptorAlgorithm {
    const routesAtStop: Record<string, string[]> = {};
    const tripsByRoute: TripsIndexedByRoute = {};
    const routeStopIndex: Record<string, Record<string, number>> = {};
    const routePath: Record<string, string[]> = {};
    const usefulTransfers: TransfersByOrigin = {};

    trips.sort((a, b) => a.stopTimes[0].departureTime - b.stopTimes[0].departureTime);

    for (const trip of trips) {
      const path = trip.stopTimes.map((s: { stop: string }) => s.stop);
      const routeId = this.getRouteId(trip, tripsByRoute);

      if (!routeStopIndex[routeId]) {
        tripsByRoute[routeId] = [];
        routeStopIndex[routeId] = {};
        routePath[routeId] = path;

        for (let i = path.length - 1; i >= 0; i--) {
          routeStopIndex[routeId][path[i]] = i;
          usefulTransfers[path[i]] = transfers[path[i]] || [];
          interchange[path[i]] = interchange[path[i]] || RaptorAlgorithmFactory.DEFAULT_INTERCHANGE_TIME;
          routesAtStop[path[i]] = routesAtStop[path[i]] || [];

          if (trip.stopTimes[i].pickUp) {
            routesAtStop[path[i]].push(routeId);
          }
        }
      }

      tripsByRoute[routeId].push(trip);
    }
  if (trips.length === 0) {
    for (const stopId of Object.keys(transfers)) {
      usefulTransfers[stopId] = transfers[stopId] || [];
      interchange[stopId] = interchange[stopId] ?? RaptorAlgorithmFactory.DEFAULT_INTERCHANGE_TIME;
      routesAtStop[stopId] = routesAtStop[stopId] || [];
    }
  }

    return new RaptorAlgorithm(
      routeStopIndex,
      routePath,
      usefulTransfers,
      interchange,
      new ScanResultsFactory(Object.keys(usefulTransfers)),
      new QueueFactory(routesAtStop, routeStopIndex),
      new RouteScannerFactory(tripsByRoute)
    );
  }

  private static getRouteId(trip: Trip, tripsByRoute: TripsIndexedByRoute) {
    const routeId = trip.stopTimes.map((s: { stop: string; pickUp: boolean; dropOff: boolean }) => 
      s.stop + (s.pickUp ? 1 : 0) + (s.dropOff ? 1 : 0)
    ).join();

    for (const t of tripsByRoute[routeId] || []) {
      const arrivalTimeA = trip.stopTimes[trip.stopTimes.length - 1].arrivalTime;
      const arrivalTimeB = t.stopTimes[t.stopTimes.length - 1].arrivalTime;

      if (arrivalTimeA < arrivalTimeB) {
        return routeId + RaptorAlgorithmFactory.OVERTAKING_ROUTE_SUFFIX;
      }
    }

    return routeId;
  }
}
