import fs from "fs";
import { GraphLoader } from "./GraphLoader";
import { Pathfinder } from "./pathfinderAstar";

// testing a star  w/ simple test

const raw = fs.readFileSync("./sample.json", "utf-8");
const data = JSON.parse(raw);

const graph = GraphLoader.loadFloorGraph(data);

console.log("=== Graph ===");
console.log(JSON.stringify(graph, null, 2));

const start = "A";
const end = "E";

const result = Pathfinder.shortestPathAStarHeap(graph.adjacencyList, graph.nodesById, start, end);

console.log("\n=== Shortest Path Result ===");
console.log(`Start: ${start}`);
console.log(`End: ${end}`);

if (result.nodePath.length === 0) {
  console.log("No path found.");
} else {
  console.log("Path:", result.nodePath.join(" -> "));
  console.log("Total Cost:", result.totalCost);
  console.log("Steps:", result.steps);
}