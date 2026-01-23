
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

type RegistrationToken = string & { readonly __brand: "registration_token" }
type EventKey = string & { readonly __brand: "event_key" }

function encodeEvent(e: Event): EventKey {
    return `${e.stpid}|${e.rtid}` as EventKey;
}

function decodeEvent(e: EventKey): Event {
    const split = e.split('|');
    return { stpid: split[0], rtid: split[1] } as Event;
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
            const key = encodeEvent(subscription.event);
            const arrivalTime = arrivalTimes.get(key);
            if (arrivalTime === undefined || arrivalTime.curr === null) {
                addHelper(notifications.disappeared, key, subscription.token);
            } else if (subscription.thresh === null && arrivalTime.curr === 0) {
                addHelper(notifications.atTheStop, key, subscription.token);
            } else if (arrivalTime.prev !== null && arrivalTime.curr > arrivalTime.prev) {
                addHelper(notifications.delayed, key, subscription.token);
                newSubscriptions.push(subscription);  // keep subscription if delayed
            } else if (subscription.thresh !== null && arrivalTime.prev !== null
                && arrivalTime.curr <= subscription.thresh && arrivalTime.curr < arrivalTime.prev) {
                addHelper(notifications.reminder, key, subscription.token);
                // replace with next in pipeline, a subscription to bus at stop
                newSubscriptions.push({ event: subscription.event, thresh: null, token: subscription.token });
            } else {
                newSubscriptions.push(subscription);  // keep subscription by default
            }
        }
        this.subscriptions = newSubscriptions;
        console.log(`Process completed with ${notifications.reminder.size}, ${notifications.atTheStop.size}, ${notifications.delayed.size}, ${notifications.disappeared.size}`);
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
                return {stpid: s.event.stpid, rtid: s.event.rtid, thresh: s.thresh };
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
            const prediction = vehicle.prdctdn === 'DUE' ? 0 : parseInt(vehicle.prdctdn);
            const key = encodeEvent({ stpid: stpid, rtid: rtid } as Event);
            let time = arrivalTimes.get(key);
            if (time === undefined) {
                arrivalTimes.set(key, { curr: null, prev: null });
                time = arrivalTimes.get(key)!;
            }
            if (time.curr === null || prediction < time.curr)
                time.curr = prediction;
        }
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
                    body: `The ${event.rtid} bus en route to ${stopName} got delayed by ${delay} minute(s).`
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
