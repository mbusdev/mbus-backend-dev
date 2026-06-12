import { GraphLoader } from "../indoor/GraphLoader";
import { Pathfinder } from "../indoor/pathfinderAstar";
import { buildGraphLoadPlan } from "../indoor/buildGraphLoadPlan";
import { GraphMerger } from "../indoor/GraphMerger";
import { FloorGraphJson } from "../indoor/types";
import { getDb } from "../indoor/mongo";
import { getRedis } from "../indoor/redis";

async function getCollection() {
  const db = await getDb();
  return db.collection<FloorGraphJson>("floorGraphs");
}

/**
 * Fetch a single floor graph
 */
export async function getFloorGraph(buildingId: string, floor: number) {
    const redis = await getRedis();
    const cacheKey = `indoor:graph:${buildingId}:${floor}`;

    const cached = await redis.get(cacheKey);
    if (cached) {
        console.log(`[Redis] HIT ${cacheKey}`);
        return JSON.parse(cached);
    }
    console.log(`[Redis] MISS ${cacheKey}`);

    const collection = await getCollection();

    const data = await collection.findOne({
        buildingId,
        floor
    });

    if (!data) {
        throw new Error("graph not found");
    }

    const result = {
        buildingId: data.buildingId,
        floor: data.floor,
        nodes: data.nodes,
        edges: data.edges,
        verticalConnections: data.verticalConnections ?? []
    };

    await redis.set(cacheKey, JSON.stringify(result), {
        EX: 3600
    });

    return result;
}

/**
 * Compute indoor route between two node IDs
 */
export async function computeIndoorRoute(startNodeId: string, endNodeId: string) {
    const plan = buildGraphLoadPlan(startNodeId, endNodeId);
    const floorDocs = await Promise.all(
        plan.targets.map(target =>
            getFloorGraph(target.buildingId, target.floor)
        )
    );

    if (floorDocs.length === 0) {
        throw new Error("No graph documents found for requested route scope");
    }

    const loadedGraphs = floorDocs.map(doc => GraphLoader.loadFloorGraph(doc));

    const portalEdges = floorDocs.flatMap(doc => doc.verticalConnections ?? []);
    const combinedGraph = GraphMerger.mergeGraphs(loadedGraphs, portalEdges);

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