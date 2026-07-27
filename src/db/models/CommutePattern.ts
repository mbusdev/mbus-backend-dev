import mongoose, { Schema, Document } from "mongoose";

export interface ICommutePattern extends Document {
  accountId: mongoose.Types.ObjectId;
  fromStopId: string;
  toStopId: string;
  routeId: string;
  daysOfWeek: number[];  // 0=Sun … 6=Sat
  typicalHour: number;
  confidence: number;
  lastSeen: Date;
}

const CommutePatternSchema = new Schema<ICommutePattern>({
  accountId:   { type: Schema.Types.ObjectId, required: true, ref: "InternalAccount" },
  fromStopId:  { type: String, required: true },
  toStopId:    { type: String, required: true },
  routeId:     { type: String, required: true },
  daysOfWeek:  { type: [Number], default: [] },
  typicalHour: { type: Number, required: true },
  confidence:  { type: Number, default: 0 },
  lastSeen:    { type: Date, default: Date.now },
});

export const CommutePattern = mongoose.model<ICommutePattern>(
  "CommutePattern", CommutePatternSchema
);