import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from "fs";
import { GraphMLNode, GraphMLEdge, LandmarkDef } from './types';
import { haversine, loadMap, MAP_FILE } from './loadMap';
import { MinPriorityQueue } from '@datastructures-js/priority-queue';
import { LRUCache } from 'lru-cache';

/**
 * Standard response for a single point-to-point walking query.
 */
export interface WalkingResponse {
    /** Walking duration in seconds. */
    duration: number;
    /** Walking distance in meters. */
    distance: number;
    /** Ordered list of coordinates representing the walking path geometry. */
    path_coords: { lat: number, lon: number }[];
}

/**
 * Result of a batch query from a single origin node to multiple destinations.
 */
export interface BatchWalkingResult {
    /** The ID of the street node closest to the origin coordinates. */
    nearestNodeId: string;
    /** The straight-line distance from the origin coordinates to the street node. */
    distanceToNode: number;
    /** A map of NodeID -> Distance (in meters) for all reachable nodes. */
    nodeDistances: Map<string, number>;
}

// Resolve assets relative to this module, not process.cwd(): the server must
// work no matter which directory it is launched from.
const ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets');
const CACHE_FILE = path.join(ASSETS_DIR, 'landmark_dist.json');
const WALKING_SPEED_M_S = 5000 / 3600;
const WALKING_CACHE_PATH = path.join(ASSETS_DIR, 'walkingCache.json');
const DEBUG = false;
const LANDMARK_DISTANCES = new Map<string, Map<string, number>>();
const LANDMARKS: LandmarkDef[] = [
    { name: "Hayward/Hubbard", lat: 42.295877, lon: -83.707688999999 },
    { name: "Crisler Center", lat: 42.264356, lon: -83.744353999999 },
    { name: "Dominos Farms", lat: 42.321140000001, lon: -83.682196000001 },
    { name: "Wall St Structure", lat: 42.288482999999, lon: -83.735965 },
    { name: "Plymouth Park-and-Ride", lat: 42.30597, lon: -83.68852 },
    { name: "Oxford Housing", lat: 42.274684999999, lon: -83.726024999999 }
];

let graphNodes: Map<string, GraphMLNode> = new Map();
let graphAdjacency: Map<string, GraphMLEdge[]> = new Map();
let stopNodeMap: Record<string, { nodeId: string, distToNode: number }> = {};
let relevantStopNodes = new Set<string>();

let walkingCache: { [key: string]: WalkingResponse } = {};

// Bounded by total retained MAP ENTRIES, not map count: a single Dijkstra
// result can cover ~99% of the ~52k-node street graph (~2.6 MB retained), so
// a count-only bound would permit multi-GB heap growth and an eventual OOM.
const networkDistanceCache = new LRUCache<string, Map<string, number>>({
    max: 500,
    maxSize: 2_000_000,
    sizeCalculation: (distances) => Math.max(1, distances.size),
});

/**
 * Finds the nearest street graph node to a given lat/lon.
 * @param nodes - The map of all graph nodes.
 * @param lat - Query latitude.
 * @param lon - Query longitude.
 * @returns Object containing the best Node ID and the distance to it.
 */
function nearestNode(nodes: Map<string, GraphMLNode>, lat: number, lon: number) {
    let bestId: string | null = null;
    let bestDist = Infinity;
    for (const [id, n] of nodes) {
        const d = haversine(lat, lon, n.lat, n.lon);
        if (d < bestDist) {
            bestDist = d;
            bestId = id;
        }
    }
    return { id: bestId, dist: bestDist };
}

/**
 * Reconstructs the path from the A* 'cameFrom' map.
 */
function reconstructPath(cameFrom: Map<string, string>, current: string) {
    const total = [current];
    while (cameFrom.has(current)) {
        current = cameFrom.get(current)!;
        total.push(current);
    }
    return total.reverse();
}

