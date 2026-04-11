import fs from "fs";
import path from "path";
import { MongoClient } from "mongodb";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MONGO_URI = "mongodb://127.0.0.1:27017";
const DB_NAME = "indoor_navigation";

async function main() {
  const client = new MongoClient(MONGO_URI);

  try {
    await client.connect();
    console.log("Connected to MongoDB");

    const db = client.db(DB_NAME);
    const collection = db.collection("floorGraphs");

    const filePath = path.join(__dirname, "duderstadt.json");
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);

    const doc = {
      ...data,
      buildingId: String(data.buildingId).toLowerCase(),
      floor: Number(data.floor)
    };

    await collection.deleteOne({
      buildingId: doc.buildingId,
      floor: doc.floor
    });

    const result = await collection.insertOne(doc);
    console.log("Inserted document:", result.insertedId);
  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});