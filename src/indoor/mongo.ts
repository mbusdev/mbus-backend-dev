import { MongoClient } from "mongodb";

const MONGO_URI = process.env.INDOOR_MONGO_URI ?? "mongodb://127.0.0.1:27017";

const client = new MongoClient(MONGO_URI);

let connected = false;

export async function getDb() {
  if (!connected) {
    await client.connect();
    connected = true;
    console.log("[Mongo] Connected");
  }
  return client.db("indoor_navigation");
}