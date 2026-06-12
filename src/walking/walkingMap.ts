import fs from 'fs';
import path from 'path';
import { writeFileSync, readFileSync, existsSync } from "fs";
import { GraphMLNode, GraphMLEdge, LandmarkDef } from './types';
import { haversine, loadMap } from './loadMap';
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

const CACHE_FILE = path.resolve(process.cwd(), 'src/assets/landmark_dist.json');
const WALKING_SPEED_M_S = 5000 / 3600;
const WALKING_CACHE_PATH = "src/assets/walkingCache.json";
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

const networkDistanceCache = new LRUCache<string, Map<string, number>>({
    max: 5000,
});

const polylineCache = new LRUCache<string, WalkingResponse>({
    max: 1000,
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

/**
 * Minimal MinHeap implementation for priority queueing in A* and Dijkstra.
 */
class MinHeap {
    private arr: { id: string; f: number }[] = [];
    push(item: { id: string; f: number }) { this.arr.push(item); this._siftUp(); }
    pop() { if (this.arr.length === 0) return null; const top = this.arr[0]; const last = this.arr.pop()!; if (this.arr.length) { this.arr[0] = last; this._siftDown(); } return top; }
    size() { return this.arr.length; }
    private _siftUp() { let i = this.arr.length - 1; while (i > 0) { const p = Math.floor((i - 1) / 2); if (this.arr[i].f >= this.arr[p].f) break;[this.arr[i], this.arr[p]] = [this.arr[p], this.arr[i]]; i = p; } }
    private _siftDown() { let i = 0; const n = this.arr.length; while (true) { const l = 2 * i + 1; const r = 2 * i + 2; let smallest = i; if (l < n && this.arr[l].f < this.arr[smallest].f) smallest = l; if (r < n && this.arr[r].f < this.arr[smallest].f) smallest = r; if (smallest === i) break;[this.arr[i], this.arr[smallest]] = [this.arr[smallest], this.arr[i]]; i = smallest; } }
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
    const minHeap = new MinHeap();

    let targetsFound = 0;
    const totalTargets = targets ? targets.size : 0;

    distances.set(startId, 0);
    minHeap.push({ id: startId, f: 0 });

    while (minHeap.size() > 0) {
        const { id: u, f: d } = minHeap.pop()!;
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
                minHeap.push({ id: edge.to, f: newDist });
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
    const openHeap = new MinHeap();
    const gScore = new Map<string, number>();
    const fScore = new Map<string, number>();
    const inOpen = new Set<string>();
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
    openHeap.push({ id: startId, f: initialH });
    inOpen.add(startId);

    while (openHeap.size() > 0) {
        explored++;
        const cur = openHeap.pop()!;
        const current = cur.id;

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

        inOpen.delete(current);
        const neighbors = graphAdjacency.get(current) ?? [];
        for (const edge of neighbors) {
            const tentative_g = (gScore.get(current) ?? Infinity) + edge.dist;
            if (tentative_g < (gScore.get(edge.to) ?? Infinity)) {
                cameFrom.set(edge.to, current);
                gScore.set(edge.to, tentative_g);

                const h = getHeuristic(edge.to);
                const f = tentative_g + h;

                fScore.set(edge.to, f);
                if (!inOpen.has(edge.to)) {
                    openHeap.push({ id: edge.to, f });
                    inOpen.add(edge.to);
                }
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
    fs.writeFileSync(CACHE_FILE, JSON.stringify(output));
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

    if (fs.existsSync(CACHE_FILE)) {
        console.log('--- Cache Found: Loading Precomputed Distances ---');
        loadLandmarkDistances();
    } else {
        console.log('--- No Cache Found: Starting Computation ---');
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
export function buildStopNodeMap(locations: Record<string, { lat: number, lon: number }>) {
    if (graphNodes.size === 0) initializeGraph();

    stopNodeMap = {};
    relevantStopNodes.clear();
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
    const cacheKey = `${originLat},${originLon}_TO_${destLat},${destLon}`;
    const cachedResponse = polylineCache.get(cacheKey);
    
    if (cachedResponse) {
        return cachedResponse;
    }

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

    const finalResponse = {
        distance: meters,
        duration: seconds,
        path_coords: pathCoords,
    };

    polylineCache.set(cacheKey, finalResponse);

    return finalResponse;
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
let lastVerifiedStopCount = 0;

export async function ensureCacheForStops(
    stopIds: Set<string>,
    stopLocations: Record<string, { lat: number, lon: number }>
): Promise<void> {
    const totalStops = stopIds.size;

    // 1. Runtime Fast-Path: If we already verified this exact number of stops this session, instantly exit.
    if (totalStops === lastVerifiedStopCount) return;

    // 2. Boot Fast-Path: If the JSON file already has all the required pairs, instantly exit.
    // (Total stops * (Total stops - 1) gives us the exact number of expected A -> B pairs)
    const expectedPairs = totalStops * (totalStops - 1);
    const currentCacheSize = Object.keys(walkingCache).length;

    if (currentCacheSize >= expectedPairs) {
        lastVerifiedStopCount = totalStops;
        return; 
    }

    // --- If we reach here, we actually need to do work ---

    if (graphNodes.size === 0) initializeGraph();
    buildStopNodeMap(stopLocations);

    let cacheWasUpdated = false;
    const stopArray = Array.from(stopIds);
    const totalPairs = totalStops * totalStops;
    let processedPairs = 0;

    // Now this ONLY prints if it actually has to calculate missing stops
    console.log(`Building cache for missing stops using Single-Source Dijkstra...`);

    for (const id1 of stopArray) {
        const startData = stopNodeMap[id1];
        if (!startData) {
            processedPairs += totalStops;
            continue;
        }

        let missingCache = false;
        for (const id2 of stopArray) {
            if (id1 !== id2 && !walkingCache[`${id1}_TO_${id2}`]) {
                missingCache = true;
                break;
            }
        }

        if (!missingCache) {
            processedPairs += totalStops;
            if (processedPairs === totalPairs) {
                process.stdout.write(`\rBuilding cache keys: ${processedPairs} / ${totalPairs} (100.0%)`);
            }
            continue;
        }

        const distancesFromStart = computeDijkstraAll(startData.nodeId);

        for (const id2 of stopArray) {
            processedPairs++;
            if (processedPairs % 1000 === 0 || processedPairs === totalPairs) {
                const percent = ((processedPairs / totalPairs) * 100).toFixed(1);
                process.stdout.write(`\rBuilding cache keys: ${processedPairs} / ${totalPairs} (${percent}%)`);
            }

            if (id1 === id2) continue;

            const cacheKey = `${id1}_TO_${id2}`;

            if (!walkingCache[cacheKey]) {
                const endData = stopNodeMap[id2];

                if (endData && distancesFromStart) {
                    cacheWasUpdated = true;
                    const distOnStreet = distancesFromStart.get(endData.nodeId);

                    if (distOnStreet !== undefined) {
                        const totalDist = startData.distToNode + distOnStreet + endData.distToNode;
                        walkingCache[cacheKey] = {
                            distance: totalDist,
                            duration: Math.ceil(totalDist / WALKING_SPEED_M_S),
                            path_coords: []
                        };
                    } else {
                        walkingCache[cacheKey] = { duration: 60000, distance: 0, path_coords: [] };
                    }
                }
            }
        }
    }

    process.stdout.write('\n');

    if (cacheWasUpdated) {
        try {
            writeFileSync(WALKING_CACHE_PATH, JSON.stringify(walkingCache, null, 2));
            console.log(`WalkingManager: Cache updated on disk. Total entries: ${Object.keys(walkingCache).length}`);
        } catch (err) {
            console.error("WalkingManager: Failed to write cache to disk", err);
        }
    }

    lastVerifiedStopCount = totalStops;
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

/**
 * Retrieves a cached polyline response directly from the LRU memory cache.
 * @param originLat - Latitude of origin.
 * @param originLon - Longitude of origin.
 * @param destLat - Latitude of destination.
 * @param destLon - Longitude of destination.
 * @returns Cached walking data or undefined if not cached.
 */
export function getCachedPolyline(originLat: number, originLon: number, destLat: number, destLon: number): WalkingResponse | undefined {
    const cacheKey = `${originLat},${originLon}_TO_${destLat},${destLon}`;
    return polylineCache.get(cacheKey);
}

initializeGraph();
if (existsSync(WALKING_CACHE_PATH)) {
    const file = readFileSync(WALKING_CACHE_PATH, "utf8");
    Object.assign(walkingCache, JSON.parse(file));
    console.log("Loaded walkingCache.json");
} else {
    console.log("walkingCache.json does not exist — using empty cache");
}