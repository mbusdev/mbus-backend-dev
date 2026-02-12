import { describe, it, expect } from 'vitest';

import * as r from "./reminder";
import { testing as t } from "./reminder";
import { Prediction } from '../state/transitState';
import { sortPreds } from './graphBuilder';

const testToken = r.RegistrationToken("token1");
const testEvent = r.Event({ stpid: "stop1", rtid: "route1" });
const testEventDiffRt = r.Event({ stpid: "stop1", rtid: "route2" });

function createCaches(preds: Prediction[]): { byStop: Record<string, Prediction[]>, byVid: Record<string, Prediction[]> } {
    const byStop: Record<string, Prediction[]> = {};
    const byVid: Record<string, Prediction[]> = {};
    for (const pred of preds) {
        if (byStop[pred.stpid] === undefined) {
            byStop[pred.stpid] = [];
        }
        if (byVid[pred.vid] === undefined) {
            byVid[pred.vid] = [];
        }
        byStop[pred.stpid].push(pred);
        byVid[pred.vid].push(pred);
    }
    sortPreds(byStop);
    sortPreds(byVid);
    return { byStop, byVid };
}

describe('Reminders', () => {
    it('should not send a threshold immediately and should move to next stage after sending', () => {
        const subs = new t.ReminderSubscriptions();
        const { byStop, byVid } = createCaches([
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: Date.now() + 2 * 60 * 1000, prdctdn: "2" }
        ]);
        subs.add(testEvent, 3, testToken, byStop, Date.now());
        // reminder should not trigger since the bus arrives too soon, simulate processing happening rougly a minute
        // later
        const reminders = subs.process(byStop, byVid, Date.now() + 60 * 1000);
        console.log(byStop);
        console.log(byVid);
        console.log(reminders);
        expect(reminders.reminder.size).toBe(0);
        expect(reminders.atTheStop.size).toBe(0);
        expect(reminders.delayed.size).toBe(0);
        expect(reminders.disappeared.size).toBe(0);

        // a later arriving bus where it should trigger
        const { byStop: byStopLater, byVid: byVidLater } = createCaches([
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: Date.now() + 4 * 60 * 1000, prdctdn: "2" }
        ]);
        const remindersLater = subs.process(byStopLater, byVidLater, Date.now() + 60 * 1000);
        console.log(remindersLater);
        expect(remindersLater.reminder.size).toBe(1);
        expect(remindersLater.reminder.get(r.EventKey(testEvent))?.has(testToken));

        expect(subs.activeRemindersFor(testToken).length).toBe(1);
        expect(t.eventsEqual(subs.activeRemindersFor(testToken)[0].event, testEvent)).toBe(true);
        expect(subs.activeRemindersFor(testToken)[0].stage).toBe(1);
    });

    it('should not send a disappeared notification if there never was a bus in the first place', () => {
        const subs = new t.ReminderSubscriptions();
        // the subscription gets added with no possible candidate vid
        subs.add(testEvent, 3, testToken, {}, Date.now());
        // will it trigger a disappeared reminder?
        const reminders = subs.process({}, {}, Date.now());
        expect(reminders.disappeared.size).toBe(0);
    });

    it('should not trigger for busses of other routes', () => {
        const subs = new t.ReminderSubscriptions();
        const { byStop, byVid } = createCaches([
            { rt: testEventDiffRt.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: Date.now() + 4 * 60 * 1000, prdctdn: "2" }
        ]);
        subs.add(testEvent, 3, testToken, byStop, Date.now());
        const reminders = subs.process(byStop, byVid, Date.now());
        expect(reminders.reminder.size).toBe(0);
    });

    it('should only get removed by the remove method if explicitly targeted', () => {
        const subs = new t.ReminderSubscriptions();
        subs.add(testEvent, 3, testToken, {}, Date.now());
        subs.add(testEventDiffRt, 3, testToken, {}, Date.now());
        subs.add(testEvent, 3, r.RegistrationToken("anotherToken"), {}, Date.now());
        expect(subs.subscriptions.length).toBe(3);
        subs.remove(testEvent, testToken);
        expect(subs.subscriptions.length).toBe(2);
    });

    it('should send at the stop notifications', () => {
        const subs = new t.ReminderSubscriptions();
        const { byStop, byVid } = createCaches([
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: Date.now() + 4 * 60 * 1000, prdctdn: "2" }
        ]);
        subs.add(testEvent, 3, testToken, byStop, Date.now());
        subs.process(byStop, byVid, Date.now());
        byStop["stop1"][0].prdctdn = "DUE"
        expect(byStop["stop1"][0].prdctdn).toEqual(byVid["vid1"][0].prdctdn);
        const reminders = subs.process(byStop, byVid, Date.now());
        expect(reminders.atTheStop.size).toBe(1);
    });

    it('should send delayed notifications', () => {
        const subs = new t.ReminderSubscriptions();
        const { byStop, byVid } = createCaches([
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: Date.now() + 4 * 60 * 1000, prdctdn: "4" } 
        ]);
        subs.add(testEvent, 3, testToken, byStop, Date.now());
        subs.process(byStop, byVid, Date.now());
        byVid["vid1"][0].prdctdn = "5";
        let reminders = subs.process(byStop, byVid, Date.now());
        expect(reminders.delayed.size).toBe(1);

        // now test behavior in stage 1
        byVid["vid1"][0].prdctdn = "3";
        const remindersToStage1 = subs.process(byStop, byVid, Date.now() + 2 * 60 * 1000);
        expect(remindersToStage1.reminder.size).toBe(1);
        expect(subs.subscriptions[0].subscription.stage).toBe(1);
        byVid["vid1"][0].prdctdn = "4";
        reminders = subs.process(byStop, byVid, Date.now() + 2 * 60 * 1000);
        expect(reminders.delayed.size).toBe(1);
    });

    it('should send disappeared notifications (stage 0)', () => {
        const subs = new t.ReminderSubscriptions();
        const { byStop } = createCaches([
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: Date.now() + 4 * 60 * 1000, prdctdn: "4" }
        ]);
        subs.add(testEvent, 3, testToken, byStop, Date.now());
        const reminders = subs.process({}, {}, Date.now());
        expect(reminders.disappeared.size).toBe(1);
    });

    it('should send disappeared notifications (stage 1)', () => {
        const subs = new t.ReminderSubscriptions();
        const { byStop, byVid } = createCaches([
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: Date.now() + 5 * 60 * 1000, prdctdn: "5" } 
        ]);
        subs.add(testEvent, 4, testToken, byStop, Date.now());
        subs.process(byStop, byVid, Date.now());

        // to stage 1
        byVid["vid1"][0].prdctdn = "4";
        const remindersToStage1 = subs.process(byStop, byVid, Date.now() + 2 * 60 * 1000);
        expect(remindersToStage1.reminder.size).toBe(1);
        expect(subs.subscriptions[0].subscription.stage).toBe(1);

        const reminders = subs.process({}, {}, Date.now());
        expect(reminders.disappeared.size).toBe(1);
    });

    it('should override some delayed notifications', () => {
        const subs = new t.ReminderSubscriptions();
        const { byStop, byVid } = createCaches([
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: Date.now() + 4 * 60 * 1000, prdctdn: "4" } 
        ]);
        subs.add(testEvent, 3, testToken, byStop, Date.now());
        subs.process(byStop, byVid, Date.now());
        byVid["vid1"][0].prdctdn = "5";
        let reminders = subs.process(byStop, byVid, Date.now());
        expect(reminders.delayed.size).toBe(1);

        // now test behavior in stage 1
        byVid["vid1"][0].prdctdn = "3";
        const remindersToStage1 = subs.process(byStop, byVid, Date.now() + 2 * 60 * 1000);
        expect(remindersToStage1.reminder.size).toBe(1);
        expect(subs.subscriptions[0].subscription.stage).toBe(1);
        byVid["vid1"][0].prdctdn = "20";
        reminders = subs.process(byStop, byVid, Date.now() + 2 * 60 * 1000);
        expect(reminders.delayed.size).toBe(0);
        expect(reminders.atTheStop.size).toBe(1);
    });

    it('should override some disappeared notifications', () => {
        const subs = new t.ReminderSubscriptions();
        const { byStop, byVid } = createCaches([
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: Date.now() + 5 * 60 * 1000, prdctdn: "5" } 
        ]);
        subs.add(testEvent, 4, testToken, byStop, Date.now());
        subs.process(byStop, byVid, Date.now());

        // to stage 1
        byVid["vid1"][0].prdctdn = "3";
        const remindersToStage1 = subs.process(byStop, byVid, Date.now() + 2 * 60 * 1000);
        expect(remindersToStage1.reminder.size).toBe(1);
        expect(subs.subscriptions[0].subscription.stage).toBe(1);

        const reminders = subs.process({}, {}, Date.now());
        expect(reminders.disappeared.size).toBe(0);
        expect(reminders.atTheStop.size).toBe(1);
    });
});

