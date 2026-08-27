import { describe, it, expect } from 'vitest';

import * as r from "@/services/reminder";
import { testing as t } from "@/services/reminder";
import { Prediction } from '@/state/transitState';
import * as state from '@/state/transitState';
import { initializeRoutes, rebuildGraph, sortPreds, updateBusPositions } from '@/services/graphBuilder';
import axios from 'axios';
import { configDotenv } from 'dotenv';

const testToken = r.registrationToken("token1");
const testEvent = r.baseEvent({ stpid: "stop1", rtid: "route1" });
const testEventDiffRt = r.baseEvent({ stpid: "stop1", rtid: "route2" });

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
        const subs = new t.ReminderSubscriptions({ mock: true });
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
        expect(
            remindersLater.reminder.get(
                Array.from(remindersLater.reminder.keys())
                    .find((thresholdEvent) => r.sameBaseEvent(r.fromKey(thresholdEvent), testEvent))!
            )!.has(testToken)
        )
            .toBe(true);

        expect(subs.activeRemindersFor(testToken).length).toBe(1);
        expect(t.eventsEqual(subs.activeRemindersFor(testToken)[0].event, testEvent)).toBe(true);
        expect(subs.activeRemindersFor(testToken)[0].stage).toBe(1);
    });

    it('should not send a disappeared notification if there never was a bus in the first place', () => {
        const subs = new t.ReminderSubscriptions({ mock: true });
        // the subscription gets added with no possible candidate vid
        subs.add(testEvent, 3, testToken, {}, Date.now());
        // will it trigger a disappeared reminder?
        const reminders = subs.process({}, {}, Date.now());
        expect(reminders.disappeared.size).toBe(0);
    });

    it('should not trigger for busses of other routes', () => {
        const subs = new t.ReminderSubscriptions({ mock: true });
        const { byStop, byVid } = createCaches([
            { rt: testEventDiffRt.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: Date.now() + 4 * 60 * 1000, prdctdn: "2" }
        ]);
        subs.add(testEvent, 3, testToken, byStop, Date.now());
        const reminders = subs.process(byStop, byVid, Date.now());
        expect(reminders.reminder.size).toBe(0);
    });

    it('should only get removed by the remove method if explicitly targeted', () => {
        const subs = new t.ReminderSubscriptions({ mock: true });
        subs.add(testEvent, 3, testToken, {}, Date.now());
        subs.add(testEventDiffRt, 3, testToken, {}, Date.now());
        subs.add(testEvent, 3, r.registrationToken("anotherToken"), {}, Date.now());
        expect(subs.subscriptions.length).toBe(3);
        subs.remove(testEvent, testToken);
        expect(subs.subscriptions.length).toBe(2);
    });

    it('should send at the stop notifications', () => {
        const subs = new t.ReminderSubscriptions({ mock: true });
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
        const subs = new t.ReminderSubscriptions({ mock: true });
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
        const subs = new t.ReminderSubscriptions({ mock: true });
        const { byStop } = createCaches([
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: Date.now() + 4 * 60 * 1000, prdctdn: "4" }
        ]);
        subs.add(testEvent, 3, testToken, byStop, Date.now());
        const reminders = subs.process({}, {}, Date.now());
        expect(reminders.disappeared.size).toBe(1);
    });

    it('should send disappeared notifications (stage 1)', () => {
        const subs = new t.ReminderSubscriptions({ mock: true });
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
        const subs = new t.ReminderSubscriptions({ mock: true });
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
        const subs = new t.ReminderSubscriptions({ mock: true });
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

    it('should track the correct pass of a looping bus in stage 1', () => {
        const subs = new t.ReminderSubscriptions({ mock: true });
        const now = Date.now();
        // A looping bus serves the stop twice: an earlier pass and the pass the
        // user is actually tracking (loop passes are preserved as separate
        // prediction entries since the looping-bus ingestion fix).
        const passes = (p1: string, p2: string) => createCaches([
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: now + 5 * 60 * 1000, prdctdn: p1 },
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: now + 12 * 60 * 1000, prdctdn: p2 },
        ]);

        // Threshold 8 min: the candidate must arrive after now+8min, i.e. the
        // 12-minute pass, not the 5-minute one.
        const initial = passes("5", "12");
        subs.add(testEvent, 8, testToken, initial.byStop, now);

        // Later: the earlier pass is DUE while the tracked pass hits the threshold.
        const later = passes("1", "8");
        const atThreshold = subs.process(later.byStop, later.byVid, now + 4 * 60 * 1000);
        expect(atThreshold.reminder.size).toBe(1);
        expect(subs.subscriptions[0].subscription.stage).toBe(1);

        // The earlier pass being DUE must NOT fire "at the stop" for the
        // tracked pass, which is still 8 minutes out.
        const afterwards = subs.process(later.byStop, later.byVid, now + 4.5 * 60 * 1000);
        expect(afterwards.atTheStop.size).toBe(0);
        expect(afterwards.disappeared.size).toBe(0);
        expect(subs.subscriptions).toHaveLength(1); // still tracking
    });

    it('should keep tracking a bus that runs a few minutes early in stage 1', () => {
        const subs = new t.ReminderSubscriptions({ mock: true });
        const now = Date.now();
        const { byStop, byVid } = createCaches([
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: now + 4 * 60 * 1000, prdctdn: "2" },
        ]);
        subs.add(testEvent, 3, testToken, byStop, now);
        const first = subs.process(byStop, byVid, now);
        expect(first.reminder.size).toBe(1); // -> stage 1

        // The bus gains 1.5 minutes: its prediction now sits EARLIER than the
        // original expectation. It must stay matched (a frozen lower cutoff
        // used to drop it and fire a false "Bus Disappeared").
        const early = createCaches([
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: now + 2.5 * 60 * 1000, prdctdn: "2" },
        ]);
        const next = subs.process(early.byStop, early.byVid, now + 30 * 1000);
        expect(next.disappeared.size).toBe(0);
        expect(subs.subscriptions).toHaveLength(1); // still tracking
    });

    it('should report arrival (not a huge delay) when the tracked pass completes on a looping bus', () => {
        const subs = new t.ReminderSubscriptions({ mock: true });
        const now = Date.now();
        // prev countdown 4 (> shouldBeArrivingThresh) so the old stpid-only
        // lookup could not sneak through its arrival override — this test must
        // fail on the pre-fix code (which reported "delayed by 16 minutes").
        const { byStop, byVid } = createCaches([
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: now + 6 * 60 * 1000, prdctdn: "4" },
        ]);
        subs.add(testEvent, 5, testToken, byStop, now);
        const toStage1 = subs.process(byStop, byVid, now);
        expect(toStage1.reminder.size).toBe(1); // -> stage 1

        // The tracked pass's prediction vanishes as the bus arrives, but the
        // looping vehicle's NEXT pass (20 min out) is still listed: that must
        // read as "arrived", not "delayed by 16 minutes".
        const nextPassOnly = createCaches([
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: now + 20 * 60 * 1000, prdctdn: "20" },
        ]);
        const result = subs.process(nextPassOnly.byStop, nextPassOnly.byVid, now + 60 * 1000);
        expect(result.delayed.size).toBe(0);
        expect(result.disappeared.size).toBe(0);
        expect(result.atTheStop.size).toBe(1);
    });

    it('should treat a big single-tick prediction jump as a delay while the bus is still far out', () => {
        const subs = new t.ReminderSubscriptions({ mock: true });
        const now = Date.now();
        const { byStop, byVid } = createCaches([
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: now + 9 * 60 * 1000, prdctdn: "8" },
        ]);
        subs.add(testEvent, 8, testToken, byStop, now);
        expect(subs.process(byStop, byVid, now).reminder.size).toBe(1); // -> stage 1, prev=8

        // Countdown jumps 8 -> 15 in one tick (7-min move, past the matching
        // window). The bus was 8 minutes out, so this is a delay to follow —
        // not an arrival, not a disappearance.
        const jumped = createCaches([
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: now + 16 * 60 * 1000, prdctdn: "15" },
        ]);
        const result = subs.process(jumped.byStop, jumped.byVid, now + 60 * 1000);
        expect(result.atTheStop.size).toBe(0);
        expect(result.disappeared.size).toBe(0);
        expect(result.delayed.size).toBe(1);
        expect(subs.subscriptions).toHaveLength(1); // still tracking the moved pass
    });

    it('should hold (not guess) when the tracked pass flips to DLY on a looping bus', () => {
        const subs = new t.ReminderSubscriptions({ mock: true });
        const now = Date.now();
        const { byStop, byVid } = createCaches([
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: now + 6 * 60 * 1000, prdctdn: "4" },
        ]);
        subs.add(testEvent, 5, testToken, byStop, now);
        subs.process(byStop, byVid, now); // -> stage 1, prev=4

        // The tracked pass now reports DLY (no usable countdown) while the
        // next loop pass is also listed: the bus's position is unknowable, so
        // neither arrival nor disappearance may be inferred this tick.
        const dlyTick = createCaches([
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: Number.MAX_SAFE_INTEGER, prdctdn: "DLY" },
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: now + 20 * 60 * 1000, prdctdn: "20" },
        ]);
        const result = subs.process(dlyTick.byStop, dlyTick.byVid, now + 60 * 1000);
        expect(result.atTheStop.size).toBe(0);
        expect(result.disappeared.size).toBe(0);
        expect(result.delayed.size).toBe(0);
        expect(subs.subscriptions).toHaveLength(1);
    });

    it('should expire stale subscriptions instead of keeping zombies forever', () => {
        const subs = new t.ReminderSubscriptions({ mock: true });
        const now = Date.now();
        // No prediction ever matches (e.g. last bus of the day was too close):
        // candidateVid stays null and nothing can ever fire.
        subs.add(testEvent, 3, testToken, {}, now);
        const during = subs.process({}, {}, now + 60 * 1000);
        expect(during.disappeared.size).toBe(0);
        expect(subs.subscriptions).toHaveLength(1);

        // Past the TTL the zombie is dropped (and would otherwise have fired a
        // bogus stale reminder the next service day).
        const after = subs.process({}, {}, now + 4 * 60 * 60 * 1000);
        expect(after.disappeared.size).toBe(0);
        expect(subs.subscriptions).toHaveLength(0);
    });

    it('should not adopt a vid-less (schedule-based) prediction as a trackable candidate', () => {
        const subs = new t.ReminderSubscriptions({ mock: true });
        const now = Date.now();
        // Real overnight feed rows carry vid "" until a vehicle is assigned.
        const { byStop, byVid } = createCaches([
            { rt: testEvent.rtid, vid: "", stpid: testEvent.stpid, prdtm: now + 5 * 60 * 1000, prdctdn: "2" },
        ]);
        subs.add(testEvent, 3, testToken, byStop, now);
        expect(subs.activeRemindersFor(testToken)[0]).toMatchObject({ stage: 0, candidateVid: null });

        // The threshold must HOLD (not fire into an untrackable stage 1, and
        // certainly not throw) until a vehicle is assigned.
        const result = subs.process(byStop, byVid, now + 30 * 1000);
        expect(result.reminder.size).toBe(0);
        expect(subs.subscriptions[0].subscription.stage).toBe(0);
    });

    it('should not duplicate subscriptions when swapping onto a token that already has the event', () => {
        const subs = new t.ReminderSubscriptions({ mock: true });
        const now = Date.now();
        const tokenB = r.registrationToken("tokenB");
        subs.add(testEvent, 3, tokenB, {}, now);
        subs.add(testEvent, 3, testToken, {}, now);
        expect(subs.subscriptions).toHaveLength(2);

        subs.swapToken(testToken, tokenB);
        expect(subs.activeRemindersFor(tokenB)).toHaveLength(1);
        expect(subs.subscriptions).toHaveLength(1);
    });

    it('should ignore delayed (DLY) predictions when selecting candidates', () => {
        const subs = new t.ReminderSubscriptions({ mock: true });
        const now = Date.now();
        // DLY entries are surfaced to the prediction endpoints (with a
        // far-future prdtm) but must never be tracked by reminders.
        const { byStop, byVid } = createCaches([
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: now + 6 * 60 * 1000, prdctdn: "6" },
            { rt: testEvent.rtid, vid: "vid2", stpid: testEvent.stpid, prdtm: Number.MAX_SAFE_INTEGER, prdctdn: "DLY" },
        ]);
        subs.add(testEvent, 3, testToken, byStop, now);
        expect(subs.activeRemindersFor(testToken)[0]).toMatchObject({ stage: 0, candidateVid: "vid1" });

        const reminders = subs.process(byStop, byVid, now);
        expect(reminders.disappeared.size).toBe(0);
        expect(reminders.delayed.size).toBe(0);
    });

    it('should not adopt a DLY-only prediction as a candidate', () => {
        const subs = new t.ReminderSubscriptions({ mock: true });
        const now = Date.now();
        const { byStop, byVid } = createCaches([
            { rt: testEvent.rtid, vid: "vid1", stpid: testEvent.stpid, prdtm: Number.MAX_SAFE_INTEGER, prdctdn: "DLY" },
        ]);
        subs.add(testEvent, 3, testToken, byStop, now);
        expect(subs.activeRemindersFor(testToken)[0]).toMatchObject({ stage: 0, candidateVid: null });

        const reminders = subs.process(byStop, byVid, now);
        expect(reminders.disappeared.size).toBe(0);
    });

    it('should get unix timestamp from ride bus api', async () => {
        configDotenv();
        const RIDE_API_KEY = process.env.RIDE_API_KEY;
        expect(RIDE_API_KEY || process.env.RIDE_URL, 'unable to make requests to a theride bustime server')
            .toBeTruthy();
        const BASE_URL = process.env.RIDE_URL || 'https://rt.theride.org/bustime/api/v3/';

        const client = axios.create({
            baseURL: BASE_URL,
            params: { key: RIDE_API_KEY, format: 'json' }
        });
        const res = await client.get('/gettime', { params: { unixTime: true } });
        const tm = parseInt(res.data["bustime-response"]["tm"]);

        // The invariant under test is the FORMAT: with unixTime=true the feed
        // must return epoch milliseconds, not its default "YYYYMMDD HH:MM:SS"
        // (which parseInt turns into ~2e7) and not epoch seconds (~1.8e9).
        // Proximity to Date.now() is deliberately NOT asserted: CI points
        // RIDE_URL at a mock that replays a recorded fixture, so its clock is
        // legitimately hours or days stale.
        expect(tm).toBeGreaterThan(1_000_000_000_000); // after 2001 in ms
        expect(tm).toBeLessThan(10_000_000_000_000);   // before 2286 in ms
    });

    it('should have cached preds in a good state', async () => {
        // simulate one cycle of the core jobs
        await initializeRoutes();
        await rebuildGraph();
        await updateBusPositions();
        // Overnight and during breaks no vehicles run: the feed may still
        // serve schedule-based predictions (with vid "") or nothing at all,
        // so the count assertions only make sense while vehicles are out.
        // The shape checks below always run on whatever is cached.
        if (state.curBusPositions.buses.length === 0) {
            console.warn('No M-Bus vehicles in service right now; skipping live prediction count checks.');
        } else {
            expect(Object.keys(state.cachedPredsByStopId).length).toBeGreaterThan(0);
            expect(Object.keys(state.cachedPredsByVid).length).toBeGreaterThan(0);
        }
        // expect(Object.keys(state.cachedRidePredsByStopId).length).toBeGreaterThan(0);
        // expect(Object.keys(state.cachedRidePredsByVid).length).toBeGreaterThan(0);
        // are the expected fields all there?
        const sample: Prediction = { rt: "", stpid: "", vid: "", prdtm: 0, prdctdn: "" };
        const allThere = (x: Prediction) => {
            for (const k in sample) {
                expect(k + ":" +typeof x[k]).toBe(k + ":" + typeof sample[k]);
                if (k == "prdtm") {
                    expect(x[k]).toBeGreaterThanOrEqual(Date.now() - 2 * 24 * 60 * 60 * 1000);
                }
            }  
        };
        [state.cachedPredsByStopId, state.cachedPredsByVid, state.cachedRidePredsByStopId, state.cachedRidePredsByVid]
            .forEach((preds) => {
                for (const k in preds) {
                    // forEach, not every: allThere returns undefined, so
                    // every() would stop after the first prediction.
                    preds[k].forEach(allThere);
                }
            });
    // Generous timeout: on a cold walking cache (fresh checkout / CI) the
    // pipeline computes stop-pair paths before this test can proceed.
    }, 120000);
});

