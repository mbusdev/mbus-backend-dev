import dotenv from "dotenv";
import { cachedPredsByStopId } from "./busService";
import { getMessaging } from "firebase-admin/messaging";
import { applicationDefault, initializeApp } from "firebase-admin/app";

dotenv.config()

// const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;

// Initialize Firebase
initializeApp({ credential: applicationDefault() });

type Event = {
  stpid: string,
  rtid: string,
}

// the keys are the stop id and route id encoded
const reminderSubscriptions: Map<string, Set<string>> = new Map();
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
    { vid: string, pred: number, prevPred: number | undefined, prevTs: Date | undefined, rtid: string, stpid: string }
  > = [];
  const stpids = Object.keys(cachedPredsByStopId);
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
        soonestBusByStopAndRoute.set(stopAndRouteEncoded, soonestBusByRoute.get(rtid)!);
        updates.push({
          rtid: rtid,
          stpid: stpid,
          vid: soonestBus.vid,
          pred: soonestBus.prediction,
          prevPred: prevSoonestBus?.prediction,
          prevTs: prevSoonestBus?.ts
        });
      }
    }
  }

  // send push notifications / messages as needed based on updates and registrations
  for (const update of updates) {
    if (update.prevPred !== undefined && update.pred > update.prevPred && update.prevPred === 0) {
      // the bus went past the stop, remove reminder registrations
      reminderSubscriptions.get(encodeStopAndRoute(update.stpid, update.rtid))?.clear();
    } else {
      const subscribedDevices = reminderSubscriptions.get(encodeStopAndRoute(update.stpid, update.rtid)) ?? new Set();
      if (subscribedDevices.size === 0)
        continue;

      if (update.pred <= 5 && (update.prevPred == undefined || update.prevPred > 5)) {
        // send five minute warning notification
        sendToAll({ notification: { title: 'five_minute_warning', body: 'five_minute_warning' } }, subscribedDevices);
      }
      if (update.pred == 0) {
        // send bus is here notification
        sendToAll({ notification: { title: 'bus_is_here', body: 'bus_is_here' } }, subscribedDevices);
      }
      // send message with updated info
      sendToAll({ data: { stpid: update.stpid, rtid: update.rtid } }, subscribedDevices);
    }
  }
}

function sendToAll(msg: any, tokens: Set<string>) {
  console.log(`sending ${msg}`);
  if (tokens.size <= 500) {
    const payload = { tokens: Array.from(tokens), ...msg };
    console.log(payload);
    console.log(JSON.stringify(payload));
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
