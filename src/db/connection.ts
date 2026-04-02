import mongoose from "mongoose";

export async function connectToDatabase(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  await mongoose.connect(uri);
  console.log("Connected to MongoDB");
}