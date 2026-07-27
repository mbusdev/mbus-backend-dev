import mongoose, { Schema, Document } from "mongoose";

export interface IInternalAccount extends Document {
  uniqname: string;
  roles: string[];
  createdAt: Date;
  lastLoginAt: Date;
  active: boolean;
}

const InternalAccountSchema = new Schema<IInternalAccount>({
  uniqname:    { type: String, required: true, unique: true },
  roles:       { type: [String], default: [] },
  createdAt:   { type: Date, default: Date.now },
  lastLoginAt: { type: Date, default: Date.now },
  active:      { type: Boolean, default: true },
});

export const InternalAccount = mongoose.model<IInternalAccount>(
  "InternalAccount", InternalAccountSchema
);