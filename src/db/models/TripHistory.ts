import mongoose, { Schema, Document } from "mongoose";

export interface ITripHistory extends Document {
  accountId: mongoose.Types.ObjectId;
  routeId: string;
  boardStopId: string;
  alightStopId: string;
  startedAt: Date;
  endedAt: Date;
  source: string;
}

const TripHistorySchema = new Schema<ITripHistory>({
  accountId:    { type: Schema.Types.ObjectId, required: true, ref: "InternalAccount" },
  routeId:      { type: String, required: true },
  boardStopId:  { type: String, required: true },
  alightStopId: { type: String, required: true },
  startedAt:    { type: Date, required: true },
  endedAt:      { type: Date, required: true },
  source:       { type: String, default: "manual" },
});

export const TripHistory = mongoose.model<ITripHistory>("TripHistory", TripHistorySchema);
