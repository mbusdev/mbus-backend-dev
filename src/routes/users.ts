import express from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/requireAuth.js";
import { InternalAccount } from "../db/models/InternalAccount.js";
import { UserPreferences } from "../db/models/UserPreferences.js";
import { SavedStop } from "../db/models/SavedStop.js";
import { CommutePattern } from "../db/models/CommutePattern.js";
import { SearchHistory } from "../db/models/SearchHistory.js";
import { NotificationLog } from "../db/models/NotificationLog.js";
import { TripHistory } from "../db/models/TripHistory.js";
import { PersonalizationProfile } from "../db/models/PersonalizationProfile.js";

const router = express.Router();

// All routes require authentication — user can only access their own data
router.use(requireAuth);

/** Helper: get the logged-in user's accountId as an ObjectId */
function getAccountId(req: express.Request): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(req.user!.accountId!);
}

/** Helper: parse a string as an ObjectId, or null if invalid */
function parseObjectId(id: string): mongoose.Types.ObjectId | null {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
}

// ──────────────────────────────────────────────
// Account
// ──────────────────────────────────────────────

// GET /account — get own account
router.get("/", async (req, res) => {
  const account = await InternalAccount.findById(getAccountId(req));
  if (!account) return res.status(404).json({ error: "Not found" });
  res.json(account);
});

// PATCH /account — update own account
const UpdateAccountBody = z.object({
  roles: z.array(z.string()).optional(),
  active: z.boolean().optional(),
});

router.patch("/", async (req, res) => {
  const parsed = UpdateAccountBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const account = await InternalAccount.findByIdAndUpdate(
    getAccountId(req),
    parsed.data,
    { new: true },
  );
  if (!account) return res.status(404).json({ error: "Not found" });
  res.json(account);
});

// DELETE /account — soft-delete (set active=false)
router.delete("/", async (req, res) => {
  const account = await InternalAccount.findByIdAndUpdate(
    getAccountId(req),
    { active: false },
    { new: true },
  );
  if (!account) return res.status(404).json({ error: "Not found" });
  res.json({ success: true });
});

// ──────────────────────────────────────────────
// Preferences
// ──────────────────────────────────────────────

// GET /account/preferences
router.get("/preferences", async (req, res) => {
  const prefs = await UserPreferences.findOne({ accountId: getAccountId(req) });
  if (!prefs) return res.status(404).json({ error: "Not found" });
  res.json(prefs);
});

// PUT /account/preferences — upsert
const UpsertPreferencesBody = z.object({
  defaultView: z.string().optional(),
  notificationsEnabled: z.boolean().optional(),
  notifyMinutesBefore: z.number().int().optional(),
  preferredRouteIds: z.array(z.string()).optional(),
  accessibilityMode: z.boolean().optional(),
  theme: z.string().optional(),
});

router.put("/preferences", async (req, res) => {
  const parsed = UpsertPreferencesBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const prefs = await UserPreferences.findOneAndUpdate(
    { accountId: getAccountId(req) },
    { ...parsed.data, updatedAt: new Date() },
    { new: true, upsert: true },
  );
  res.json(prefs);
});

// ──────────────────────────────────────────────
// Saved Stops
// ──────────────────────────────────────────────

// GET /account/saved-stops
router.get("/saved-stops", async (req, res) => {
  const stops = await SavedStop.find({ accountId: getAccountId(req) })
    .sort({ pinnedOrder: 1, savedAt: -1 });
  res.json(stops);
});

// POST /account/saved-stops
const CreateSavedStopBody = z.object({
  stopId: z.string(),
  customLabel: z.string().optional(),
  pinned: z.boolean().optional(),
  pinnedOrder: z.number().int().optional(),
});

router.post("/saved-stops", async (req, res) => {
  const parsed = CreateSavedStopBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  try {
    const stop = await SavedStop.create({ accountId: getAccountId(req), ...parsed.data });
    res.status(201).json(stop);
  } catch (e: any) {
    if (e.code === 11000) return res.status(409).json({ error: "Already saved" });
    throw e;
  }
});

// PATCH /account/saved-stops/:stopId
const UpdateSavedStopBody = z.object({
  customLabel: z.string().optional(),
  pinned: z.boolean().optional(),
  pinnedOrder: z.number().int().optional(),
});

router.patch("/saved-stops/:stopId", async (req, res) => {
  const parsed = UpdateSavedStopBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const stop = await SavedStop.findOneAndUpdate(
    { accountId: getAccountId(req), stopId: req.params.stopId },
    parsed.data,
    { new: true },
  );
  if (!stop) return res.status(404).json({ error: "Not found" });
  res.json(stop);
});

// DELETE /account/saved-stops/:stopId
router.delete("/saved-stops/:stopId", async (req, res) => {
  const result = await SavedStop.findOneAndDelete({
    accountId: getAccountId(req),
    stopId: req.params.stopId,
  });
  if (!result) return res.status(404).json({ error: "Not found" });
  res.json({ success: true });
});

// ──────────────────────────────────────────────
// Search History
// ──────────────────────────────────────────────

