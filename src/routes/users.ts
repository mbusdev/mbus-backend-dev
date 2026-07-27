import express from "express";
import * as z from "zod";
import mongoose from "mongoose";
import { InternalAccount } from "../db/models/InternalAccount.js";
import { UserPreferences } from "../db/models/UserPreferences.js";
import { SavedStop } from "../db/models/SavedStop.js";
import { CommutePattern } from "../db/models/CommutePattern.js";
import { SearchHistory } from "../db/models/SearchHistory.js";
import { NotificationLog } from "../db/models/NotificationLog.js";
import { TripHistory } from "../db/models/TripHistory.js";
import { PersonalizationProfile } from "../db/models/PersonalizationProfile.js";

const router = express.Router();

function parseObjectId(id: string): mongoose.Types.ObjectId | null {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
}

// POST /account  — create account
const CreateAccountBody = z.object({
  uniqname: z.string(),
  roles: z.array(z.string()).optional(),
});

export async function createAccount(req: express.Request, res: express.Response) {
  const parsed = CreateAccountBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const existing = await InternalAccount.findOne({ uniqname: parsed.data.uniqname });
  if (existing) return res.status(409).json({ error: "Account already exists" });
  const account = await InternalAccount.create(parsed.data);
  res.status(201).json(account);
}
router.post("/", createAccount);

// GET /account/:accountId
export async function getAccount(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  if (!id) return res.status(400).json({ error: "Invalid accountId" });
  const account = await InternalAccount.findById(id);
  if (!account) return res.status(404).json({ error: "Not found" });
  res.json(account);
}
router.get("/:accountId", getAccount);

// PATCH /account/:accountId  — update roles or active
const UpdateAccountBody = z.object({
  roles: z.array(z.string()).optional(),
  active: z.boolean().optional(),
  lastLoginAt: z.string().datetime().optional(),
});

export async function updateAccount(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  if (!id) return res.status(400).json({ error: "Invalid accountId" });
  const parsed = UpdateAccountBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const account = await InternalAccount.findByIdAndUpdate(id, parsed.data, { new: true });
  if (!account) return res.status(404).json({ error: "Not found" });
  res.json(account);
}
router.patch("/:accountId", updateAccount);

// DELETE /account/:accountId  — soft delete
export async function deactivateAccount(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  if (!id) return res.status(400).json({ error: "Invalid accountId" });
  const account = await InternalAccount.findByIdAndUpdate(id, { active: false }, { new: true });
  if (!account) return res.status(404).json({ error: "Not found" });
  res.json({ success: true });
}
router.delete("/:accountId", deactivateAccount);


// GET /account/:accountId/preferences
export async function getPreferences(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  if (!id) return res.status(400).json({ error: "Invalid accountId" });
  const prefs = await UserPreferences.findOne({ accountId: id });
  if (!prefs) return res.status(404).json({ error: "Not found" });
  res.json(prefs);
}
router.get("/:accountId/preferences", getPreferences);

// PUT /account/:accountId/preferences  — upsert
const UpsertPreferencesBody = z.object({
  defaultView:          z.string().optional(),
  notificationsEnabled: z.boolean().optional(),
  notifyMinutesBefore:  z.number().int().optional(),
  preferredRouteIds:    z.array(z.string()).optional(),
  accessibilityMode:    z.boolean().optional(),
  theme:                z.string().optional(),
});

export async function upsertPreferences(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  if (!id) return res.status(400).json({ error: "Invalid accountId" });
  const parsed = UpsertPreferencesBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const prefs = await UserPreferences.findOneAndUpdate(
    { accountId: id },
    { ...parsed.data, updatedAt: new Date() },
    { new: true, upsert: true }
  );
  res.json(prefs);
}
router.put("/:accountId/preferences", upsertPreferences);


// GET /account/:accountId/saved-stops
export async function getSavedStops(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  if (!id) return res.status(400).json({ error: "Invalid accountId" });
  const stops = await SavedStop.find({ accountId: id }).sort({ pinnedOrder: 1, savedAt: -1 });
  res.json(stops);
}
router.get("/:accountId/saved-stops", getSavedStops);

