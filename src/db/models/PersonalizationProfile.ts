import mongoose, { Schema, Document } from "mongoose";

export interface IPersonalizationProfile extends Document {
  accountId: mongoose.Types.ObjectId;
  topStopIds: string[];
  topRouteIds: string[];
  topBuildingIds: string[];
  peakUsageHours: number[];
  computedAt: Date;
}

const PersonalizationProfileSchema = new Schema<IPersonalizationProfile>({
  accountId:      { type: Schema.Types.ObjectId, required: true, unique: true, ref: "InternalAccount" },
  topStopIds:     { type: [String], default: [] },
  topRouteIds:    { type: [String], default: [] },
  topBuildingIds: { type: [String], default: [] },
  peakUsageHours: { type: [Number], default: [] },
  computedAt:     { type: Date, default: Date.now },
});

export const PersonalizationProfile = mongoose.model<IPersonalizationProfile>(
  "PersonalizationProfile", PersonalizationProfileSchema
);