import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GraphLoader } from "./GraphLoader";
import { Pathfinder } from "./pathfinder";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.send("Indoor navigation server is running");
});

app.post("/route", (req, res) => {
  const { buildingId, floor, startNodeId, endNodeId } = req.body;

  // 1. 读本地 graph json（先写死路径，后面再优化）
    const graphPath = path.join(__dirname, "data", "sample.json");

    const raw = fs.readFileSync(graphPath, "utf-8");
    const data = JSON.parse(raw);

    // 2. 加载图
    const loadedGraph = GraphLoader.loadFloorGraph(data);

    // 3. 跑路径
    const result = Pathfinder.shortestPath(
        loadedGraph.adjacencyList,
        startNodeId,
        endNodeId
    );

    // 4. 返回结果
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

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});