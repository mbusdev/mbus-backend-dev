/** The utility and POD types used for reminders */

/** @internal */
export type CoreEvent = {
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
    exactly: boolean,
    readonly __brand: "thresholdEvent"
};

/** factory */
export function thresholdEvent(
    x: { stpid: string, rtid: string, threshold: number, exactly: boolean }
): ThresholdEvent {
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

