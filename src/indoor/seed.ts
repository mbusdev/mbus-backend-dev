import { MongoClient } from "mongodb";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MONGO_URI = "mongodb://127.0.0.1:27017";
const DB_NAME = "indoor_navigation";

const client = new MongoClient(MONGO_URI);

async function seed() {
  await client.connect();
  console.log("Connected to MongoDB");

  const db = client.db(DB_NAME);
  const collection = db.collection("floorGraphs");

  const raw = fs.readFileSync(path.join(__dirname, "duderstadt.json"), "utf-8");
  const data = JSON.parse(raw);

  // Remove existing document for this building/floor to avoid duplicates
  await collection.deleteOne({ buildingId: data.buildingId, floor: data.floor });

  await collection.insertOne(data);
  console.log(`Inserted graph for buildingId=${data.buildingId} floor=${data.floor}`);

  await client.close();
}

seed();