import dotenv from "dotenv";
import { cachedPredsByStopId, stopIdToName } from "./busService";
import { getMessaging } from "firebase-admin/messaging";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import * as metadata from "./assets/route-data.json";

dotenv.config()

// const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;

// Initialize Firebase
initializeApp({ credential: applicationDefault() });

type Event = {
    stpid: string,
    rtid: string,
}

class ReminderSubscriptions {
    // key = the stop id and route id encoded
    // value = map from minutes in advance to sets of subscription tokens
    inner: Map<string, Map<number, Set<string>>>

    constructor() {
        this.inner = new Map();
    }

    add(stpid: string, rtid: string, thresh: number, token: string) {
        var withStopAndRoute = this.inner.get(encodeStopAndRoute(stpid, rtid));
        if (withStopAndRoute == undefined) {
            this.inner.set(encodeStopAndRoute(stpid, rtid), new Map());
            withStopAndRoute = this.inner.get(encodeStopAndRoute(stpid, rtid))!;
        }
        var withThresh = withStopAndRoute.get(thresh);
        if (withThresh == undefined) {
            withStopAndRoute.set(thresh, new Set());
            withThresh = withStopAndRoute.get(thresh)!;
        }
        withThresh.add(token);
    }

    remove(stpid: string, rtid: string, token: string) {
        const withStopAndRoute = this.inner.get(encodeStopAndRoute(stpid, rtid));
        if (withStopAndRoute) {
            const toDelete = [];
            for (const [thresh, deviceTokens] of withStopAndRoute) {
                deviceTokens.delete(token);
                if (deviceTokens.size === 0) {
                    toDelete.push(thresh);
                }
            }
            for (const thresh of toDelete) {
                withStopAndRoute.delete(thresh);
            }
        }
    }

    removeAllFor(stpid: string, rtid: string) {
        this.inner.delete(encodeStopAndRoute(stpid, rtid));
    }

    get(stpid: string, rtid: string): Map<number, Set<string>> {
        return this.inner.get(encodeStopAndRoute(stpid, rtid)) ?? new Map();
    }

    has(stpid: string, rtid: string, token: string): boolean {
        const withStopAndRoute = this.inner.get(encodeStopAndRoute(stpid, rtid));
        if (withStopAndRoute === undefined) {
            return false;
        }
        for (const tokens of withStopAndRoute.values()) {
            if (tokens.has(token)) {
                return true;
            }
        }
        return false;
    }

    describe() {
        console.log("Description for ReminderSubscriptions");
        const numRegistrationsFor = (x: string) => {
            let registrations = 0;
            for (const tokens of this.inner.get(x)!.values()) {
                registrations += tokens.size;
            }
            return registrations;
        }
        var events = [...this.inner.keys()];
        events.sort((a, b) => {
            return numRegistrationsFor(b) - numRegistrationsFor(a);
        });
        for (const event of events) {
            const registrations = numRegistrationsFor(event);
            if (registrations === 0) {
                continue;
            }
            console.log(`${event}: ${registrations} registration(s)`);
            for (const [thresh, tokens] of this.inner.get(event)!) {
                console.log(`    ${thresh}: ${tokens.size} token(s)`);
            }
        }
    }
}

const reminderSubscriptions = new ReminderSubscriptions();
let soonestBusByStopAndRoute: Map<string, { vid: string, prediction: number, ts: Date }> = new Map();

function encodeStopAndRoute(stpid: string, rtid: string): string {
    return `${stpid}|${rtid}`;
}

function decodeStopAndRoute(encoded: string): { stpid: string, rtid: string } {
    const split = encoded.split('|');
    return { stpid: split[0], rtid: split[1] };
}