// GET /account/search-history — optional ?limit (default 20)
router.get("/search-history", async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 20;
  const entries = await SearchHistory.find({ accountId: getAccountId(req) })
    .sort({ lastSearchedAt: -1 })
    .limit(limit);
  res.json(entries);
});

// POST /account/search-history — upsert on (accountId + query + resultId)
const AddSearchEntryBody = z.object({
  query: z.string(),
  resultType: z.string().optional(),
  resultId: z.string().optional(),
});

router.post("/search-history", async (req, res) => {
  const parsed = AddSearchEntryBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const accountId = getAccountId(req);
  const { query, resultType = "", resultId = "" } = parsed.data;
  const entry = await SearchHistory.findOneAndUpdate(
    { accountId, query, resultId },
    {
      $inc: { searchCount: 1 },
      $set: { lastSearchedAt: new Date(), resultType },
      $setOnInsert: { accountId, query, resultId },
    },
    { new: true, upsert: true },
  );
  res.json(entry);
});

// DELETE /account/search-history — clear all
router.delete("/search-history", async (req, res) => {
  await SearchHistory.deleteMany({ accountId: getAccountId(req) });
  res.json({ success: true });
});

// DELETE /account/search-history/:entryId
router.delete("/search-history/:entryId", async (req, res) => {
  const entryId = parseObjectId(req.params.entryId);
  if (!entryId) return res.status(400).json({ error: "Invalid entryId" });
  const result = await SearchHistory.findOneAndDelete({
    _id: entryId,
    accountId: getAccountId(req),
  });
  if (!result) return res.status(404).json({ error: "Not found" });
  res.json({ success: true });
});

// ──────────────────────────────────────────────
// Notification Log
// ──────────────────────────────────────────────

// GET /account/notification-log — optional ?limit (default 50)
router.get("/notification-log", async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const logs = await NotificationLog.find({ accountId: getAccountId(req) })
    .sort({ sentAt: -1 })
    .limit(limit);
  res.json(logs);
});

// POST /account/notification-log
const CreateNotificationLogBody = z.object({
  type: z.string(),
  routeId: z.string().optional(),
  stopId: z.string().optional(),
});

router.post("/notification-log", async (req, res) => {
  const parsed = CreateNotificationLogBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const log = await NotificationLog.create({
    accountId: getAccountId(req),
    ...parsed.data,
  });
  res.status(201).json(log);
});

// PATCH /account/notification-log/:logId — mark as opened
router.patch("/notification-log/:logId", async (req, res) => {
  const logId = parseObjectId(req.params.logId);
  if (!logId) return res.status(400).json({ error: "Invalid logId" });
  const log = await NotificationLog.findOneAndUpdate(
    { _id: logId, accountId: getAccountId(req) },
    { opened: true, openedAt: new Date() },
    { new: true },
  );
  if (!log) return res.status(404).json({ error: "Not found" });
  res.json(log);
});

// ──────────────────────────────────────────────
// Trip History
// ──────────────────────────────────────────────

// GET /account/trip-history
router.get("/trip-history", async (req, res) => {
  const trips = await TripHistory.find({ accountId: getAccountId(req) })
    .sort({ startedAt: -1 });
  res.json(trips);
});

// POST /account/trip-history
const CreateTripBody = z.object({
  routeId: z.string(),
  boardStopId: z.string(),
  alightStopId: z.string(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  source: z.string().optional(),
});

router.post("/trip-history", async (req, res) => {
  const parsed = CreateTripBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const trip = await TripHistory.create({
    accountId: getAccountId(req),
    ...parsed.data,
  });
  res.status(201).json(trip);
});

// DELETE /account/trip-history/:tripId
router.delete("/trip-history/:tripId", async (req, res) => {
  const tripId = parseObjectId(req.params.tripId);
  if (!tripId) return res.status(400).json({ error: "Invalid tripId" });
  const result = await TripHistory.findOneAndDelete({
    _id: tripId,
    accountId: getAccountId(req),
  });
  if (!result) return res.status(404).json({ error: "Not found" });
  res.json({ success: true });
});

// ──────────────────────────────────────────────
// Commute Patterns (system-generated, read + delete only)
// ──────────────────────────────────────────────

// GET /account/commute-patterns
router.get("/commute-patterns", async (req, res) => {
  const patterns = await CommutePattern.find({ accountId: getAccountId(req) });
  res.json(patterns);
});

// DELETE /account/commute-patterns/:patternId
router.delete("/commute-patterns/:patternId", async (req, res) => {
  const patternId = parseObjectId(req.params.patternId);
  if (!patternId) return res.status(400).json({ error: "Invalid patternId" });
  const result = await CommutePattern.findOneAndDelete({
    _id: patternId,
    accountId: getAccountId(req),
  });
  if (!result) return res.status(404).json({ error: "Not found" });
  res.json({ success: true });
});

// ──────────────────────────────────────────────
// Personalization Profile (system-generated, read-only)
// ──────────────────────────────────────────────

// GET /account/personalization-profile
router.get("/personalization-profile", async (req, res) => {
  const profile = await PersonalizationProfile.findOne({
    accountId: getAccountId(req),
  });
  if (!profile) return res.status(404).json({ error: "Not found" });
  res.json(profile);
});

export default router;
