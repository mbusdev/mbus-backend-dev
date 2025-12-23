import { Transfer, Trip, StopID, Time, StopTime } from "./types";

export type Criteria = {
    arrivalTime: number;
    walkingDistance: number;
    transferCount: number;
};

export class Label {
    constructor(
        public arrivalTime: number,
        public walkingDistance: number,
        public transferCount: number,
        public parent: Label | null = null,
        public trip: Trip | null = null,
        public transfer: Transfer | null = null,
        public stop: StopID | null = null,
        public enterTime: number = 0
    ) { }

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

    clone(): Label {
        return new Label(
            this.arrivalTime,
            this.walkingDistance,
            this.transferCount,
            this.parent,
            this.trip,
            this.transfer,
            this.stop,
            this.enterTime
        );
    }
}

export class Bag {
    labels: Label[] = [];

    add(newLabel: Label): boolean {
        for (const label of this.labels) {
            if (label.dominates(newLabel)) {
                return false;
            }
        }

        this.labels = this.labels.filter(label => !newLabel.dominates(label));
        this.labels.push(newLabel);
        return true;
    }

    merge(otherBag: Bag): boolean {
        let changed = false;
        for (const label of otherBag.labels) {
            if (this.add(label)) {
                changed = true;
            }
        }
        return changed;
    }

    isEmpty(): boolean {
        return this.labels.length === 0;
    }
}