/** Min-heap over {id, f} entries, backed by the shared priority-queue dependency. */
function makeMinHeap() {
    return new MinPriorityQueue<{ id: string; f: number }>((item) => item.f);
}

/**
 * Runs Dijkstra's algorithm from a start node to finding a specific set of targets.
 * Optimized to early-exit once all targets in the optional set are found.
 * @param startId - The starting Node ID.
 * @param targets - (Optional) Set of Node IDs to stop searching after finding.
 * @returns Map of Node ID to walking distance in meters.
 */
function computeDijkstraAll(startId: string, targets?: Set<string>): Map<string, number> {
    const distances = new Map<string, number>();
    const minHeap = makeMinHeap();

    let targetsFound = 0;
    const totalTargets = targets ? targets.size : 0;

    distances.set(startId, 0);
    minHeap.enqueue({ id: startId, f: 0 });

    while (minHeap.size() > 0) {
        const { id: u, f: d } = minHeap.dequeue()!;
        if (d > (distances.get(u) ?? Infinity)) continue;
        if (targets && targets.has(u)) {
            targetsFound++;
            if (targetsFound >= totalTargets) {
                break;
            }
        }
        const neighbors = graphAdjacency.get(u) ?? [];
        for (const edge of neighbors) {
            const newDist = d + edge.dist;
            if (newDist < (distances.get(edge.to) ?? Infinity)) {
                distances.set(edge.to, newDist);
                minHeap.enqueue({ id: edge.to, f: newDist });
            }
        }
    }
    return distances;
}

/**
 * Performs A* search between two nodes using ALT (A*, Landmarks, Triangle Inequality) heuristic.
 * @param startId - Starting graph node ID.
 * @param goalId - Target graph node ID.
 * @returns Path details or null if no path exists.
 */
async function aStar(startId: string, goalId: string) {
    const openHeap = makeMinHeap();
    const gScore = new Map<string, number>();
    const fScore = new Map<string, number>();
    const cameFrom = new Map<string, string>();
    let explored = 0;

    gScore.set(startId, 0);
    const goalNode = graphNodes.get(goalId)!;

    const getHeuristic = (currId: string): number => {
        const hHaversine = haversine(
            graphNodes.get(currId)!.lat, graphNodes.get(currId)!.lon,
            goalNode.lat, goalNode.lon
        );
        let maxLandmarkDiff = 0;
        for (const [landmarkId, distMap] of LANDMARK_DISTANCES) {
            const dToNode = distMap.get(currId);
            const dToGoal = distMap.get(goalId);
            if (dToNode !== undefined && dToGoal !== undefined) {
                const diff = Math.abs(dToNode - dToGoal);
                if (diff > maxLandmarkDiff) maxLandmarkDiff = diff;
            }
        }
        return Math.max(hHaversine, maxLandmarkDiff);
    };

    const initialH = getHeuristic(startId);
    fScore.set(startId, initialH);
    openHeap.enqueue({ id: startId, f: initialH });

    while (openHeap.size() > 0) {
        explored++;
        const cur = openHeap.dequeue()!;
        const current = cur.id;

        // Stale heap entry: this node was re-pushed with a better score after
        // this entry was queued (the heap has no decrease-key).
        if (cur.f > (fScore.get(current) ?? Infinity)) continue;

        if (current === goalId) {
            const pathIds = reconstructPath(cameFrom, current);
            let totalDist = 0;
            for (let i = 1; i < pathIds.length; i++) {
                const from = pathIds[i - 1];
                const to = pathIds[i];
                const e = graphAdjacency.get(from)!.find(ed => ed.to === to);
                if (e) totalDist += e.dist;
            }
            return { pathIds, totalDist, explored };
        }

        const neighbors = graphAdjacency.get(current) ?? [];
        for (const edge of neighbors) {
            const tentative_g = (gScore.get(current) ?? Infinity) + edge.dist;
            if (tentative_g < (gScore.get(edge.to) ?? Infinity)) {
                cameFrom.set(edge.to, current);
                gScore.set(edge.to, tentative_g);

                const h = getHeuristic(edge.to);
                const f = tentative_g + h;

                fScore.set(edge.to, f);
                // Always re-push on improvement; stale entries are skipped on pop.
                openHeap.enqueue({ id: edge.to, f });
            }
        }
    }
    return null;
}

