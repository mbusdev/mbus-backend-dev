import mongoose, { Schema, Document } from "mongoose";

export interface INotificationLog extends Document {
  accountId: mongoose.Types.ObjectId;
  type: string;
  routeId: string;
  stopId: string;
  sentAt: Date;
  opened: boolean;
  openedAt: Date | null;
}

const NotificationLogSchema = new Schema<INotificationLog>({
  accountId: { type: Schema.Types.ObjectId, required: true, ref: "InternalAccount" },
  type:      { type: String, required: true },
  routeId:   { type: String, default: "" },
  stopId:    { type: String, default: "" },
  sentAt:    { type: Date, default: Date.now },
  opened:    { type: Boolean, default: false },
  openedAt:  { type: Date, default: null },
});

export const NotificationLog = mongoose.model<INotificationLog>(
  "NotificationLog", NotificationLogSchema
);