function processReminders() {
    const updates: Array<
        {
            vid: string,
            prevVid: string | null,
            pred: number,
            prevPred: number | null,
            prevTs: Date | null,
            rtid: string,
            stpid: string
        }
    > = [];
    const stpids = Object.keys(cachedPredsByStopId);
    // determine arrival time updates for each stop
    for (const stpid of stpids) {
        const soonestBusByRoute: Map<string, { vid: string, prediction: number, ts: Date }> = new Map();
        for (const vehicle of cachedPredsByStopId[stpid]) {
            const rtid = vehicle.rt;
            const vid = vehicle.vid;
            const prediction = vehicle.prdctdn === 'DUE' ? 0 : parseInt(vehicle.prdctdn);
            if (soonestBusByRoute.has(rtid)) {
                const soonest = Math.min(prediction, soonestBusByRoute.get(rtid)!.prediction);
                soonestBusByRoute.set(rtid, { vid: vid, prediction: soonest, ts: new Date() });
            } else {
                soonestBusByRoute.set(rtid, { vid: vid, prediction: prediction, ts: new Date() });
            }
        }
        for (const rtid of soonestBusByRoute.keys()) {
            const stopAndRouteEncoded = encodeStopAndRoute(stpid, rtid);
            const prevSoonestBus = soonestBusByStopAndRoute.get(stopAndRouteEncoded);
            const soonestBus = soonestBusByRoute.get(rtid)!;
            if (!prevSoonestBus || prevSoonestBus!.prediction !== soonestBus.prediction
            ) {
                // the predicted time till arrival has changed
                soonestBusByStopAndRoute.set(stopAndRouteEncoded, soonestBusByRoute.get(rtid)!);
                updates.push({
                    rtid: rtid,
                    stpid: stpid,
                    vid: soonestBus.vid,
                    pred: soonestBus.prediction,
                    prevPred: prevSoonestBus?.prediction ?? null,
                    prevTs: prevSoonestBus?.ts ?? null,
                    prevVid: prevSoonestBus?.vid ?? null,
                });
            }
        }
    }
    console.log(`There are ${updates.length} updates`);

    // send push notifications / messages as needed based on updates and registrations
    for (const update of updates) {
        const predIncreased = update.prevPred !== null && update.pred > update.prevPred;
        const vidChanged = update.prevVid !== null && update.prevVid !== update.vid;

        const NOT_CLOSE = 5; // when should the bus be interpreted as disappearing vs going past the stop
        const busWentPastTheStop = false
            || (predIncreased && update.prevPred === 0 && update.pred >= NOT_CLOSE)
            || (vidChanged && (update.prevPred ?? NOT_CLOSE) < NOT_CLOSE);
        const busDisappeared = vidChanged && (update.prevPred ?? 0) >= NOT_CLOSE;
        const busDelayed = predIncreased && !busWentPastTheStop && !busDisappeared;

        const subscribedDevices = reminderSubscriptions.get(update.stpid, update.rtid);
        if (subscribedDevices == undefined || subscribedDevices.size === 0)
            continue;
        const allDeviceIds = new Set<string>();
        for (const deviceIds of subscribedDevices.values()) {
            for (const deviceId of deviceIds) {
                allDeviceIds.add(deviceId);
            }
        }

        const stopName = stopIdToName[update.stpid] ?? update.stpid;
        if (busWentPastTheStop) {
            // remove reminder registrations
            reminderSubscriptions.removeAllFor(update.stpid, update.rtid);
        } else if (busDisappeared) {
            sendToAll(
                {
                    title: `Bus Disappeared`,
                    body: `The ${update.rtid} bus en route to ${stopName} disappeared! Set a new reminder if desired.`
                },
                allDeviceIds
            );
            // remove reminder registrations
            reminderSubscriptions.removeAllFor(update.stpid, update.rtid);
        } else {
            // send ahead of time reminder notifications
            for (const [threshold, deviceIds] of subscribedDevices) {
                if (update.pred <= threshold && (update.prevPred === null || update.prevPred > threshold)) {
                    sendToAll(
                        {
                            notification: {
                                title: 'Bus Arrival Reminder',
                                body: `${update.rtid} is ${update.pred} minute(s) away from ${stopName}`
                            }
                        },
                        deviceIds
                    );
                }
            }
            if (busDelayed) {
                const delay = update.pred - (update.prevPred ?? update.pred);
                sendToAll(
                    {
                        title: `Bus Delayed`,
                        body: `The ${update.rtid} bus en route to ${stopName} got delayed by ${delay} minute(s).`
                    },
                    allDeviceIds,
                );
            }
            // send bus is here notification
            if (update.pred == 0) {
                sendToAll(
                    { notification: { title: 'Bus Arriving', body: `${update.rtid} is almost at ${stopName}` } },
                    allDeviceIds
                );
            }
            // send message with updated info
            sendToAll({ data: { stpid: update.stpid, rtid: update.rtid } }, allDeviceIds);
        }
    }
}

function sendToAll(msg: any, tokens: Set<string>) {
    console.log(`sending a message to ${tokens.size} devices`);
    if (tokens.size <= 500) {
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
    } else {
        const group = new Set<string>();
        for (const token of tokens) {
            if (group.size === 500) {
                sendToAll(msg, group);
                group.clear();
            }
            group.add(token);
        }
        sendToAll(msg, group);
    }
}

export { processReminders, reminderSubscriptions, encodeStopAndRoute, Event };
