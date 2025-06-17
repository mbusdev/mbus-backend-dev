import { RaptorAlgorithm, StopTimes } from "../raptor/RaptorAlgorithm";
import { StopID, Time } from "../raptor/types";
import { ResultsFactory } from "../results/ResultsFactory";
import { Journey } from "../results/Journey";
import { JourneyFilter } from "../results/filter/JourneyFilter";
import { keyValue } from "ts-array-utils";
import { Arrivals, ConnectionIndex } from "../raptor/ScanResults";

/**
 * Implementation of Raptor that searches for journeys between a set of origin and destinations.
 *
 * Only returns results from a single pass of the Raptor algorithm.
 */
export class GroupStationDepartAfterQuery {
  constructor(
    private readonly raptor: RaptorAlgorithm,
    private readonly resultsFactory: ResultsFactory,
    private readonly filters: JourneyFilter[] = []
  ) { }

  /**
   * Plan a journey between the origin and destination set of stops at the given time
   */
  public plan(origins: StopID[], destinations: StopID[], time: Time): Journey[] {
    // set the departure time for each origin
    const originTimes = origins.reduce(keyValue(origin => [origin, time]), {});

    // get results for every destination and flatten into a single array
    const results = this.getJourneys(originTimes, destinations);

    // apply each filter to the results
    return this.filters.reduce((rs, filter) => filter.apply(rs), results);
  }

  /**
   * Find journeys using the raptor object
   */
  private getJourneys(origins: StopTimes, destinations: StopID[]): Journey[] {
    const [kConnections, bestArrivals] = this.raptor.scan(origins);
    return this.getJourneysFromConnections(kConnections, destinations);
  }

  /**
   * Create journeys from the connection results
   */
  private getJourneysFromConnections(
    kConnections: ConnectionIndex,
    destinations: StopID[]
  ): Journey[] {
    const destinationsWithResults = destinations.filter(d => Object.keys(kConnections[d]).length > 0);
    return destinationsWithResults.flatMap(d => this.resultsFactory.getResults(kConnections, d));
  }
}