/**
 * Saves precomputed landmark distances to a JSON cache file.
 */
function saveLandmarkDistances(data: Map<string, Map<string, number>>) {
    const output: Record<string, Record<string, number>> = {};
    for (const [landmarkId, distances] of data) {
        const distObj: Record<string, number> = {};
        for (const [targetNode, dist] of distances) {
            distObj[targetNode] = Number(dist.toFixed(2));
        }
        output[landmarkId] = distObj;
    }
    // Temp-file + rename so a crash mid-write can never leave a truncated
    // cache that would fail to parse on the next boot.
    const tmpPath = `${CACHE_FILE}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(output));
    fs.renameSync(tmpPath, CACHE_FILE);
    console.log(`Saved cache to ${CACHE_FILE}`);
}

/**
 * Loads precomputed landmark distances from the JSON cache file.
 */
function loadLandmarkDistances() {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const json = JSON.parse(raw);
    for (const landmarkId in json) {
        const distObj = json[landmarkId];
        const distMap = new Map<string, number>();
        for (const targetNode in distObj) {
            distMap.set(targetNode, distObj[targetNode]);
        }
        LANDMARK_DISTANCES.set(landmarkId, distMap);
    }
    console.log(`Loaded distances for ${LANDMARK_DISTANCES.size} landmarks from cache`);
}

/**
 * Initializes the graph nodes and adjacency list.
 * Computes landmark distances if cache is missing.
 */
function initializeGraph() {
    const { nodes, graph } = loadMap();
    graphNodes = nodes;
    graphAdjacency = graph;
    console.log(`Graph initialized with ${graphNodes.size} nodes.`);

    // The landmark cache is only valid for the graph it was computed from: a
    // stale cache makes the ALT heuristic inadmissible (A* silently returns
    // non-shortest paths), so recompute whenever the map file is newer.
    // The tolerance absorbs checkout/copy jitter (a fresh git clone writes both
    // files within milliseconds of each other, in arbitrary order); a genuine
    // map update is newer by far more than this.
    const STALE_TOLERANCE_MS = 60_000;
    const landmarksFresh = fs.existsSync(CACHE_FILE)
        && fs.statSync(CACHE_FILE).mtimeMs >= fs.statSync(MAP_FILE).mtimeMs - STALE_TOLERANCE_MS;

    let landmarksLoaded = false;
    if (landmarksFresh) {
        console.log('--- Cache Found: Loading Precomputed Distances ---');
        // A corrupt cache must never prevent boot: fall through to recompute.
        try {
            loadLandmarkDistances();
            landmarksLoaded = true;
        } catch (err) {
            console.error('landmark_dist.json is corrupt — recomputing', err instanceof Error ? err.message : err);
        }
    }
    if (!landmarksLoaded) {
        console.log(fs.existsSync(CACHE_FILE)
            ? '--- Landmark cache is stale or corrupt: Recomputing ---'
            : '--- No Cache Found: Starting Computation ---');
        const t0 = performance.now();

        for (const lm of LANDMARKS) {
            const nearest = nearestNode(graphNodes, lm.lat, lm.lon);
            if (!nearest.id) continue;

            lm.nodeId = nearest.id;
            console.log(`Computing Dijkstra for landmark: ${lm.name} (${lm.nodeId})`);

            const distMap = computeDijkstraAll(lm.nodeId);
            LANDMARK_DISTANCES.set(lm.nodeId, distMap);
        }
        const t1 = performance.now();
        console.log(`Computation finished in ${(t1 - t0).toFixed(0)}ms`);
        saveLandmarkDistances(LANDMARK_DISTANCES);
    }
}

/**
 * Maps a list of bus stops to their nearest nodes on the street graph.
 * This optimizes future lookups by caching the StopID -> NodeID relationship.
 * @param locations - A map of StopID to {lat, lon}.
 */
let stopNodeMapSignature: string | null = null;

export function buildStopNodeMap(locations: Record<string, { lat: number, lon: number }>) {
    if (graphNodes.size === 0) initializeGraph();

    // The stop->node mapping is a pure function of (locations, static graph):
    // skip the O(stops x nodes) rebuild AND the Dijkstra cache wipe when the
    // stop set hasn't changed (initializeRoutes calls this every 60s).
    const signature = Object.keys(locations).sort()
        .map(id => `${id}:${locations[id].lat},${locations[id].lon}`).join(';');
    // Only short-circuit on a non-empty prior mapping: recomputing an empty
    // one is free, and this avoids preserving an empty map across an
    // in-process graph re-initialization.
    if (signature === stopNodeMapSignature && Object.keys(stopNodeMap).length > 0) return;
    stopNodeMapSignature = signature;

    stopNodeMap = {};
    relevantStopNodes.clear();
    // Cached Dijkstra results were computed with early exit against the old
    // target set and may lack distances for stops added by this rebuild.
    networkDistanceCache.clear();
    let mappedCount = 0;
    Object.entries(locations).forEach(([stopId, loc]) => {
        const nearest = nearestNode(graphNodes, loc.lat, loc.lon);
        if (nearest && nearest.id) {
            stopNodeMap[stopId] = {
                nodeId: nearest.id,
                distToNode: nearest.dist
            };
            relevantStopNodes.add(nearest.id);
            mappedCount++;
        }
    });
}

/**
 * Calculates a detailed walking path between two coordinates using A*.
 * Includes path geometry for rendering.
 * @param originLat - Latitude of origin.
 * @param originLon - Longitude of origin.
 * @param destLat - Latitude of destination.
 * @param destLon - Longitude of destination.
 */
export async function getWalkingResponse(originLat: number, originLon: number, destLat: number, destLon: number): Promise<WalkingResponse> {
    if (graphNodes.size === 0) {
        console.warn("Graph not loaded. Calling initializeGraph() now.");
        initializeGraph();
    }

    const nearestStart = nearestNode(graphNodes, originLat, originLon);
    const nearestGoal = nearestNode(graphNodes, destLat, destLon);

    if (!nearestStart.id || !nearestGoal.id) {
        throw new Error('No nearest graph nodes found for one or both coordinates.');
    }

    const result = await aStar(nearestStart.id, nearestGoal.id);

    let pathCoords: { lat: number, lon: number }[] = [];
    let meters: number;
    let seconds: number;

    if (!result) {
        // Fallback if no path found
        const directDist = haversine(originLat, originLon, destLat, destLon);
        meters = directDist;
        seconds = meters / WALKING_SPEED_M_S;
        console.warn(`A* failed for path. Falling back to direct Haversine distance.`);
        pathCoords = [{ lat: originLat, lon: originLon }, { lat: destLat, lon: destLon }];
    } else {
        meters = result.totalDist + nearestStart.dist + nearestGoal.dist;
        seconds = meters / WALKING_SPEED_M_S;

        if (DEBUG) {
            console.log(`Path found: ${meters.toFixed(2)}m. Explored ${result.explored} nodes.`);
        }

        pathCoords.push({ lat: originLat, lon: originLon });

        if (result.pathIds.length > 0) {
            // Add start node
            const startNode = graphNodes.get(result.pathIds[0])!;
            pathCoords.push({ lat: startNode.lat, lon: startNode.lon });

            for (let i = 0; i < result.pathIds.length - 1; i++) {
                const currId = result.pathIds[i];
                const nextId = result.pathIds[i + 1];

                // find edge used to get to nextId
                const edge = graphAdjacency.get(currId)?.find(e => e.to === nextId);

                if (edge && edge.geometry && edge.geometry.length > 0) {
                    for (let k = 1; k < edge.geometry.length; k++) {
                        pathCoords.push(edge.geometry[k]);
                    }
                } else {
                    // draw line to next node
                    const nextNode = graphNodes.get(nextId)!;
                    pathCoords.push({ lat: nextNode.lat, lon: nextNode.lon });
                }
            }
        }

        pathCoords.push({ lat: destLat, lon: destLon });
    }

    return {
        distance: meters,
        duration: seconds,
        path_coords: pathCoords,
    };
}

/**
 * Optimized method to get walking distances from an origin to ALL known bus stops.
 * Optionally includes a direct walk to a specific destination point.
 * Uses a single Dijkstra pass with early termination and LRU Cache.
 * @param lat - Origin latitude.
 * @param lon - Origin longitude.
 * @param destLat - (Optional) Destination latitude for direct walk.
 * @param destLon - (Optional) Destination longitude for direct walk.
 */
export function getWalkingDistancesFrom(
    lat: number, lon: number,
    destLat?: number, destLon?: number
): { stopId: string, duration: number }[] {

    if (graphNodes.size === 0) initializeGraph();

    const nearest = nearestNode(graphNodes, lat, lon);
    if (!nearest.id) throw new Error("No graph node found near origin");

    let destNodeId: string | undefined;
    let destNodeDist = 0;
    
    // Resolve destination node if provided
    if (destLat !== undefined && destLon !== undefined) {
        const dNode = nearestNode(graphNodes, destLat, destLon);
        if (dNode.id) {
            destNodeId = dNode.id;
            destNodeDist = dNode.dist;
        }
    }

    // 2. Create the Cache Key using IDs
    const cacheKey = `${nearest.id}::${destNodeId || ''}`; 

    let nodeDistances = networkDistanceCache.get(cacheKey); 

    if (!nodeDistances) {
        
        let addedToSet = false;
        if (destNodeId && !relevantStopNodes.has(destNodeId)) {
            relevantStopNodes.add(destNodeId);
            addedToSet = true;
        }

        // Run Dijkstra
        nodeDistances = computeDijkstraAll(nearest.id, relevantStopNodes);

        // Cleanup set
        if (addedToSet && destNodeId) {
            relevantStopNodes.delete(destNodeId);
        }

        networkDistanceCache.set(cacheKey, nodeDistances);
    }

    const results: { stopId: string, duration: number }[] = [];

    // Process Bus Stops
    for (const [stopId, mapData] of Object.entries(stopNodeMap)) {
        const distOnStreet = nodeDistances.get(mapData.nodeId);
        
        if (distOnStreet !== undefined) {
            // (User->StartNode) + (StartNode->EndNode [CACHED]) + (EndNode->BusStop)
            const totalDist = nearest.dist + distOnStreet + mapData.distToNode;
            results.push({
                stopId,
                duration: Math.ceil(totalDist / WALKING_SPEED_M_S)
            });
        }
    }

    if (destNodeId) {
        const distOnStreet = nodeDistances.get(destNodeId);
        if (distOnStreet !== undefined) {
            const totalDist = nearest.dist + distOnStreet + destNodeDist;
            results.push({
                stopId: "DIRECT_WALK",
                duration: Math.ceil(totalDist / WALKING_SPEED_M_S)
            });
        }
    }
    return results;
}

/**
 * Ensures walking paths between all provided stops are calculated and cached.
 * Fetches missing paths in parallel and updates the disk cache.
 * @param stopIds - Set of stop IDs to verify.
 * @param stopLocations - Map of Stop ID to coordinates.
 */
export async function ensureCacheForStops(
    stopIds: Set<string>,
    stopLocations: Record<string, { lat: number, lon: number }>
): Promise<void> {
    console.log(`Verifying cache for ${stopIds.size} stops...`);

    const missing: Array<{ cacheKey: string, loc1: { lat: number, lon: number }, loc2: { lat: number, lon: number } }> = [];
    for (const id1 of stopIds) {
        for (const id2 of stopIds) {
            if (id1 === id2) continue;
            const cacheKey = `${id1}_TO_${id2}`;
            if (walkingCache[cacheKey]) continue;
            const loc1 = stopLocations[id1];
            const loc2 = stopLocations[id2];
            if (loc1 && loc2) missing.push({ cacheKey, loc1, loc2 });
        }
    }

    if (missing.length === 0) return;
    console.log(`Computing ${missing.length} new paths...`);

    let computed = 0;
    for (let i = 0; i < missing.length; i++) {
        const { cacheKey, loc1, loc2 } = missing[i];
        try {
            walkingCache[cacheKey] = await getWalkingResponse(loc1.lat, loc1.lon, loc2.lat, loc2.lon);
            computed++;
        } catch (err) {
            // Leave the pair uncached so it is retried on the next cycle; a
            // poisoned sentinel would otherwise be persisted forever.
            console.warn(`WalkingManager: failed to compute ${cacheKey}, will retry later`);
        }
        // The path searches are pure CPU: yield to the event loop regularly so
        // HTTP requests and interval jobs are not starved for minutes when the
        // cache is cold.
        if ((i + 1) % 20 === 0) await new Promise(resolve => setImmediate(resolve));
    }

    if (computed > 0) await persistWalkingCache();
}

async function persistWalkingCache(): Promise<void> {
    // Never write from tests: a plain `npm test` must not dirty the tracked
    // cache file.
    if (process.env.VITEST === 'true') return;
    try {
        // Compact JSON (the file is hundreds of MB) written to a temp file and
        // renamed, so a crash mid-write can never leave a truncated cache that
        // would fail to parse on the next boot.
        const tmpPath = `${WALKING_CACHE_PATH}.tmp`;
        await fs.promises.writeFile(tmpPath, JSON.stringify(walkingCache));
        await fs.promises.rename(tmpPath, WALKING_CACHE_PATH);
        console.log(`WalkingManager: cache persisted (${Object.keys(walkingCache).length} entries)`);
    } catch (err) {
        console.error("WalkingManager: failed to write cache to disk", err);
    }
}

/**
 * Retrieves a cached walking path between two stops.
 * @param originId - Origin Stop ID.
 * @param destId - Destination Stop ID.
 * @returns Cached walking data or undefined.
 */
export function getCachedWalk(originId: string, destId: string): WalkingResponse | undefined {
    return walkingCache[`${originId}_TO_${destId}`] ?? null;
}

initializeGraph();
if (existsSync(WALKING_CACHE_PATH)) {
    // A corrupt cache must never prevent boot (this runs at module import);
    // fall back to an empty cache and let it rebuild.
    try {
        const file = readFileSync(WALKING_CACHE_PATH, "utf8");
        const loaded: Record<string, WalkingResponse> = JSON.parse(file);
        // Drop entries poisoned by the old error sentinel or otherwise invalid so
        // they get recomputed instead of routing around a 16-hour "walk".
        let dropped = 0;
        for (const [key, value] of Object.entries(loaded)) {
            if (!Number.isFinite(value?.duration) || value.duration >= 60000) {
                dropped++;
                continue;
            }
            walkingCache[key] = value;
        }
        console.log(`Loaded walkingCache.json${dropped > 0 ? ` (dropped ${dropped} invalid entries)` : ''}`);
    } catch (err) {
        console.error("walkingCache.json is corrupt — starting with an empty cache and rebuilding", err instanceof Error ? err.message : err);
    }
} else {
    console.log("walkingCache.json does not exist — using empty cache");
}