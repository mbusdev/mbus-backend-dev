import dotenv from "dotenv";
import { getMessaging } from "firebase-admin/messaging";
import { applicationDefault, initializeApp } from "firebase-admin/app";

import * as state from "@/state/transitState";
import { BaseEvent, DelayEvent, eventsEqual, toKey, Key, RegistrationToken, ThresholdEvent, fromKey, delayEvent, thresholdEvent } from "./reminderTypes";

export * from "./reminderTypes";

dotenv.config()

// Initialize Firebase
initializeApp({ credential: applicationDefault() });

/** Waiting for a prediction of the right `event` to have a arrival timestamp that is at or after `mustBeAfter` and an
 *  arrival time less than `thresh`. A bus is xx minutes from the stop notification is then sent. To handle delayed and
 *  disappeared notifications, a `candidateVid` is set to the soonest arriving bus that arrives after `mustbeAfter`.
 */
export type PreThreshold = {
    stage: 0,
    event: BaseEvent,
    /** minutes */
    thresh: number,
    /** unix epoch milliseconds */
    mustBeAfter: number,
    /** stores the bus that'll likely trigger the threshold notification, being only a candidate this can change
    as things are updated and such a change won't trigger a disappeared notification */
    candidateVid: string | null,
    /** minutes */
    candidateVidPredPrev: number | null
};

/** factory */
function preThreshold(event: BaseEvent, thresh: number, candidateVid: string | null, now: number): PreThreshold {
    return {
        stage: 0, event, thresh, mustBeAfter: now + thresh * 60 * 1000, candidateVid, candidateVidPredPrev: null
    };
}

/** Finds the earlies prediction that is after 'mustBeAfter'
 *  REQUIRES: `preds` is sorted ascending by `prdtm`
 */
function firstPredAfter(timestamp: number, preds: state.Prediction[]): state.Prediction | null {
    return preds.find((p) => p.prdtm > timestamp) ?? null;
}

/** Waiting for the bus indicated by `vid` to be at the stop indicated by `stpid`. Logic for what notification to send
 *  is complicated by arrival times sometimes skipping DUE, see `ReminderSubscriptons.process` for details.
 */
export type PostThreshold = { stage: 1, event: BaseEvent, vid: string, vidPredPrev: number | null };

/** factory */
function postThreshold(prev: PreThreshold, vid: string): PostThreshold {
    return {
        stage: 1, event: prev.event, vid, vidPredPrev: prev.candidateVid === vid ? prev.candidateVidPredPrev : null
    };
}

function prdctdnToNum(prdctdn: string): number {
    return prdctdn === 'DUE' ? 1 : parseInt(prdctdn);
}

/** result of ReminderSubscriptons.process */
type RemindersToTrigger = {
    /** can be sent in bulk based off of route, stop, and threshold (or route, stop, and prdctdn) */
    reminder: Map<Key<ThresholdEvent>, Set<RegistrationToken>>,
    /** can be sent in bulk based off of what route and stop */
    atTheStop: Map<Key<BaseEvent>, Set<RegistrationToken>>,
    /** can be sent in bulk based off of route and stop */
    disappeared: Map<Key<BaseEvent>, Set<RegistrationToken>>,
    /** can be sent in bulk based off of route, stop, delay amount, arrival time (or vid?) */
    delayed: Map<Key<DelayEvent>, Set<RegistrationToken>>,
    updated: Set<RegistrationToken>
}; 

/** Subscriptions go through a pipeline, see types above for details. */
class ReminderSubscriptions {
    subscriptions: Array<{
        token: RegistrationToken, subscription: PreThreshold | PostThreshold
    }>

    constructor() {
        this.subscriptions = [];
    }

    /** Adds a new subscription, uses prediction data to determine a candidate vid.
        REQUIRES: `predsByStopId` has predictions sorted by arrival timestamp
    */
    add(event: BaseEvent, thresh: number, token: RegistrationToken, predsByStopId: Record<string, state.Prediction[]>, now: number) {
        console.log("Adding a reminder subscription");
        const predictions = predsByStopId[event.stpid];
        const subscription = preThreshold(event, thresh, null, now);
        if (predictions) {
            const relevant = predictions
                .filter((p) => p.rt === event.rtid);
            subscription.candidateVid = firstPredAfter(subscription.mustBeAfter, relevant)?.vid ?? null;
        }
        this.subscriptions.push({ token, subscription });
        sendReminderUpdateToAll(new Set([token]));
    }

