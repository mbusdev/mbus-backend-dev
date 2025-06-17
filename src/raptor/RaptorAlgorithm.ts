import { StopID, Time, Transfer, Trip } from "./types";
import { QueueFactory } from "./QueueFactory";
import { RouteID, RouteScanner, RouteScannerFactory } from "./RouteScanner";
import { Arrivals, ConnectionIndex, ScanResults } from "./ScanResults";
import { ScanResultsFactory } from "./ScanResultsFactory";

/**
 * Implementation of the Raptor journey planning algorithm
 */
export class RaptorAlgorithm {
  private static DEBUG = false;

  constructor(
    private readonly routeStopIndex: RouteStopIndex,
    private readonly routePath: RoutePaths,
    private readonly transfers: TransfersByOrigin,
    private readonly interchange: Interchange,
    private readonly scanResultsFactory: ScanResultsFactory,
    private readonly queueFactory: QueueFactory,
    private readonly routeScannerFactory: RouteScannerFactory
  ) { }

  /**
   * Enable or disable debug logging
   */
  public static setDebug(debug: boolean) {
    RaptorAlgorithm.DEBUG = debug;
  }

  /**
   * Perform a plan of the routes at a given time and return the resulting kConnections index
   */
  public scan(origins: StopTimes): [ConnectionIndex, Arrivals] {
    if (RaptorAlgorithm.DEBUG) {
      console.log('Starting Raptor scan with origins:', origins);
      console.log('Available routes:', Object.keys(this.routePath));
      console.log('Available transfers:', Object.keys(this.transfers));
    }

    const routeScanner = this.routeScannerFactory.create();
    const results = this.scanResultsFactory.create(origins);
    let markedStops = Object.keys(origins);

    if (RaptorAlgorithm.DEBUG) {
      console.log('Initial marked stops:', markedStops);
    }

    let round = 0;
    while (markedStops.length > 0) {
      round++;
      if (RaptorAlgorithm.DEBUG) {
        console.log(`\nStarting round ${round}`);
        console.log('Marked stops:', markedStops);
      }

      results.addRound();

      this.scanRoutes(results, routeScanner, markedStops);
      this.scanTransfers(results, markedStops);

      markedStops = results.getMarkedStops();
      
      if (RaptorAlgorithm.DEBUG) {
        console.log(`Round ${round} complete. New marked stops:`, markedStops);
        console.log('Best arrivals:', results.bestArrival);
      }
    }

    const [kConnections, bestArrivals] = results.finalize();
    
    if (RaptorAlgorithm.DEBUG) {
      console.log('\nScan complete:');
      console.log('Final best arrivals:', bestArrivals);
      console.log('Final kConnections:', Object.keys(kConnections).map(k => ({
        stop: k,
        connections: Object.keys(kConnections[k]).length
      })));
    }

    return [kConnections, bestArrivals];
  }

  private scanRoutes(results: ScanResults, routeScanner: RouteScanner, markedStops: StopID[]): void {
    const queue = this.queueFactory.getQueue(markedStops);

    if (RaptorAlgorithm.DEBUG) {
      console.log('Scanning routes with queue:', queue);
    }

    for (const [routeId, stopP] of Object.entries(queue)) {
      if (RaptorAlgorithm.DEBUG) {
        console.log(`\nScanning route ${routeId} from stop ${stopP}`);
      }

      let boardingPoint = -1;
      let trip: Trip | undefined = undefined;

      for (let pi = this.routeStopIndex[routeId][stopP]; pi < this.routePath[routeId].length; pi++) {
        const stopPi = this.routePath[routeId][pi];
        const i = this.interchange[stopPi];
        const previousArrival = results.previousArrival(stopPi);

        if (RaptorAlgorithm.DEBUG) {
          console.log(`  Checking stop ${stopPi}:`);
          console.log(`    Previous arrival: ${previousArrival}`);
          console.log(`    Current best arrival: ${results.bestArrival(stopPi)}`);
        }

        if (trip && trip.stopTimes[pi].dropOff && trip.stopTimes[pi].arrivalTime + i < results.bestArrival(stopPi)) {
          if (RaptorAlgorithm.DEBUG) {
            console.log(`    Found better arrival via trip ${trip.tripId}`);
          }
          results.setTrip(trip, boardingPoint, pi, i);
        }
        else if (previousArrival && (!trip || previousArrival < trip.stopTimes[pi].arrivalTime + i)) {
          const newTrip = routeScanner.getTrip(routeId, pi, previousArrival);

          if (newTrip) {
            if (RaptorAlgorithm.DEBUG) {
              console.log(`    Found new trip ${newTrip.tripId}`);
            }
            trip = newTrip;
            boardingPoint = pi;
          }
        }
      }
    }
  }

  private scanTransfers(results: ScanResults, markedStops: StopID[]): void {
    if (RaptorAlgorithm.DEBUG) {
      console.log('\nScanning transfers from stops:', markedStops);
    }

    for (const stopP of markedStops) {
      const transfers = this.transfers[stopP] || [];
      if (RaptorAlgorithm.DEBUG) {
        console.log(`\nChecking transfers from ${stopP}:`, transfers.length);
      }

      for (const transfer of transfers) {
        const stopPi = transfer.destination;
        const arrival = results.previousArrival(stopP) + transfer.duration + this.interchange[stopPi];

        if (RaptorAlgorithm.DEBUG) {
          console.log(`  Transfer to ${stopPi}:`);
          console.log(`    Previous arrival: ${results.previousArrival(stopP)}`);
          console.log(`    Transfer duration: ${transfer.duration}`);
          console.log(`    Interchange: ${this.interchange[stopPi]}`);
          console.log(`    Total arrival: ${arrival}`);
          console.log(`    Current best: ${results.bestArrival(stopPi)}`);
        }

        if (transfer.startTime <= arrival && transfer.endTime >= arrival && arrival < results.bestArrival(stopPi)) {
          if (RaptorAlgorithm.DEBUG) {
            console.log(`    Found better arrival via transfer`);
          }
          results.setTransfer(transfer, arrival);
        }
      }
    }
  }
}

export type RouteStopIndex = Record<RouteID, Record<StopID, number>>;
export type RoutePaths = Record<RouteID, StopID[]>;
export type Interchange = Record<StopID, Time>;
export type TransfersByOrigin = Record<StopID, Transfer[]>;
export type StopTimes = Record<StopID, Time>;
