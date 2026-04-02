import mongoose, { Schema, Document } from "mongoose";

export interface ISavedStop extends Document {
  accountId: mongoose.Types.ObjectId;
  stopId: string;
  customLabel: string;
  pinned: boolean;
  pinnedOrder: number;
  savedAt: Date;
}

const SavedStopSchema = new Schema<ISavedStop>({
  accountId:   { type: Schema.Types.ObjectId, required: true, ref: "InternalAccount" },
  stopId:      { type: String, required: true },
  customLabel: { type: String, default: "" },
  pinned:      { type: Boolean, default: false },
  pinnedOrder: { type: Number, default: 0 },
  savedAt:     { type: Date, default: Date.now },
});
// Prevent duplicate saves for same account + stop
SavedStopSchema.index({ accountId: 1, stopId: 1 }, { unique: true });

export const SavedStop = mongoose.model<ISavedStop>("SavedStop", SavedStopSchema);