    /** removes all subscriptions that involve both `event` and `token` */
    remove(event: BaseEvent, token: RegistrationToken) {
        console.log("Removing a reminder subscription");
        this.subscriptions = this.subscriptions
            .filter((s) => s.token != token || !eventsEqual(s.subscription.event, event))
        sendReminderUpdateToAll(new Set([token]));
    }

    /**  updates the status of all registrations, returning an object representing the
        notifications that should be sent

         - threshold reminders are sent only for subscriptions of `PreThreshold`, and trigger when the candidate
         vehicle has an arrival time at or under `thresh` and an arrival timestamp after `mustBeAfter`
         - at the stop reminders are sent only for subscriptions of `PostThreshold` and trigger when the tracked
         vehicle has a `pred` of 1/0 or if `pred` becomes `null` and `vidPredPrev <= shouldBeArrivingThresh`
         - disappeared reminders are sent in both stages
             - stage 0 if there no longer is a valid `candidateVid`
             - stage 1 if the relevant `pred` of the tracked vehicle becomes `null` and the the bus isn't too close to
             the stop
        - delayed reminders are sent in both stages
            - stage 0 if the relevant `pred` of the candidate vehicle increases (can also happen from the candidate
            vehicle changing)
            - stage 1 if the relevant `pred` goes up and it doesn't seem like the bus going past the stop (this is
            still relevant even when tracking a specific vehicle if routes loop back on themselves weirdly)

        REQUIRES: `predsByStopId` and `predsByVid` have predictions sorted by arrival timestamp
      */
    process(
        predsByStopId: Record<string, state.Prediction[] | undefined>,
        predsByVid: Record<string, state.Prediction[] | undefined>,
        now: number,
    ): RemindersToTrigger {
        const addHelper = <K, T>(map: Map<Key<K>, Set<T>>, key: Key<K>, contents: T) => {
            let tokens = map.get(key);
            if (tokens === undefined) {
                map.set(key, new Set());
                tokens = map.get(key)!;
            }
            tokens.add(contents);
        };
        const notifications: RemindersToTrigger = {
            reminder: new Map(),
            atTheStop: new Map(),
            disappeared: new Map(),
            delayed: new Map(),
            updated: new Set<RegistrationToken>()
        };

        const newSubscriptions: typeof this.subscriptions = [];
        for (const s of this.subscriptions) {
            // only one is sent, variable order is priority
            let disappeared: BaseEvent | null = null;
            let delayed: DelayEvent | null = null;
            let threshold: ThresholdEvent | null = null;
            let ats: BaseEvent | null = null;

            let timeChanged = false;

            if (s.subscription.stage === 0) {
                // did the candidate vehicle change?
                // PERF: caching these filter results might be good
                const relevantPreds = (predsByStopId[s.subscription.event.stpid] ?? [])
                    .filter((p) => p.rt === s.subscription.event.rtid);
                const newCandidate = firstPredAfter(
                    s.subscription.mustBeAfter,
                    relevantPreds
                );
                if (newCandidate === null) {
                    if (s.subscription.candidateVid !== null) {
                        // no candidate now + existed before
                        disappeared = s.subscription.event;
                    }
                } else {
                    const pred = prdctdnToNum(newCandidate.prdctdn);
                    if (s.subscription.candidateVidPredPrev !== pred) {
                        timeChanged = true;
                    }
                    if (newCandidate.vid !== s.subscription.candidateVid) {
                        // new candidate
                        console.log(`stage 0: new candidate, time is now ${pred}`);
                        s.subscription.candidateVid = newCandidate.vid;
                    } else {
                        // same candidate
                        console.log(`stage 0: same candidate, time is now ${pred}`);
                    }
                    if (s.subscription.candidateVidPredPrev !== null
                        && pred > s.subscription.candidateVidPredPrev
                    ) {
                        // delayed
                        delayed = delayEvent(
                            { ...s.subscription.event, prevPred: s.subscription.candidateVidPredPrev, currPred: pred }
                        );
                    }
                    s.subscription.candidateVidPredPrev = pred;
                    if (newCandidate.prdtm > s.subscription.mustBeAfter && pred <= s.subscription.thresh) {
                        threshold = thresholdEvent({ ...s.subscription.event, threshold: s.subscription.thresh })
                    }
                }
            } else {
                // There might be times where the prediction of the bus skips past DUE/1, which results in a
                // disappeared or delayed notification when there really shouldn't be. `shouldBeArrivingThresh`
                // overrides a bus disappeared notification with an at the stop one if the arrival time is at or below
                // it. It also overrides a delayed notification if the delay amount is more than
                // `maxDelayWhenShouldBeArriving`
                const shouldBeArrivingThresh = 3;
                const maxDelayWhenShouldBeArriving = 1;

                const prdctdn = (predsByVid[s.subscription.vid] ?? [])
                    .find((p) => p.stpid === s.subscription.event.stpid)?.prdctdn ?? null;
                const currArrivalTime = prdctdn == null ? null : prdctdnToNum(prdctdn);
                const prevArrivalTime = s.subscription.vidPredPrev;

                console.log(`stage 1: time is now ${currArrivalTime}`);

                if (currArrivalTime !== prevArrivalTime) {
                    timeChanged = true;
                }
                if (currArrivalTime === null) {
                    // disappeared
                    if (prevArrivalTime !== null && prevArrivalTime <= shouldBeArrivingThresh
                    ) {
                        // override
                        console.log("disappeared notification was overriden!");
                        ats = s.subscription.event;
                    } else {
                        console.log("disappeared notification!");
                        disappeared = s.subscription.event;
                    }
                } else if (currArrivalTime === 1) {
                    // at the stop
                    ats = s.subscription.event;
                } else if (prevArrivalTime !== null && currArrivalTime > prevArrivalTime) {
                    // delayed
                    if (prevArrivalTime <= shouldBeArrivingThresh
                        && currArrivalTime - prevArrivalTime > maxDelayWhenShouldBeArriving
                    ) {
                        // override
                        console.log("delayed notification was overriden!");
                        ats = s.subscription.event;
                    } else {
                        console.log("delayed notification!");
                        delayed = delayEvent(
                            { ...s.subscription.event, prevPred: prevArrivalTime, currPred: currArrivalTime }
                        );
                    }
                }
                s.subscription.vidPredPrev = currArrivalTime;
            }

            if (disappeared || delayed|| threshold || ats || delayed || timeChanged) {
                notifications.updated.add(s.token);
            }

            if (disappeared) {
                addHelper(notifications.disappeared, toKey(disappeared), s.token);
            } else if (delayed) {
                addHelper(notifications.delayed, toKey(delayed), s.token);
                newSubscriptions.push(s);
            } else if (threshold) {
                addHelper(notifications.reminder, toKey(threshold), s.token);
                if (s.subscription.stage !== 0) {
                    throw Error("A PostTheshold subscription tried to trigger a threshold notification");
                }
                if (s.subscription.candidateVid === null) {
                    throw Error("A threshold notification was triggered without a corresponding vid");
                }
                newSubscriptions.push(
                    { token: s.token, subscription: postThreshold(s.subscription, s.subscription.candidateVid) }
                );
            } else if (ats) {
                addHelper(notifications.atTheStop, toKey(ats), s.token);
            } else {
                newSubscriptions.push(s);
            }
        }
        this.subscriptions = newSubscriptions;
        if (notifications.reminder.size !== 0
            || notifications.atTheStop.size !== 0
            || notifications.delayed.size !== 0
            || notifications.disappeared.size !== 0
        ) {
            console.log(
                `Process completed with ${notifications.reminder.size} threshold reminders, `
                + `${notifications.atTheStop.size} at the stop reminders, `
                + `${notifications.delayed.size} delayed notifications, `
                + `${notifications.disappeared.size} disappeared notifications`
            );
        }
        return notifications;
    }

