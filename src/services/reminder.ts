
import dotenv from "dotenv";
import * as state from "../state/transitState";
// import { cachedPredsByStopId, stopIdToName } from "./busService";
import { getMessaging } from "firebase-admin/messaging";
import { applicationDefault, initializeApp } from "firebase-admin/app";

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

// Subscriptions go through a pipeline, starting in the waiting for reminder
// stage. After the bus in x minutes notification is set they move to the
// waiting for bus stage, where they stay until the bus is arriving notification
// is sent. Being in the second stage is repsented by having a threshold of null.
class ReminderSubscriptions {
    // a thresh of null means being in the second stage
    subscriptions: Array<{ event: Event, thresh: number | null, token: RegistrationToken }>

    constructor() {
        this.subscriptions = [];
    }

    // addition is done to the start of the pipeline
    add(event: Event, thresh: number, token: RegistrationToken) {
        console.log("Adding a reminder subscription");
        this.subscriptions.push({ event, thresh, token });
    }

    // removes all subscriptions involving both `event` and `token`
    remove(event: Event, token: RegistrationToken) {
        console.log("Removing a reminder subscription");
        this.subscriptions = this.subscriptions
            .filter((s) => s.event.rtid !== event.rtid || s.event.stpid !== event.stpid || s.token !== token);
    }

    // updates the status of all registrations, returning an object representing the
    // notifications that should be sent
    process(arrivalTimes: Map<EventKey, { curr: number | null, prev: number | null }>): {
        reminder: Map<EventKey, Set<RegistrationToken>>,
        atTheStop: Map<EventKey, Set<RegistrationToken>>,
        disappeared: Map<EventKey, Set<RegistrationToken>>,
        delayed: Map<EventKey, Set<RegistrationToken>>
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
            reminder: new Map(), atTheStop: new Map(), disappeared: new Map(), delayed: new Map()
        };

        const newSubscriptions: typeof this.subscriptions = [];
        for (const subscription of this.subscriptions) {
            const key = EventKey(subscription.event);
            const arrivalTime = arrivalTimes.get(key);

            const logInfo = () => {
                console.log(`process() is operating on ${key}...`);
                console.log(`the arrival time is ${JSON.stringify(arrivalTime)}`);
                console.log(`subscription is for ${JSON.stringify(subscription.event)} @ ${subscription.thresh}`);
            };

            // There might be times where the prediction of the bus skips past DUE/1, which results in a disappeared or
            // delayed notification when there really shouldn't be. 
            // `shouldBeArrivingThresh` overrides a bus disappeared notification with an at the stop one if the arrival
            // time is at or below it. It also overrides a delayed notification if the delay amount is more than
            // `maxDelayWhenShouldBeArriving`
            const shouldBeArrivingThresh = 3;
            const maxDelayWhenShouldBeArriving = 1;

            if (arrivalTime === undefined || arrivalTime.curr === null) {
                // disappeared
                if (arrivalTime !== undefined
                    && arrivalTime.prev !== null
                    && arrivalTime.prev <= shouldBeArrivingThresh
                ) {
                    // override
                    console.log("disappeared notification was overriden!");
                    addHelper(notifications.atTheStop, key, subscription.token);
                    logInfo();
                } else {
                    console.log("disappeared notification!");
                    addHelper(notifications.disappeared, key, subscription.token);
                    logInfo();
                }
            } else if (arrivalTime.curr === 1) {
                // at the stop
                addHelper(notifications.atTheStop, key, subscription.token);
                logInfo();
            } else if (arrivalTime.prev !== null && arrivalTime.curr > arrivalTime.prev) {
                // delayed
                if (arrivalTime.prev <= shouldBeArrivingThresh
                    && arrivalTime.curr - arrivalTime.prev > maxDelayWhenShouldBeArriving
                ) {
                    // override
                    console.log("delayed notification was overriden!");
                    addHelper(notifications.atTheStop, key, subscription.token);
                    logInfo();
                } else {
                    console.log("delayed notification!");
                    addHelper(notifications.delayed, key, subscription.token);
                    newSubscriptions.push(subscription);  // keep subscription if delayed but not if overriden
                    logInfo();
                }
            } else if (subscription.thresh !== null
                && arrivalTime.curr <= subscription.thresh
            ) {
                console.log("reminder notification");
                // reminder
                addHelper(notifications.reminder, key, subscription.token);
                // replace with next in pipeline, a subscription to bus at stop
                newSubscriptions.push({ event: subscription.event, thresh: null, token: subscription.token });
                logInfo();
            } else {
                newSubscriptions.push(subscription);  // keep subscription by default
            }
        }
        this.subscriptions = newSubscriptions;
        if (notifications.reminder.size !== 0 || notifications.atTheStop.size !== 0 || notifications.delayed.size !== 0 || notifications.disappeared.size !== 0) {
            console.log(
                `Process completed with ${notifications.reminder.size} threshold reminders, `
                + `${notifications.atTheStop.size} at the stop reminders, `
                + `${notifications.delayed.size} delayed notifications, `
                + `${notifications.disappeared.size} disappeared notifications`
            );
        }
        return notifications;
    }

    // removes all subscriptions involving `event`
    removeAllFor(event: Event) {
        this.subscriptions = this.subscriptions
            .filter((s) => s.event.rtid !== event.rtid || s.event.stpid !== event.stpid);
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

    activeRemindersFor(id: RegistrationToken): Array<{ stpid: string, rtid: string, thresh: number | null }> {
        return this.subscriptions
            .filter((s) => s.token === id)
            .map((s) => {
                return { stpid: s.event.stpid, rtid: s.event.rtid, thresh: s.thresh };
            });
    }

    describe() {
        console.log(`There are ${this.subscriptions.length} reminder subscriptions`);
    }
}

