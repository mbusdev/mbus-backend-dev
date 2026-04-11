import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GraphLoader } from "./GraphLoader";
import { Pathfinder } from "./pathfinderAstar";
import { MongoClient } from "mongodb";
import { buildGraphLoadPlan } from "./buildGraphLoadPlan";
import { GraphMerger } from "./GraphMerger";
import { GraphRepository } from "./GraphRepository";
import { FloorGraphJson } from "./types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MONGO_URI = "mongodb://127.0.0.1:27017";
const DB_NAME = "indoor_navigation";
const COLLECTION_NAME = "floorGraphs";

const client = new MongoClient(MONGO_URI);
let floorGraphsCollection: any;

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.send("Indoor navigation server is running");
});

app.post("/route", async (req, res) => {
  try {
    const { startNodeId, endNodeId } = req.body;

    if (!startNodeId || !endNodeId) {
      return res.status(400).json({
        error: "startNodeId and endNodeId are required"
      });
    }

    const graphRepo = new GraphRepository(floorGraphsCollection);
    const plan = buildGraphLoadPlan(startNodeId, endNodeId);
    const floorDocs = await graphRepo.getFloorGraphs(plan.targets);

    if (floorDocs.length === 0) {
      return res.status(404).json({
      error: "No graph documents found for requested route scope"
      });
    }

    const loadedGraphs = floorDocs.map((doc: any) =>
      GraphLoader.loadFloorGraph(doc)
    );

    const combinedGraph = GraphMerger.mergeGraphs(loadedGraphs);

    if (!combinedGraph.nodesById[startNodeId]) {
      return res.status(404).json({
        error: `Start node not found in loaded graph scope: ${startNodeId}`
      });
    }
    if (!combinedGraph.nodesById[endNodeId]) {
      return res.status(404).json({
        error: `End node not found in loaded graph scope: ${endNodeId}`
      });
    }

    const result = Pathfinder.shortestPathAStarHeap(
      combinedGraph.adjacencyList,
      combinedGraph.nodesById,
      startNodeId,
      endNodeId
    );

    return res.json({
      startNodeId,
      endNodeId,
      loadedTargets: plan.targets,
      nodePath: result.nodePath,
      steps: result.steps,
      totalCost: result.totalCost
    });

    } catch (error: any) {
      console.error("Route error:", error);
      return res.status(500).json({
        error: error.message || "Internal server error"
      });
    }
});

app.get("/graph", async (req, res) => {
  try {
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

    return res.json({
      buildingId: data.buildingId,
      floor: data.floor,
      nodes: data.nodes,
      edges: data.edges
    });
  } catch (error: any) {
    console.error("Graph fetch error:", error);
    return res.status(500).json({
      error: error.message || "Internal server error"
    });
  }
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