    swapToken(from: RegistrationToken, to: RegistrationToken) {
        this.subscriptions = this.subscriptions.map((s) => {
            if (s.token === from) {
                return { ...s, token: to };
            } else {
                return s;
            }
        });
    }

    activeRemindersFor(id: RegistrationToken): Array<PreThreshold | PostThreshold> {
        return this.subscriptions
            .filter((s) => s.token === id)
            .map((s) => {
                return s.subscription;
            });
    }
}

export const universityReminderSubscriptions = new ReminderSubscriptions();
export const rideReminderSubscriptions = new ReminderSubscriptions();

export function processUniversityReminders() {
    try {
        processRemindersHelper(universityReminderSubscriptions, state.cachedPredsByStopId, state.cachedPredsByVid);
    } catch (e) {
        console.log("Processing university reminders failed");
        console.log(`${JSON.stringify(e)}`);
    }
}

export function processRideReminders() {
    try {
        processRemindersHelper(rideReminderSubscriptions, state.cachedRidePredsByStopId, state.cachedRidePredsByVid);
    } catch (e) {
        console.log("Processing ride reminders failed");
        console.log(`${JSON.stringify(e)}`);
    }
}

function processRemindersHelper(
    reminderSubscriptions: ReminderSubscriptions,
    predsByStopId: Record<string, state.Prediction[] | undefined>,
    predsByVid: Record<string, state.Prediction[] | undefined>
) {
    const notifications = reminderSubscriptions.process(predsByStopId, predsByVid, Date.now());
    for (const [eventKey, tokens] of notifications.reminder) {
        const event = fromKey(eventKey);
        const stopName = state.stopIdToName[event.stpid] ?? event.stpid;;
        sendNotifToAll(
            {
                title: 'Bus Arrival Reminder',
                body: `${event.rtid} is less than ${event.threshold} minute(s) away from ${stopName}`
            },
            tokens
        );
    }
    for (const [eventKey, tokens] of notifications.atTheStop) {
        const event = fromKey(eventKey);
        let stopName = event.stpid;
        const universityName = state.stopIdToName[event.stpid];
        const rideName = state.rideStopIdToName[event.stpid];
        if (universityName) {
            stopName = universityName;
        }
        if (rideName) {
            stopName = rideName;
        }
        sendToAll(
            {
                notification: { title: 'Bus Arriving', body: `${event.rtid} is almost at ${stopName}` },
            },
            tokens
        );
    }
    for (const [eventKey, tokens] of notifications.delayed) {
        const event = fromKey(eventKey);
        const stopName = state.stopIdToName[event.stpid] ?? event.stpid;;
        sendNotifToAll(
            {
                title: `Bus Delayed`,
                body: `The ${event.rtid} bus en route to ${stopName} got delayed by ${event.currPred - event.prevPred}`
                    + `minute(s). New time is ${event.currPred} minute(s).`
            },
            tokens
        );
    }
    for (const [eventKey, tokens] of notifications.disappeared) {
        const event = fromKey(eventKey);
        let stopName = event.stpid;
        const universityName = state.stopIdToName[event.stpid];
        const rideName = state.rideStopIdToName[event.stpid];
        if (universityName) {
            stopName = universityName;
        }
        if (rideName) {
            stopName = rideName;
        }
        sendNotifToAll(
            {
                title: `Bus Disappeared`,
                body: `The ${event.rtid} bus en route to ${stopName} disappeared! Set a new reminder if desired.`
            },
            tokens
        );
    }
    // send reminder updates
    sendReminderUpdateToAll(notifications.updated);
}

