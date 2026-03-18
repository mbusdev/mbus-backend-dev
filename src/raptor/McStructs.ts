import { Transfer, Trip, StopID, Time, StopTime } from "./types";

/**
 * Defines the optimization metrics used to compare different journey options.
 */
export type Criteria = {
    arrivalTime: number;
    walkingDistance: number;
    transferCount: number;
};

/**
 * Represents a state or arrival at a specific stop in the routing graph.
 * Used to trace back the path and store performance metrics.
 */
export class Label {
    /**
     * @param arrivalTime - Time of arrival at this stop.
     * @param walkingDistance - Cumulative walking distance in meters.
     * @param transferCount - Number of transfers taken so far.
     * @param parent - The previous label in the chain (used for backtracking).
     * @param trip - The trip taken to reach this state (if applicable).
     * @param transfer - The transfer used to reach this state (if applicable).
     * @param stop - The ID of the current stop.
     * @param enterTime - Time when the passenger boarded the vehicle.
     * @param stopIndex - Index of the current stop in the trip's sequence.
     */
    constructor(
        public arrivalTime: number,
        public walkingDistance: number,
        public transferCount: number,
        public parent: Label | null = null,
        public trip: Trip | null = null,
        public transfer: Transfer | null = null,
        public stop: StopID | null = null,
        public enterTime: number = 0,
        public stopIndex: number = -1
    ) { }

    /**
     * Determines if this label is strictly better than another label.
     * A label dominates if it is better or equal in all criteria and strictly better in at least one.
     */
    dominates(other: Label): boolean {
        if (this.arrivalTime > other.arrivalTime) return false;
        if (this.walkingDistance > other.walkingDistance) return false;
        if (this.transferCount > other.transferCount) return false;

        return (
            this.arrivalTime < other.arrivalTime ||
            this.walkingDistance < other.walkingDistance ||
            this.transferCount < other.transferCount
        );
    }

    /**
     * Creates a shallow copy of this label.
     */
    clone(): Label {
        return new Label(
            this.arrivalTime,
            this.walkingDistance,
            this.transferCount,
            this.parent,
            this.trip,
            this.transfer,
            this.stop,
            this.enterTime,
            this.stopIndex
        );
    }
}

/**
 * A container for Labels at a specific stop that maintains a Pareto frontier.
 * Only keeps labels that are not dominated by any other label in the bag.
 */
export class Bag {
    labels: Label[] = [];

    /**
     * Attempts to add a label to the bag.
     * @returns True if the label was added (it was non-dominated), False otherwise.
     */
    add(newLabel: Label): boolean {
        for (const label of this.labels) {
            // If an existing label is better than the new one, reject the new one.
            if (label.dominates(newLabel) || (label.arrivalTime === newLabel.arrivalTime
                && label.walkingDistance === newLabel.walkingDistance
                && label.transferCount === newLabel.transferCount)) {
                return false;
            }
        }

        // Remove any existing labels that are now dominated by the new one.
        this.labels = this.labels.filter(label => !newLabel.dominates(label));
        this.labels.push(newLabel);
        return true;
    }

    /**
     * Merges another bag's labels into this one.
     * @returns True if the merge resulted in any changes to this bag.
     */
    merge(otherBag: Bag): boolean {
        let changed = false;
        for (const label of otherBag.labels) {
            if (this.add(label)) {
                changed = true;
            }
        }
        return changed;
    }

    /**
     * Checks if the bag is empty.
     */
    isEmpty(): boolean {
        return this.labels.length === 0;
    }
}