import mongoose, { Schema, Document } from "mongoose";

export interface IUserSearchHistory extends Document {
  accountId: mongoose.Types.ObjectId;
  query: string;
  resultType: string;
  resultId: string;
  searchCount: number;
  lastSearchedAt: Date;
}

const UserSearchHistorySchema = new Schema<IUserSearchHistory>({
  accountId:      { type: Schema.Types.ObjectId, required: true, ref: "InternalAccount" },
  query:          { type: String, required: true },
  resultType:     { type: String, default: "" },
  resultId:       { type: String, default: "" },
  searchCount:    { type: Number, default: 1 },
  lastSearchedAt: { type: Date, default: Date.now },
});
// Upsert key: one entry per (account, query, resultId) combo
UserSearchHistorySchema.index({ accountId: 1, query: 1, resultId: 1 }, { unique: true });

export const SearchHistory = mongoose.model<IUserSearchHistory>(
  "SearchHistory", UserSearchHistorySchema
);