const reminderSubscriptions = new ReminderSubscriptions();
const arrivalTimes: Map<EventKey, { curr: number | null, prev: number | null }> = new Map();

function processReminders() {
    // move current arrival times to prev
    for (const [_k, v] of arrivalTimes) {
        v.prev = v.curr;
        v.curr = null;
    }

    const stpids = Object.keys(state.cachedPredsByStopId);
    // determine arrival time updates for each stop
    for (const stpid of stpids) {
        for (const vehicle of state.cachedPredsByStopId[stpid]) {
            const rtid = vehicle.rt;
            if (typeof rtid !== "string") {
                console.log("prediction found that is missing rtid!");
                continue;
            }
            const prediction = vehicle.prdctdn === 'DUE' ? 1 : parseInt(vehicle.prdctdn);
            const key = EventKey(Event({ stpid: stpid, rtid: rtid }));
            let time = arrivalTimes.get(key);
            if (time === undefined) {
                arrivalTimes.set(key, { curr: null, prev: null });
                time = arrivalTimes.get(key)!;
            }
            if (time.curr === null || prediction < time.curr)
                time.curr = prediction;
        }
    }

    const keys = new Set<EventKey>();
    for (const event of reminderSubscriptions.subscriptions) {
        const key = EventKey(event.event);
        keys.add(key);
    }
    let didLogHeader = false;
    for (const key of keys) {
        const arrivalTime = arrivalTimes.get(key);
        if (arrivalTime?.curr == arrivalTime?.prev) {
            continue;
        }
        if (!didLogHeader) {
            console.log("Arrival Times Information");
            didLogHeader = true;
        }
        console.log(` - ${key}: c = ${arrivalTime?.curr} p = ${arrivalTime?.prev}`);
    }

    // send push notifications as needed
    const notifications = reminderSubscriptions.process(arrivalTimes);
    for (const [eventKey, tokens] of notifications.reminder) {
        const event = decodeEvent(eventKey);
        const stopName = state.stopIdToName[event.stpid] ?? event.stpid;
        sendToAll(
            {
                notification: {
                    title: 'Bus Arrival Reminder',
                    body: `${event.rtid} is ${arrivalTimes.get(eventKey)?.curr} minute(s) away from ${stopName}`
                }
            },
            tokens
        );
    }
    for (const [eventKey, tokens] of notifications.atTheStop) {
        const event = decodeEvent(eventKey);
        const stopName = state.stopIdToName[event.stpid] ?? event.stpid;
        sendToAll(
            {
                notification: { title: 'Bus Arriving', body: `${event.rtid} is almost at ${stopName}` },
            },
            tokens
        );
    }
    for (const [eventKey, tokens] of notifications.delayed) {
        const event = decodeEvent(eventKey);
        const stopName = state.stopIdToName[event.stpid] ?? event.stpid;
        const arrivalTime = arrivalTimes.get(eventKey);
        const delay = arrivalTime?.curr !== null && arrivalTime?.prev ? `${arrivalTime.curr - arrivalTime.prev}` : `some`;
        sendToAll(
            {
                notification: {
                    title: `Bus Delayed`,
                    body: `The ${event.rtid} bus en route to ${stopName} got delayed by ${delay} minute(s). `
                        + `New time is ${arrivalTime?.curr ?? 'unknown'} minute(s).`
                }
            },
            tokens
        );
    }
    for (const [eventKey, tokens] of notifications.disappeared) {
        const event = decodeEvent(eventKey);
        const stopName = state.stopIdToName[event.stpid] ?? event.stpid;
        sendToAll(
            {
                notification: {
                    title: `Bus Disappeared`,
                    body: `The ${event.rtid} bus en route to ${stopName} disappeared! Set a new reminder if desired.`
                }
            },
            tokens
        );
    }

}

function sendToAll(msg: any, tokens: Set<string>) {
    console.log(`sending a message to ${tokens.size} devices`);
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
    const payload = { tokens: Array.from(tokens), ...msg };
    getMessaging().sendEachForMulticast(payload)
        .then((res) => {
            if (res.failureCount > 0) {
                console.log(`${res.failureCount} messages failed to send!`);
                res.responses.forEach((res, idx) => {
                    if (!res.success) {
                        console.log(`message send ${idx} failed`);
                        console.log(res.error);
                    }
                })
            }
        });
}

export { processReminders, reminderSubscriptions, Event, RegistrationToken };
