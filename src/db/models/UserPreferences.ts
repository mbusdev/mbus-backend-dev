import mongoose, { Schema, Document } from "mongoose";

export interface IUserPreferences extends Document {
  accountId: mongoose.Types.ObjectId;
  defaultView: string;
  notificationsEnabled: boolean;
  notifyMinutesBefore: number;
  preferredRouteIds: string[];
  accessibilityMode: boolean;
  theme: string;
  updatedAt: Date;
}

const UserPreferencesSchema = new Schema<IUserPreferences>({
  accountId:            { type: Schema.Types.ObjectId, required: true, unique: true, ref: "InternalAccount" },
  defaultView:          { type: String, default: "map" },
  notificationsEnabled: { type: Boolean, default: true },
  notifyMinutesBefore:  { type: Number, default: 5 },
  preferredRouteIds:    { type: [String], default: [] },
  accessibilityMode:    { type: Boolean, default: false },
  theme:                { type: String, default: "system" },
  updatedAt:            { type: Date, default: Date.now },
});

export const UserPreferences = mongoose.model<IUserPreferences>(
  "UserPreferences", UserPreferencesSchema
);