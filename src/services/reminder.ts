import dotenv from "dotenv";
import { getMessaging } from "firebase-admin/messaging";
import { applicationDefault, initializeApp } from "firebase-admin/app";

import * as state from "@/state/transitState";

dotenv.config()

// Initialize Firebase
initializeApp({ credential: applicationDefault() });

type Event = {
    stpid: string,
    rtid: string,
    readonly __brand: "event"
}

function Event(x: { stpid: string, rtid: string }): Event {
    return x as Event;
}

function eventsEqual(e1: Event, e2: Event): boolean {
    return e1.stpid === e2.stpid && e1.rtid === e2.rtid;
}

type RegistrationToken = string & { readonly __brand: "registration_token" }

function RegistrationToken(x: string): RegistrationToken {
    return x as RegistrationToken;
}

type EventKey = string & { readonly __brand: "event_key" }

function EventKey(e: Event): EventKey {
    return `${e.stpid}|${e.rtid}` as EventKey;
}

function decodeEvent(e: EventKey): Event {
    const split = e.split('|');
    return Event({ stpid: split[0], rtid: split[1] });
}

/** Waiting for a prediction of the right `event` to have a arrival timestamp that is at or after `mustBeAfter` and an
 *  arrival time less than `thresh`. A bus is xx minutes from the stop notification is then sent. To handle delayed and
 *  disappeared notifications, a `candidateVid` is set to the soonest arriving bus that arrives after `mustbeAfter`.
 */
