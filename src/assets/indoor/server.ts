import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GraphLoader } from "./GraphLoader";
import { Pathfinder } from "./pathfinderAstar";
import { MongoClient } from "mongodb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MONGO_URI = "mongodb://127.0.0.1:27017";
const DB_NAME = "indoor_navigation";

const client = new MongoClient(MONGO_URI);
let floorGraphsCollection: any;

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.send("Indoor navigation server is running");
});

app.post("/route", async (req, res) => {
  const { buildingId, floor, startNodeId, endNodeId } = req.body;

  // read graph .json
    const data = await floorGraphsCollection.findOne({   
    buildingId,  
    floor
    });
 
    if (!data) {
      return res.status(404)
    }

    // load graph
    const loadedGraph = GraphLoader.loadFloorGraph(data);

    // run route
    const result = Pathfinder.shortestPathAStarHeap(
        loadedGraph.adjacencyList,
        loadedGraph.nodesById,
        startNodeId,
        endNodeId
    );

    // return result
    res.json({
    buildingId,
    floor,
    startNodeId,
    endNodeId,
    nodePath: result.nodePath,
    steps: result.steps,
    totalCost: result.totalCost
    });
});

app.get("/graph", async (req, res) => {
  const { buildingId, floor } = req.query;

  if (!buildingId || !floor) {
    return res.status(400).json({
      error: "buildingId and floor are required"
    });
  }

  const data = await floorGraphsCollection.findOne({
    buildingId: String(buildingId),
    floor: Number(floor)
  });

  if (!data) {
    return res.status(404).json({
      error: "graph not found"
    });
  }

  res.json({
    buildingId: data.buildingId,
    floor: data.floor,
    nodes: data.nodes,
    edges: data.edges
  });
});

const PORT = 3000;

async function startServer() {
  await client.connect();
  console.log("Connected to MongoDB");

  const db = client.db(DB_NAME);
  floorGraphsCollection = db.collection("floorGraphs");

  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer();