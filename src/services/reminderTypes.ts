/** The utility and POD types used for reminders */

import stringify from "fast-json-stable-stringify";

export type Key<T> = string & { readonly __brand: "key", readonly __phantomData: T };

/** REQUIRES: the value passed in is safe to stringify */
export function toKey<T>(x: T): Key<T> {
    return stringify(x) as Key<T>;
}

export function fromKey<T>(key: Key<T>): T {
    return JSON.parse(key);
}

/** internal */
type CoreEvent = {
    stpid: string,
    rtid: string,
}

export type BaseEvent = CoreEvent & {
    readonly __brand: "event"
}

export function sameBaseEvent(e1: CoreEvent, e2: CoreEvent): boolean {
    return e1.stpid === e2.stpid && e1.rtid === e2.rtid;
}

export function eventsEqual(e1: BaseEvent, e2: BaseEvent): boolean {
    return e1.stpid === e2.stpid && e1.rtid === e2.rtid;
}

/** factory */
export function baseEvent(x: { stpid: string, rtid: string }): BaseEvent {
    return Object.freeze(x) as BaseEvent;
}

export type ThresholdEvent = CoreEvent & {
    threshold: number,
    readonly __brand: "thresholdEvent"
};

/** factory */
export function thresholdEvent(x: { stpid: string, rtid: string, threshold: number }): ThresholdEvent {
    return x as ThresholdEvent;
}

export type DelayEvent = CoreEvent & {
    prevPred: number,
    currPred: number,    
    readonly __brand: "delayEvent"
};

/** factory */
export function delayEvent(x: { stpid: string, rtid: string, prevPred: number, currPred: number }): DelayEvent {
    return x as DelayEvent;
}


export type RegistrationToken = string & { readonly __brand: "registrationToken" }

export function registrationToken(x: string): RegistrationToken {
    return x as RegistrationToken;
}

