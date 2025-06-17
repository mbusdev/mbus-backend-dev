import { RaptorAlgorithm } from "../raptor/RaptorAlgorithm";
import { StopID, Time } from "../raptor/types";
import { ResultsFactory } from "../results/ResultsFactory";
import { Journey } from "../results/Journey";
import { GroupStationDepartAfterQuery } from "./GroupStationDepartAfterQuery";

/**
 * Implementation of Raptor that searches for journeys departing after a specific time.
 *
 * Only returns results from a single pass of the Raptor algorithm.
 */
export class DepartAfterQuery {

  private readonly groupQuery: GroupStationDepartAfterQuery;

  constructor(
    private readonly raptor: RaptorAlgorithm,
    private readonly resultsFactory: ResultsFactory
  ) {
    this.groupQuery = new GroupStationDepartAfterQuery(raptor, resultsFactory);
  }

  /**
   * Plan a journey between the origin and destination at the given time.
   */
  public plan(origin: StopID, destination: StopID, time: Time): Journey[] {
    return this.groupQuery.plan([origin], [destination], time);
  }

}