// POST /account/:accountId/saved-stops
const CreateSavedStopBody = z.object({
  stopId:      z.string(),
  customLabel: z.string().optional(),
  pinned:      z.boolean().optional(),
  pinnedOrder: z.number().int().optional(),
});

export async function createSavedStop(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  if (!id) return res.status(400).json({ error: "Invalid accountId" });
  const parsed = CreateSavedStopBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  try {
    const stop = await SavedStop.create({ accountId: id, ...parsed.data });
    res.status(201).json(stop);
  } catch (e: any) {
    if (e.code === 11000) return res.status(409).json({ error: "Stop already saved" });
    throw e;
  }
}
router.post("/:accountId/saved-stops", createSavedStop);

// PATCH /account/:accountId/saved-stops/:stopId
const UpdateSavedStopBody = z.object({
  customLabel: z.string().optional(),
  pinned:      z.boolean().optional(),
  pinnedOrder: z.number().int().optional(),
});

export async function updateSavedStop(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  if (!id) return res.status(400).json({ error: "Invalid accountId" });
  const parsed = UpdateSavedStopBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const stop = await SavedStop.findOneAndUpdate(
    { accountId: id, stopId: req.params.stopId },
    parsed.data,
    { new: true }
  );
  if (!stop) return res.status(404).json({ error: "Not found" });
  res.json(stop);
}
router.patch("/:accountId/saved-stops/:stopId", updateSavedStop);

// DELETE /account/:accountId/saved-stops/:stopId
export async function deleteSavedStop(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  if (!id) return res.status(400).json({ error: "Invalid accountId" });
  const result = await SavedStop.findOneAndDelete({ accountId: id, stopId: req.params.stopId });
  if (!result) return res.status(404).json({ error: "Not found" });
  res.json({ success: true });
}
router.delete("/:accountId/saved-stops/:stopId", deleteSavedStop);


// GET /account/:accountId/search-history  — optional ?limit
export async function getSearchHistory(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  if (!id) return res.status(400).json({ error: "Invalid accountId" });
  const limit = parseInt(req.query.limit as string) || 20;
  const entries = await SearchHistory.find({ accountId: id })
    .sort({ lastSearchedAt: -1 })
    .limit(limit);
  res.json(entries);
}
router.get("/:accountId/search-history", getSearchHistory);

// POST /account/:accountId/search-history — upsert on (accountId + query + resultId)
const AddSearchEntryBody = z.object({
  query:      z.string(),
  resultType: z.string().optional(),
  resultId:   z.string().optional(),
});

export async function addSearchEntry(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  if (!id) return res.status(400).json({ error: "Invalid accountId" });
  const parsed = AddSearchEntryBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const { query, resultType = "", resultId = "" } = parsed.data;
  const entry = await SearchHistory.findOneAndUpdate(
    { accountId: id, query, resultId },
    {
      $inc: { searchCount: 1 },
      $set: { lastSearchedAt: new Date(), resultType },
      $setOnInsert: { accountId: id, query, resultId },
    },
    { new: true, upsert: true }
  );
  res.json(entry);
}
router.post("/:accountId/search-history", addSearchEntry);

// DELETE /account/:accountId/search-history — clear all
export async function clearSearchHistory(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  if (!id) return res.status(400).json({ error: "Invalid accountId" });
  await SearchHistory.deleteMany({ accountId: id });
  res.json({ success: true });
}
router.delete("/:accountId/search-history", clearSearchHistory);

// DELETE /account/:accountId/search-history/:entryId
export async function deleteSearchEntry(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  const entryId = parseObjectId(req.params.entryId);
  if (!id || !entryId) return res.status(400).json({ error: "Invalid id" });
  const result = await SearchHistory.findOneAndDelete({ _id: entryId, accountId: id });
  if (!result) return res.status(404).json({ error: "Not found" });
  res.json({ success: true });
}
router.delete("/:accountId/search-history/:entryId", deleteSearchEntry);