type PreThreshold = {
    stage: 0,
    event: Event,
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

/** constructor */
function PreThreshold(event: Event, thresh: number, candidateVid: string | null, now: number): PreThreshold {
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
type PostThreshold = { stage: 1, event: Event, vid: string, vidPredPrev: number | null };

/** constructor */
function PostThreshold(prev: PreThreshold, vid: string): PostThreshold {
    return {
        stage: 1, event: prev.event, vid, vidPredPrev: prev.candidateVid === vid ? prev.candidateVidPredPrev : null
    };
}

function prdctdnToNum(prdctdn: string): number {
    return prdctdn === 'DUE' ? 1 : parseInt(prdctdn);
}

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
    add(event: Event, thresh: number, token: RegistrationToken, predsByStopId: Record<string, state.Prediction[]>, now: number) {
        console.log("Adding a reminder subscription");
        const predictions = predsByStopId[event.stpid];
        const subscription = PreThreshold(event, thresh, null, now);
        if (predictions) {
            const relevant = predictions
                .filter((p) => p.rt === event.rtid);
            subscription.candidateVid = firstPredAfter(subscription.mustBeAfter, relevant)?.vid ?? null;
        }
        this.subscriptions.push({ token, subscription });
        sendReminderUpdateToAll(new Set([token]));
    }

    /** removes all subscriptions that involve both `event` and `token` */
    remove(event: Event, token: RegistrationToken) {
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
        now: number
    ): {
        reminder: Map<EventKey, Set<RegistrationToken>>,
        atTheStop: Map<EventKey, Set<RegistrationToken>>,
        disappeared: Map<EventKey, Set<RegistrationToken>>,
        delayed: Map<EventKey, Set<RegistrationToken>>,
        updated: Set<RegistrationToken>
    } {
        const addHelper = (map: Map<EventKey, Set<RegistrationToken>>, key: EventKey, token: RegistrationToken) => {
            let tokens = map.get(key);
            if (tokens === undefined) {
                map.set(key, new Set());
                tokens = map.get(key)!;
            }
            tokens.add(token);
        };
        const notifications = {
            reminder: new Map(),
            atTheStop: new Map(),
            disappeared: new Map(),
            delayed: new Map(),
            updated: new Set<RegistrationToken>()
        };

        // TODO: send time update messages

        const newSubscriptions: typeof this.subscriptions = [];
        for (const s of this.subscriptions) {
            const key = EventKey(s.subscription.event);

            // only one is sent, variable order is priority
            let disappeared = false;
            let delayed = false;
            let threshold = false;
            let ats = false;

            if (s.subscription.stage === 0) {
                // did the candidate vehicle change?
                // PERF: caching these filter results might be good
                const newCandidate = firstPredAfter(
                    s.subscription.mustBeAfter,
                    (predsByStopId[s.subscription.event.stpid] ?? []).filter((p) => p.rt === s.subscription.event.rtid)
                );
                if (newCandidate === null) {
                    // no candidate
                    disappeared = true;
                } else {
                    const pred = prdctdnToNum(newCandidate.prdctdn);
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
                        delayed = true;
                    }
                    s.subscription.candidateVidPredPrev = pred;
                    if (newCandidate.prdtm > s.subscription.mustBeAfter && pred <= s.subscription.thresh) {
                        threshold = true;
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

                if (currArrivalTime === null) {
                    // disappeared
                    if (prevArrivalTime !== null && prevArrivalTime <= shouldBeArrivingThresh
                    ) {
                        // override
                        console.log("disappeared notification was overriden!");
                        ats = true;
                    } else {
                        console.log("disappeared notification!");
                        disappeared = true;
                    }
                } else if (currArrivalTime === 1) {
                    // at the stop
                    ats = true;
                } else if (prevArrivalTime !== null && currArrivalTime > prevArrivalTime) {
                    // delayed
                    if (prevArrivalTime <= shouldBeArrivingThresh
                        && currArrivalTime - prevArrivalTime > maxDelayWhenShouldBeArriving
                    ) {
                        // override
                        console.log("delayed notification was overriden!");
                        ats = true;
                    } else {
                        console.log("delayed notification!");
                        delayed = true;
                    }
                }
                s.subscription.vidPredPrev = currArrivalTime;
            }

            if (disappeared) {
                addHelper(notifications.disappeared, key, s.token);
            } else if (delayed) {
                addHelper(notifications.delayed, key, s.token);
                newSubscriptions.push(s);
            } else if (threshold) {
                addHelper(notifications.reminder, key, s.token);
                if (s.subscription.stage !== 0) {
                    throw Error("A PostTheshold subscription tried to trigger a threshold notification");
                }
                if (s.subscription.candidateVid === null) {
                    throw Error("A threshold notification was triggered without a corresponding vid");
                }
                newSubscriptions.push(
                    { token: s.token, subscription: PostThreshold(s.subscription, s.subscription.candidateVid) }
                );
            } else if (ats) {
                addHelper(notifications.atTheStop, key, s.token);
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

    /** removes all subscriptions involving `event` */
    removeAllFor(event: Event) {
        this.subscriptions = this.subscriptions
            .filter((s) => {
                return eventsEqual(event, s.subscription.event);
            });
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

    describe() {
        console.log(`There are ${this.subscriptions.length} reminder subscriptions`);
    }
}

const universityReminderSubscriptions = new ReminderSubscriptions();

function processUniversityReminders() {
    try {
        processRemindersHelper(state.cachedPredsByStopId, state.cachedPredsByVid);
    } catch (e) {
        console.log("Processing university reminders failed");
        console.log(`${JSON.stringify(e)}`);
    }
}

function processRemindersHelper(
    predsByStopId: Record<string, state.Prediction[] | undefined>,
    predsByVid: Record<string, state.Prediction[] | undefined>
) {
    const notifications = universityReminderSubscriptions.process(predsByStopId, predsByVid, Date.now());
    for (const [eventKey, tokens] of notifications.reminder) {
        const event = decodeEvent(eventKey);
        const stopName = state.stopIdToName[event.stpid] ?? event.stpid;;
        sendNotifToAll(
            {
                title: 'Bus Arrival Reminder',
                body: `${event.rtid} is ${"TODO"} minute(s) away from ${stopName}`
            },
            tokens
        );
    }
    for (const [eventKey, tokens] of notifications.atTheStop) {
        const event = decodeEvent(eventKey);
        const stopName = state.stopIdToName[event.stpid] ?? event.stpid;;
        sendToAll(
            {
                notification: { title: 'Bus Arriving', body: `${event.rtid} is almost at ${stopName}` },
            },
            tokens
        );
    }
    for (const [eventKey, tokens] of notifications.delayed) {
        const event = decodeEvent(eventKey);
        const stopName = state.stopIdToName[event.stpid] ?? event.stpid;;
        // const arrivalTime = arrivalTimes.get(eventKey);
        // const delay = arrivalTime?.curr !== null && arrivalTime?.prev ? `${arrivalTime.curr - arrivalTime.prev}` : `some`;
        sendNotifToAll(
            {
                title: `Bus Delayed`,
                body: `The ${event.rtid} bus en route to ${stopName} got delayed by ${"TODO"} minute(s). `
                    + `New time is ${"TODO"} minute(s).`
            },
            tokens
        );
    }
    for (const [eventKey, tokens] of notifications.disappeared) {
        const event = decodeEvent(eventKey);
        const stopName = state.stopIdToName[event.stpid] ?? event.stpid;;
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

function sendNotifToAll(notif: { title: string, body: string }, tokens: Set<string>) {
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

/** exported for tests */
export const testing = {
    ReminderSubscriptions,
    eventsEqual
};

export {
    processUniversityReminders,
    universityReminderSubscriptions,
    sendNotifToAll,
    Event, EventKey, RegistrationToken,
};
