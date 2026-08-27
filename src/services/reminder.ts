import dotenv from "dotenv";
import { getMessaging } from "firebase-admin/messaging";
import { applicationDefault, initializeApp } from "firebase-admin/app";

import * as state from "@/state/transitState";
import { BaseEvent, DelayEvent, eventsEqual, toKey, Key, RegistrationToken, ThresholdEvent, fromKey, delayEvent, thresholdEvent } from "./reminderTypes";

export * from "./reminderTypes";

dotenv.config()

let firebaseInitialized = false;
export function initializeReminders() {
    // Initialize Firebase. Idempotent: initializeApp throws on a second call,
    // and callers (entry points, tests) must be able to invoke this safely.
    if (firebaseInitialized) return;
    firebaseInitialized = true;
    initializeApp({ credential: applicationDefault() });
}

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
    candidateVidPredPrev: number | null,
    /** unix epoch milliseconds of the candidate's predicted arrival */
    candidatePrdtm: number | null
};

/** factory */
function preThreshold(event: BaseEvent, thresh: number, candidateVid: string | null, now: number): PreThreshold {
    return {
        stage: 0, event, thresh, mustBeAfter: now + thresh * 60 * 1000,
        candidateVid, candidateVidPredPrev: null, candidatePrdtm: null
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
export type PostThreshold = {
    stage: 1,
    event: BaseEvent,
    vid: string,
    vidPredPrev: number | null,
    /** predicted arrival timestamp (epoch ms) of the tracked pass. Predictions
     *  are matched by PROXIMITY to this: an early-running bus stays matched
     *  (a frozen lower cutoff would drop it and fire a false "disappeared"),
     *  while the same looping vehicle's other passes stay excluded. */
    expectedPrdtm: number
};

/** factory */
function postThreshold(prev: PreThreshold, vid: string): PostThreshold {
    return {
        stage: 1, event: prev.event, vid,
        vidPredPrev: prev.candidateVid === vid ? prev.candidateVidPredPrev : null,
        expectedPrdtm: prev.candidatePrdtm ?? prev.mustBeAfter
    };
}

function prdctdnToNum(prdctdn: string): number {
    return prdctdn === 'DUE' ? 1 : parseInt(prdctdn);
}

/** Delayed buses ("DLY") are surfaced to prediction endpoints but carry no
 *  usable countdown, so the reminder pipeline must never track them. */
function hasUsableCountdown(p: state.Prediction): boolean {
    return Number.isFinite(prdctdnToNum(p.prdctdn));
}

/** result of ReminderSubscriptons.process */
export type RemindersToTrigger = {
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
export class ReminderSubscriptions {
    subscriptions: Array<{
        token: RegistrationToken, subscription: PreThreshold | PostThreshold, createdAt: number
    }>;
    pure: boolean;

    /** set mock to true for tests that don't involve firebase */
    constructor(options: { mock: boolean }) {
        this.pure = options.mock;
        this.subscriptions = [];
    }

    /** Adds a new subscription, uses prediction data to determine a candidate vid. Existing reminders for the same
        event and token are removed.
        REQUIRES: `predsByStopId` has predictions sorted by arrival timestamp
    */
    add(
        event: BaseEvent,
        thresh: number,
        token: RegistrationToken,
        predsByStopId: Record<string, state.Prediction[]>,
        now: number,
        options?: { noUpdate: boolean },
    ) {
        console.log("Adding a reminder subscription");
        const predictions = predsByStopId[event.stpid];
        const subscription = preThreshold(event, thresh, null, now);
        if (predictions) {
            const relevant = predictions
                .filter((p) => p.rt === event.rtid && hasUsableCountdown(p));
            // Prefer a trackable (vid-assigned) bus over a vid-less schedule
            // row, which would hold the threshold indefinitely.
            const candidate = firstPredAfter(subscription.mustBeAfter, relevant.filter((p) => p.vid))
                ?? firstPredAfter(subscription.mustBeAfter, relevant);
            // || null: schedule-based feed rows carry vid "" until a vehicle
            // is assigned; those cannot be tracked in stage 1.
            subscription.candidateVid = candidate?.vid || null;
            subscription.candidatePrdtm = candidate?.prdtm ?? null;
            if (candidate?.prdctdn) {
                subscription.candidateVidPredPrev = prdctdnToNum(candidate?.prdctdn);
            } else {
                subscription.candidateVidPredPrev = null;
            }
        }
        // remove existing
        this.remove(event, token, { noUpdate: true });
        this.subscriptions.push({ token, subscription, createdAt: now });
        if (options?.noUpdate || this.pure) return;
        sendReminderUpdateToAll(new Set([token]));
    }

    /** removes all subscriptions that involve both `event` and `token` */
    remove(event: BaseEvent, token: RegistrationToken, options?: { noUpdate: boolean }) {
        console.log("Removing a reminder subscription");
        this.subscriptions = this.subscriptions
            .filter((s) => s.token != token || !eventsEqual(s.subscription.event, event))
        if (options?.noUpdate || this.pure) return;
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

        // Reminders are short-lived by nature: expire stale subscriptions so
        // no-candidate zombies and dead-token entries cannot accumulate
        // forever (or fire a bogus stale reminder the next service day).
        const SUBSCRIPTION_TTL_MS = 3 * 60 * 60 * 1000;

        const newSubscriptions: typeof this.subscriptions = [];
        for (const s of this.subscriptions) {
            if (now - s.createdAt > SUBSCRIPTION_TTL_MS) {
                notifications.updated.add(s.token);
                continue;
            }
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
                    .filter((p) => p.rt === s.subscription.event.rtid && hasUsableCountdown(p));
                // Same preference as add(): a trackable vid'd bus beats a
                // vid-less schedule row.
                const newCandidate = firstPredAfter(s.subscription.mustBeAfter, relevantPreds.filter((p) => p.vid))
                    ?? firstPredAfter(s.subscription.mustBeAfter, relevantPreds);
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
                    // || null: schedule-based feed rows carry vid "" (or none)
                    // until a vehicle is assigned; an empty-string candidate
                    // would slip past === null guards into untrackable stage 1.
                    if ((newCandidate.vid || null) !== s.subscription.candidateVid) {
                        // new candidate
                        console.log(`stage 0: new candidate, time is now ${pred}`);
                        s.subscription.candidateVid = newCandidate.vid || null;
                    } else {
                        // same candidate
                        console.log(`stage 0: same candidate, time is now ${pred}`);
                    }
                    s.subscription.candidatePrdtm = newCandidate.prdtm;
                    if (s.subscription.candidateVidPredPrev !== null
                        && pred > s.subscription.candidateVidPredPrev
                    ) {
                        // delayed
                        delayed = delayEvent(
                            { ...s.subscription.event, prevPred: s.subscription.candidateVidPredPrev, currPred: pred }
                        );
                    }
                    s.subscription.candidateVidPredPrev = pred;
                    // A vid-less (schedule-based) candidate cannot be tracked
                    // in stage 1: hold the threshold until a vehicle is
                    // assigned, which happens as the bus enters service.
                    if (newCandidate.prdtm > s.subscription.mustBeAfter && pred <= s.subscription.thresh
                        && s.subscription.candidateVid !== null) {
                        threshold = thresholdEvent({
                            ...s.subscription.event,
                            threshold: s.subscription.thresh,
                            exactly: pred == s.subscription.thresh
                        });
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

                // A vanished pass is only inferred as "arrived" when the bus
                // was already this close (minutes); farther out, a big
                // prediction jump is far more likely a delay than an arrival.
                const arrivalInferenceMax = 5;

                // Track the pass by PROXIMITY to its expected arrival: a bus
                // running a few minutes early stays matched, while the same
                // looping vehicle's other passes (typically >= 8 minutes away)
                // stay excluded and cannot masquerade as a huge delay.
                const PASS_MATCH_SLACK_MS = 5 * 60 * 1000;
                const expected = s.subscription.expectedPrdtm;
                const allStopPreds = (predsByVid[s.subscription.vid] ?? [])
                    .filter((p) => p.stpid === s.subscription.event.stpid);
                const stopPreds = allStopPreds.filter(hasUsableCountdown);
                const prevArrivalTime = s.subscription.vidPredPrev;

                let tracked = stopPreds.find((p) => Math.abs(p.prdtm - expected) <= PASS_MATCH_SLACK_MS) ?? null;
                let inferredArrival = false;
                let delayedHold = false;
                if (tracked === null) {
                    const laterPred = stopPreds.find((p) => p.prdtm > expected + PASS_MATCH_SLACK_MS) ?? null;
                    if (allStopPreds.some((p) => !hasUsableCountdown(p))) {
                        // The vehicle reports "DLY" for this stop: its position
                        // in the loop is unknowable this tick, so hold the
                        // subscription rather than guess arrival/disappearance.
                        delayedHold = true;
                    } else if (laterPred !== null) {
                        if (prevArrivalTime !== null && prevArrivalTime <= arrivalInferenceMax) {
                            // The tracked pass vanished close to arrival while a
                            // LATER pass of the looping vehicle is still listed:
                            // the bus completed this pass, i.e. it arrived.
                            inferredArrival = true;
                        } else {
                            // The prediction jumped past the window in a single
                            // tick while the bus was still far out: treat it as
                            // the tracked pass being delayed and follow it.
                            tracked = laterPred;
                        }
                    }
                }
                if (tracked) {
                    // Follow gradual drift/delay so the window moves with the bus.
                    s.subscription.expectedPrdtm = tracked.prdtm;
                }

                const prdctdn = tracked?.prdctdn ?? null;
                const currArrivalTime = prdctdn == null ? null : prdctdnToNum(prdctdn);

                console.log(`stage 1: time is now ${delayedHold ? 'unknown (DLY)' : currArrivalTime}`);

                if (currArrivalTime !== prevArrivalTime && !delayedHold) {
                    timeChanged = true;
                }
                if (delayedHold) {
                    // no notification this tick; the subscription is retained
                    // with its state unchanged until the countdown recovers
                } else if (currArrivalTime === null) {
                    if (inferredArrival) {
                        console.log("tracked pass completed (later loop pass still listed): at the stop");
                        ats = s.subscription.event;
                    } else if (prevArrivalTime !== null && prevArrivalTime <= shouldBeArrivingThresh
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
                if (!delayedHold) {
                    s.subscription.vidPredPrev = currArrivalTime;
                }
            }

            if (disappeared || delayed || threshold || ats || delayed || timeChanged) {
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
                    { token: s.token, subscription: postThreshold(s.subscription, s.subscription.candidateVid), createdAt: s.createdAt }
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
        // A same-token swap must be a no-op (the dedup below would otherwise
        // see every event as "already held" and delete all subscriptions).
        if (from === to) return;
        // Drop source subscriptions whose event the new token already holds:
        // renaming them would leave two live subscriptions (possibly in
        // different stages) for one (event, token) pair.
        const existingEvents = this.subscriptions
            .filter((s) => s.token === to)
            .map((s) => s.subscription.event);
        this.subscriptions = this.subscriptions
            .filter((s) => !(s.token === from && existingEvents.some((e) => eventsEqual(e, s.subscription.event))))
            .map((s) => s.token === from ? { ...s, token: to } : s);
    }

    activeRemindersFor(id: RegistrationToken): Array<PreThreshold | PostThreshold> {
        return this.subscriptions
            .filter((s) => s.token === id)
            .map((s) => {
                return s.subscription;
            });
    }
}

export const universityReminderSubscriptions = new ReminderSubscriptions({ mock: false});
export const rideReminderSubscriptions = new ReminderSubscriptions({ mock: false});

export function processUniversityReminders() {
    try {
        processRemindersHelper(
            universityReminderSubscriptions,
            state.cachedPredsByStopId,
            state.cachedPredsByVid,
            state.stopIdToName
        );
    } catch (e) {
        // Not JSON.stringify: Errors serialize to '{}' (message/stack are
        // non-enumerable), which made recurring failures undiagnosable.
        console.error("Processing university reminders failed", e);
    }
}

export function processRideReminders() {
    try {
        processRemindersHelper(
            rideReminderSubscriptions,
            state.cachedRidePredsByStopId,
            state.cachedRidePredsByVid,
            state.rideStopIdToName,
        );
    } catch (e) {
        console.error("Processing ride reminders failed", e);
    }
}

function minutes(x: number): string {
    if (x === 1 || x === -1) {
        return `${x} minute`;
    }
    return `${x} minutes`;
}

function processRemindersHelper(
    reminderSubscriptions: ReminderSubscriptions,
    predsByStopId: Record<string, state.Prediction[] | undefined>,
    predsByVid: Record<string, state.Prediction[] | undefined>,
    stopIdToName: Record<string, string>,
) {
    const notifications = reminderSubscriptions.process(predsByStopId, predsByVid, Date.now());
    for (const [eventKey, tokens] of notifications.reminder) {
        const event = fromKey(eventKey);
        const stopName = stopIdToName[event.stpid] ?? event.stpid;;
        if (event.exactly) {
            sendNotifToAll(
                {
                    title: 'Bus Arrival Reminder',
                    body: `${event.rtid} is ${minutes(event.threshold)} away from ${stopName}`
                },
                tokens
            );
        } else {
            sendNotifToAll(
                {
                    title: 'Bus Arrival Reminder',
                    body: `${event.rtid} is less than ${minutes(event.threshold)} away from ${stopName}`
                },
                tokens
            );
        }
    }
    for (const [eventKey, tokens] of notifications.atTheStop) {
        const event = fromKey(eventKey);
        const stopName = stopIdToName[event.stpid] ?? event.stpid;;
        sendToAll(
            {
                notification: { title: 'Bus Arriving', body: `${event.rtid} is almost at ${stopName}` },
            },
            tokens
        );
    }
    for (const [eventKey, tokens] of notifications.delayed) {
        const event = fromKey(eventKey);
        const stopName = stopIdToName[event.stpid] ?? event.stpid;;
        sendNotifToAll(
            {
                title: `Bus Delayed`,
                body: `The ${event.rtid} bus en route to ${stopName} got delayed by `
                    + `${minutes(event.currPred - event.prevPred)}. New time is ${minutes(event.currPred)}.`
            },
            tokens
        );
    }
    for (const [eventKey, tokens] of notifications.disappeared) {
        const event = fromKey(eventKey);
        const stopName = stopIdToName[event.stpid] ?? event.stpid;;
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

/** Removes every subscription for a token FCM reports as dead, so the
 *  in-memory lists cannot grow forever with uninstalled clients. */
function pruneDeadToken(token: string) {
    for (const subs of [universityReminderSubscriptions, rideReminderSubscriptions]) {
        const before = subs.subscriptions.length;
        subs.subscriptions = subs.subscriptions.filter((s) => s.token !== token);
        if (subs.subscriptions.length !== before) {
            console.log(`Pruned ${before - subs.subscriptions.length} subscription(s) for a dead registration token`);
        }
    }
}

// REQUIRES: tokens.size <= 500
function sendToAllHelper(msg: any, tokens: Set<string>) {
    console.log(`helper sending to ${tokens.size}`);
    // Snapshot: the caller reuses and refills the Set for the next batch, so
    // the async callbacks below must not read it by reference.
    const sentTokens = Array.from(tokens);
    const payload = { tokens: sentTokens, ...msg };
    console.log(`payload: ${JSON.stringify(payload)}`);
    getMessaging().sendEachForMulticast(payload)
        .then((res) => {
            if (res.failureCount > 0) {
                console.log(`${res.failureCount} messages failed to send!`);
                res.responses.forEach((res, idx) => {
                    if (!res.success) {
                        console.log(`message send ${idx} failed`);
                        console.log(res.error);
                        console.log(`token was: ${JSON.stringify(sentTokens[idx])}`);
                        const code = (res.error as any)?.code;
                        if (code === 'messaging/registration-token-not-registered'
                            || code === 'messaging/invalid-registration-token') {
                            pruneDeadToken(sentTokens[idx]);
                        }
                    }
                })
            }
        })
        .catch((err) => {
            // An unhandled rejection here would crash the whole server.
            console.error('sendEachForMulticast failed', err);
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