// GET /account/:accountId/notification-log  — optional ?limit
export async function getNotificationLog(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  if (!id) return res.status(400).json({ error: "Invalid accountId" });
  const limit = parseInt(req.query.limit as string) || 50;
  const logs = await NotificationLog.find({ accountId: id })
    .sort({ sentAt: -1 })
    .limit(limit);
  res.json(logs);
}
router.get("/:accountId/notification-log", getNotificationLog);

// POST /account/:accountId/notification-log
const CreateNotificationLogBody = z.object({
  type:    z.string(),
  routeId: z.string().optional(),
  stopId:  z.string().optional(),
});

export async function createNotificationLog(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  if (!id) return res.status(400).json({ error: "Invalid accountId" });
  const parsed = CreateNotificationLogBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const log = await NotificationLog.create({ accountId: id, ...parsed.data });
  res.status(201).json(log);
}
router.post("/:accountId/notification-log", createNotificationLog);

// PATCH /account/:accountId/notification-log/:logId — mark as opened
export async function markNotificationOpened(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  const logId = parseObjectId(req.params.logId);
  if (!id || !logId) return res.status(400).json({ error: "Invalid id" });
  const log = await NotificationLog.findOneAndUpdate(
    { _id: logId, accountId: id },
    { opened: true, openedAt: new Date() },
    { new: true }
  );
  if (!log) return res.status(404).json({ error: "Not found" });
  res.json(log);
}
router.patch("/:accountId/notification-log/:logId", markNotificationOpened);


// GET /account/:accountId/trip-history
export async function getTripHistory(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  if (!id) return res.status(400).json({ error: "Invalid accountId" });
  const trips = await TripHistory.find({ accountId: id }).sort({ startedAt: -1 });
  res.json(trips);
}
router.get("/:accountId/trip-history", getTripHistory);

// POST /account/:accountId/trip-history
const CreateTripBody = z.object({
  routeId:      z.string(),
  boardStopId:  z.string(),
  alightStopId: z.string(),
  startedAt:    z.string().datetime(),
  endedAt:      z.string().datetime(),
  source:       z.string().optional(),
});

export async function createTripHistory(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  if (!id) return res.status(400).json({ error: "Invalid accountId" });
  const parsed = CreateTripBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const trip = await TripHistory.create({ accountId: id, ...parsed.data });
  res.status(201).json(trip);
}
router.post("/:accountId/trip-history", createTripHistory);

// DELETE /account/:accountId/trip-history/:tripId
export async function deleteTripHistory(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  const tripId = parseObjectId(req.params.tripId);
  if (!id || !tripId) return res.status(400).json({ error: "Invalid id" });
  const result = await TripHistory.findOneAndDelete({ _id: tripId, accountId: id });
  if (!result) return res.status(404).json({ error: "Not found" });
  res.json({ success: true });
}
router.delete("/:accountId/trip-history/:tripId", deleteTripHistory);


// GET /account/:accountId/commute-patterns
export async function getCommutePatterns(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  if (!id) return res.status(400).json({ error: "Invalid accountId" });
  const patterns = await CommutePattern.find({ accountId: id });
  res.json(patterns);
}
router.get("/:accountId/commute-patterns", getCommutePatterns);

// DELETE /account/:accountId/commute-patterns/:patternId
export async function deleteCommutePattern(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  const patternId = parseObjectId(req.params.patternId);
  if (!id || !patternId) return res.status(400).json({ error: "Invalid id" });
  const result = await CommutePattern.findOneAndDelete({ _id: patternId, accountId: id });
  if (!result) return res.status(404).json({ error: "Not found" });
  res.json({ success: true });
}
router.delete("/:accountId/commute-patterns/:patternId", deleteCommutePattern);


// GET /account/:accountId/personalization-profile
export async function getPersonalizationProfile(req: express.Request, res: express.Response) {
  const id = parseObjectId(req.params.accountId);
  if (!id) return res.status(400).json({ error: "Invalid accountId" });
  const profile = await PersonalizationProfile.findOne({ accountId: id });
  if (!profile) return res.status(404).json({ error: "Not found" });
  res.json(profile);
}
router.get("/:accountId/personalization-profile", getPersonalizationProfile);


export default router;