// tell clients to fetch active reminders again, should be called when
// arrival times change or reminders are added, removed, or completed
function sendReminderUpdateToAll(tokens: Set<string>) {
    sendToAll({
        data: { kind: "reminderUpdate" }
    }, tokens);
}

export function sendNotifToAll(notif: { title: string, body: string }, tokens: Set<string>) {
    sendToAll(
        { notification: notif },
        // { notification: notif, data: notif/*android: { notification: { ...notif, channel_id: "high_importance_channel" }}*/ },
        tokens
    );
}

function sendToAll(msg: any, tokens: Set<string>) {
    if (tokens.size === 0) return;
    console.log(`sending a message to ${tokens.size} devices`);
    console.log(`msg is ${JSON.stringify(msg)}`);
    const group = new Set<string>();
    for (const token of tokens) {
        if (group.size === 500) {
            sendToAllHelper(msg, group);
            group.clear();
        }
        group.add(token);
    }
    sendToAllHelper(msg, group);
}

// REQUIRES: tokens.size <= 500
function sendToAllHelper(msg: any, tokens: Set<string>) {
    console.log(`helper sending to ${tokens.size}`);
    const payload = { tokens: Array.from(tokens), ...msg };
    console.log(`payload: ${JSON.stringify(payload)}`);
    getMessaging().sendEachForMulticast(payload)
        .then((res) => {
            if (res.failureCount > 0) {
                console.log(`${res.failureCount} messages failed to send!`);
                res.responses.forEach((res, idx) => {
                    if (!res.success) {
                        console.log(`message send ${idx} failed`);
                        console.log(res.error);
                        console.log(`tokens was: ${JSON.stringify(Array.from(tokens))}`);
                    }
                })
            }
        });
}

export function infoToUseForRoute(rtid: string): {
    reminderSubscriptions: ReminderSubscriptions,
    predsByStopId: typeof state.cachedPredsByStopId,
    predsByVid: typeof state.cachedPredsByVid
} | null {
    if (state.validRoutes.has(rtid)) {
        return {
            reminderSubscriptions: universityReminderSubscriptions,
            predsByStopId: state.cachedPredsByStopId,
            predsByVid: state.cachedPredsByVid,
        };
    } else if (state.validRideRoutes.has(rtid)) {
        return {
            reminderSubscriptions: rideReminderSubscriptions,
            predsByStopId: state.cachedRidePredsByStopId,
            predsByVid: state.cachedRidePredsByVid,
        };
    } else {
        return null;
    }
}

/** exported for tests */
export const testing = {
    ReminderSubscriptions,
    eventsEqual
};
