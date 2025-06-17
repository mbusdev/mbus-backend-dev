import { StopID } from "./types";
import { StopTimes } from "./RaptorAlgorithm";
import { ScanResults } from "./ScanResults";

export class ScanResultsFactory {

  constructor(
    private readonly stops: StopID[]
  ) {}

  public create(origins: StopTimes): ScanResults {
    const bestArrivals: Record<StopID, number> = {};
    const kArrivals: Record<number, Record<StopID, number>> = [{}];
    const kConnections: Record<StopID, Record<number, any>> = {};

    for (const stop of this.stops) {
      bestArrivals[stop] = origins[stop] || Number.MAX_SAFE_INTEGER;
      kArrivals[0][stop] = origins[stop] || Number.MAX_SAFE_INTEGER;
      kConnections[stop] = {};
    }

    return new ScanResults(bestArrivals, kArrivals, kConnections);
  }
}
