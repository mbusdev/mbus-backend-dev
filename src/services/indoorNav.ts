import { MongoClient, Collection } from "mongodb";
import { GraphLoader } from "../indoor/GraphLoader";
import { Pathfinder } from "../indoor/pathfinderAstar";
import { buildGraphLoadPlan } from "../indoor/buildGraphLoadPlan";
import { GraphMerger } from "../indoor/GraphMerger";
import { GraphRepository } from "../indoor/GraphRepository";
import { FloorGraphJson } from "../indoor/types";

const MONGO_URI = process.env.INDOOR_MONGO_URI ?? "mongodb://127.0.0.1:27017";
const DB_NAME = "indoor_navigation";
const COLLECTION_NAME = "floorGraphs";

let client: MongoClient | null = null;
let floorGraphsCollection: Collection<FloorGraphJson> | null = null;

async function getCollection(): Promise<Collection<FloorGraphJson>> {
    if (floorGraphsCollection) return floorGraphsCollection;

    client = new MongoClient(MONGO_URI);
    await client.connect();

    const db = client.db(DB_NAME);
    floorGraphsCollection = db.collection<FloorGraphJson>(COLLECTION_NAME);

    console.log("[IndoorNav] Mongo connected");
    return floorGraphsCollection;
}

/**
 * Fetch a single floor graph
 */
export async function getFloorGraph(buildingId: string, floor: number) {
    const collection = await getCollection();

    const data = await collection.findOne({
        buildingId,
        floor
    });

    if (!data) {
        throw new Error("graph not found");
    }

    return {
        buildingId: data.buildingId,
        floor: data.floor,
        nodes: data.nodes,
        edges: data.edges
    };
}

/**
 * Compute indoor route between two node IDs
 */
export async function computeIndoorRoute(startNodeId: string, endNodeId: string) {
    const collection = await getCollection();
    const graphRepo = new GraphRepository(collection);

    const plan = buildGraphLoadPlan(startNodeId, endNodeId);
    const floorDocs = await graphRepo.getFloorGraphs(plan.targets);

    if (floorDocs.length === 0) {
        throw new Error("No graph documents found for requested route scope");
    }

    const loadedGraphs = floorDocs.map(doc => GraphLoader.loadFloorGraph(doc));
    const combinedGraph = GraphMerger.mergeGraphs(loadedGraphs);

    if (!combinedGraph.nodesById[startNodeId]) {
        throw new Error(`Start node not found: ${startNodeId}`);
    }
    if (!combinedGraph.nodesById[endNodeId]) {
        throw new Error(`End node not found: ${endNodeId}`);
    }

    const result = Pathfinder.shortestPathAStarHeap(
        combinedGraph.adjacencyList,
        combinedGraph.nodesById,
        startNodeId,
        endNodeId
    );

    return {
        startNodeId,
        endNodeId,
        loadedTargets: plan.targets,
        nodePath: result.nodePath,
        steps: result.steps,
        totalCost: result.totalCost
    };
}