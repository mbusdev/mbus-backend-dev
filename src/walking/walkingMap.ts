import crypto from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { GraphMLNode, GraphMLEdge } from './types';
import { TransfersByOrigin } from '../raptor/types';
import { haversine, loadMap } from './loadMap';
import { LRUCache } from 'lru-cache';
import * as chRouter from './contractionHierarchy';
import {
    StopWalkMeters,
    transitiveReductionShortcuts,
    shortcutsToTransfers,
    countStopWalkEdges,
} from './walkingShortcuts';

/**
 * Standard response for a single point-to-point walking query.
 */
export interface WalkingResponse {
    duration: number;
    distance: number;
    path_coords: { lat: number, lon: number }[];
}

const WALKING_SPEED_M_S = 5000 / 3600;
const SHORTCUTS_CACHE_PATH = "src/assets/walking-shortcuts.json";
/** Placeholder duration for stop pairs with no street route (legacy walkingCache behavior). */
const UNREACHABLE_WALK_SECONDS = 60000;
const USE_DIJKSTRA = process.env.WALKING_USE_DIJKSTRA === 'true';

let graphNodes: Map<string, GraphMLNode> = new Map();
let graphAdjacency: Map<string, GraphMLEdge[]> = new Map();
let stopNodeMap: Record<string, { nodeId: string, distToNode: number }> = {};
let relevantStopNodes = new Set<string>();
let useChRouting = false;

const networkDistanceCache = new LRUCache<string, Map<string, number>>({
    max: 5000,
});

/** Cached street path between two graph nodes (snap coords applied per request). */
interface NodePolylineCacheEntry {
    streetMeters: number;
    nodeIds: string[];
    /** No street route between these nodes — use haversine on request coordinates. */
    unreachable?: boolean;
}

const polylineCache = new LRUCache<string, NodePolylineCacheEntry>({
    max: 5000,
});

function nodePolylineCacheKey(startId: string, goalId: string): string {
    return `${startId}::${goalId}`;
}

function buildWalkingResponseFromNodePath(
    entry: NodePolylineCacheEntry,
    nearestStart: { id: string; dist: number },
    nearestGoal: { id: string; dist: number },
    originLat: number,
    originLon: number,
    destLat: number,
    destLon: number
): WalkingResponse {
    if (entry.unreachable) {
        const meters = haversine(originLat, originLon, destLat, destLon);
        return {
            distance: meters,
            duration: meters / WALKING_SPEED_M_S,
            path_coords: [{ lat: originLat, lon: originLon }, { lat: destLat, lon: destLon }],
        };
    }

    const meters = entry.streetMeters + nearestStart.dist + nearestGoal.dist;
    const pathCoords = chRouter.stitchPathCoords(
        entry.nodeIds, graphNodes, graphAdjacency,
        originLat, originLon, destLat, destLon
    );
    return {
        distance: meters,
        duration: meters / WALKING_SPEED_M_S,
        path_coords: pathCoords,
    };
}

function resolveNodePolylinePath(
    startId: string,
    goalId: string
): NodePolylineCacheEntry {
    const cacheKey = nodePolylineCacheKey(startId, goalId);
    const cached = polylineCache.get(cacheKey);
    if (cached) return cached;

    let entry: NodePolylineCacheEntry;

    const chPath = useChRouting ? chRouter.queryPath(startId, goalId) : null;
    if (chPath) {
        entry = { streetMeters: chPath.distance, nodeIds: chPath.nodeIds };
    } else {
        const distOnStreet = queryNetworkDistance(startId, goalId);
        if (distOnStreet === undefined) {
            entry = { streetMeters: 0, nodeIds: [], unreachable: true };
        } else if (startId === goalId) {
            entry = { streetMeters: 0, nodeIds: [startId] };
        } else {
            entry = { streetMeters: distOnStreet, nodeIds: [startId, goalId] };
        }
    }

    polylineCache.set(cacheKey, entry);
    return entry;
}

function nearestNode(nodes: Map<string, GraphMLNode>, lat: number, lon: number) {
    return chRouter.nearestGraphNode(nodes, lat, lon) ?? { id: null as unknown as string, dist: Infinity };
}

class MinHeap {
    private arr: { id: string; f: number }[] = [];
    push(item: { id: string; f: number }) { this.arr.push(item); this._siftUp(); }
    pop() { if (this.arr.length === 0) return null; const top = this.arr[0]; const last = this.arr.pop()!; if (this.arr.length) { this.arr[0] = last; this._siftDown(); } return top; }
    size() { return this.arr.length; }
    private _siftUp() { let i = this.arr.length - 1; while (i > 0) { const p = Math.floor((i - 1) / 2); if (this.arr[i].f >= this.arr[p].f) break;[this.arr[i], this.arr[p]] = [this.arr[p], this.arr[i]]; i = p; } }
    private _siftDown() { let i = 0; const n = this.arr.length; while (true) { const l = 2 * i + 1; const r = 2 * i + 2; let smallest = i; if (l < n && this.arr[l].f < this.arr[smallest].f) smallest = l; if (r < n && this.arr[r].f < this.arr[smallest].f) smallest = r; if (smallest === i) break;[this.arr[i], this.arr[smallest]] = [this.arr[smallest], this.arr[i]]; i = smallest; } }
}

/** Legacy full-graph Dijkstra (WALKING_USE_DIJKSTRA=true or CH missing). */
function computeDijkstraAll(startId: string, targets?: Set<string>): Map<string, number> {
    const distances = new Map<string, number>();
    const minHeap = new MinHeap();
    let targetsFound = 0;
    const totalTargets = targets ? targets.size : 0;

    distances.set(startId, 0);
    minHeap.push({ id: startId, f: 0 });

    while (minHeap.size() > 0) {
        const popped = minHeap.pop()!;
        const { id: u, f: d } = popped;
        if (d > (distances.get(u) ?? Infinity)) continue;
        if (targets && targets.has(u)) {
            targetsFound++;
            if (targetsFound >= totalTargets) break;
        }
        for (const edge of graphAdjacency.get(u) ?? []) {
            const newDist = d + edge.dist;
            if (newDist < (distances.get(edge.to) ?? Infinity)) {
                distances.set(edge.to, newDist);
                minHeap.push({ id: edge.to, f: newDist });
            }
        }
    }
    return distances;
}

function queryNetworkDistance(startId: string, endId: string): number | undefined {
    if (useChRouting && chRouter.isChLoaded()) {
        return chRouter.queryDistance(startId, endId) ?? undefined;
    }
    const dists = computeDijkstraAll(startId, new Set([endId]));
    return dists.get(endId);
}

function batchDistancesFromOrigin(originId: string, targetNodeIds: Iterable<string>): Map<string, number> {
    const targets = new Set(targetNodeIds);
    if (useChRouting && chRouter.isChLoaded()) {
        const phast = chRouter.queryDistancesFromOrigin(originId, targets);
        if (phast && phast.size > 0) return phast;
    }
    return computeDijkstraAll(originId, targets);
}

function initializeGraph() {
    const { nodes, graph } = loadMap();
    graphNodes = nodes;
    graphAdjacency = graph;
    chRouter.buildNearestNodeIndex(nodes);
    console.log(`Graph initialized with ${graphNodes.size} nodes.`);

    useChRouting = false;
    if (!USE_DIJKSTRA && existsSync(chRouter.getChFilePath())) {
        try {
            chRouter.loadContractionHierarchy();
            useChRouting = true;
            console.log('Walking routing: contraction hierarchy');
        } catch (e) {
            console.warn('CH load failed, falling back to Dijkstra:', e);
        }
    } else if (USE_DIJKSTRA) {
        console.log('Walking routing: Dijkstra (WALKING_USE_DIJKSTRA=true)');
    } else {
        console.warn(
            'Walking routing: Dijkstra (no CH file). Run npm run build:walking-ch to generate src/assets/ann_arbor.ch.json'
        );
    }
}

export function buildStopNodeMap(locations: Record<string, { lat: number, lon: number }>) {
    if (graphNodes.size === 0) initializeGraph();

    stopNodeMap = {};
    relevantStopNodes.clear();
    Object.entries(locations).forEach(([stopId, loc]) => {
        const nearest = nearestNode(graphNodes, loc.lat, loc.lon);
        if (nearest?.id) {
            stopNodeMap[stopId] = { nodeId: nearest.id, distToNode: nearest.dist };
            relevantStopNodes.add(nearest.id);
        }
    });
}

export async function getWalkingResponse(
    originLat: number, originLon: number, destLat: number, destLon: number
): Promise<WalkingResponse> {
    if (graphNodes.size === 0) initializeGraph();

    const nearestStart = nearestNode(graphNodes, originLat, originLon);
    const nearestGoal = nearestNode(graphNodes, destLat, destLon);

    if (!nearestStart.id || !nearestGoal.id) {
        throw new Error('No nearest graph nodes found for one or both coordinates.');
    }

    const entry = resolveNodePolylinePath(nearestStart.id, nearestGoal.id);
    return buildWalkingResponseFromNodePath(
        entry, nearestStart, nearestGoal,
        originLat, originLon, destLat, destLon
    );
}

export function getWalkingDistancesFrom(
    lat: number, lon: number,
    destLat?: number, destLon?: number
): { stopId: string, duration: number }[] {

    if (graphNodes.size === 0) initializeGraph();

    const nearest = nearestNode(graphNodes, lat, lon);
    if (!nearest.id) throw new Error("No graph node found near origin");

    let destNodeId: string | undefined;
    let destNodeDist = 0;

    if (destLat !== undefined && destLon !== undefined) {
        const dNode = nearestNode(graphNodes, destLat, destLon);
        if (dNode.id) {
            destNodeId = dNode.id;
            destNodeDist = dNode.dist;
        }
    }

    const cacheKey = `${nearest.id}::${destNodeId || ''}`;
    let nodeDistances = networkDistanceCache.get(cacheKey);

    if (!nodeDistances) {
        const targetIds = new Set(relevantStopNodes);
        if (destNodeId) targetIds.add(destNodeId);
        nodeDistances = batchDistancesFromOrigin(nearest.id, targetIds);
        networkDistanceCache.set(cacheKey, nodeDistances);
    }

    const results: { stopId: string, duration: number }[] = [];

    for (const [stopId, mapData] of Object.entries(stopNodeMap)) {
        const distOnStreet = nodeDistances.get(mapData.nodeId);
        if (distOnStreet !== undefined) {
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

function buildStopToStopWalkMatrix(stopIds: string[]): StopWalkMeters {
    if (graphNodes.size === 0) initializeGraph();

    const targetNodeIds = new Set<string>();
    for (const stopId of stopIds) {
        const nodeId = stopNodeMap[stopId]?.nodeId;
        if (nodeId) targetNodeIds.add(nodeId);
    }

    const matrix: StopWalkMeters = new Map();
    const total = stopIds.length;

    console.log(`Computing stop-to-stop walk matrix (${total} PHAST/Dijkstra origins)...`);

    for (let i = 0; i < stopIds.length; i++) {
        const originId = stopIds[i];
        const startData = stopNodeMap[originId];
        if (!startData) continue;

        if (i % 10 === 0 || i === total - 1) {
            const pct = ((i + 1) / total * 100).toFixed(1);
            process.stdout.write(`\r  Walk matrix: ${i + 1} / ${total} (${pct}%)`);
        }

        const nodeDists = batchDistancesFromOrigin(startData.nodeId, targetNodeIds);
        const outgoing = new Map<string, number>();

        for (const destId of stopIds) {
            if (destId === originId) continue;
            const endData = stopNodeMap[destId];
            if (!endData) continue;
            const distOnStreet = nodeDists.get(endData.nodeId);
            if (distOnStreet === undefined) continue;
            const totalMeters = startData.distToNode + distOnStreet + endData.distToNode;
            outgoing.set(destId, totalMeters);
        }

        if (outgoing.size > 0) matrix.set(originId, outgoing);
    }

    process.stdout.write('\n');
    return matrix;
}

interface SparseWalkingTransferResult {
    transfers: TransfersByOrigin;
    fullEdgeCount: number;
    shortcutEdgeCount: number;
}

/** Process-lifetime cache — avoids re-reading/parsing ~180MB JSON on every initializeRoutes tick. */
let inMemoryShortcuts: { stopIds: string[]; result: SparseWalkingTransferResult } | null = null;

function sortedStopIds(stopIds: string[]): string[] {
    return [...stopIds].sort();
}

function stopSetHash(stopIds: string[]): string {
    return crypto.createHash('sha256').update(sortedStopIds(stopIds).join(',')).digest('hex').slice(0, 16);
}

function stopSetsEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function isStopSuperset(superset: string[], subset: string[]): boolean {
    const set = new Set(superset);
    return subset.every(s => set.has(s));
}

function addedStopIds(cached: string[], current: string[]): string[] {
    const set = new Set(cached);
    return current.filter(s => !set.has(s));
}

function inferStopIdsFromTransfers(transfers: TransfersByOrigin): string[] {
    const ids = new Set<string>();
    for (const [origin, list] of Object.entries(transfers)) {
        ids.add(origin);
        for (const t of list) ids.add(t.destination);
    }
    return sortedStopIds([...ids]);
}

function metersToWalkDuration(meters: number): number {
    return Math.ceil(meters / WALKING_SPEED_M_S);
}

function countTransferEdges(transfers: TransfersByOrigin): number {
    let n = 0;
    for (const list of Object.values(transfers)) {
        if (list) n += list.length;
    }
    return n;
}

function appendWalkTransfer(
    transfers: TransfersByOrigin,
    origin: string,
    dest: string,
    meters: number
): void {
    if (!transfers[origin]) transfers[origin] = [];
    transfers[origin].push({
        origin,
        destination: dest,
        duration: metersToWalkDuration(meters),
        startTime: 0,
        endTime: Number.MAX_SAFE_INTEGER,
    });
}

function hasTransferTo(transfers: TransfersByOrigin, origin: string, dest: string): boolean {
    return transfers[origin]?.some(t => t.destination === dest) ?? false;
}

function appendUnreachableTransfer(transfers: TransfersByOrigin, origin: string, dest: string): void {
    if (!transfers[origin]) transfers[origin] = [];
    transfers[origin].push({
        origin,
        destination: dest,
        duration: UNREACHABLE_WALK_SECONDS,
        startTime: 0,
        endTime: Number.MAX_SAFE_INTEGER,
    });
}

/** Add 60000s transfers for every stop pair lacking a street route (matches old walkingCache.json). */
function fillUnreachableTransfers(transfers: TransfersByOrigin, stopIds: string[]): number {
    let added = 0;
    for (const originId of stopIds) {
        const startData = stopNodeMap[originId];
        if (!startData) continue;
        if (!transfers[originId]) transfers[originId] = [];

        for (const destId of stopIds) {
            if (originId === destId) continue;
            if (!stopNodeMap[destId]) continue;
            if (hasTransferTo(transfers, originId, destId)) continue;
            appendUnreachableTransfer(transfers, originId, destId);
            added++;
        }
    }
    return added;
}

function finalizeTransferGraph(transfers: TransfersByOrigin, stopIds: string[]): number {
    fillUnreachableTransfers(transfers, stopIds);
    for (const stopId of stopIds) {
        if (!transfers[stopId]) transfers[stopId] = [];
    }
    return countTransferEdges(transfers);
}

/**
 * Add walking edges for newly seen stops only (PHAST rows for new origins, CH pairs existing→new).
 * Preserves all direct shortest walks — no quality loss vs a full matrix rebuild.
 */
function extendWalkingTransfers(
    transfers: TransfersByOrigin,
    allStopIds: string[],
    newStopIds: string[]
): number {
    if (graphNodes.size === 0) initializeGraph();

    const newStopSet = new Set(newStopIds);
    const targetNodeIds = new Set<string>();
    for (const stopId of allStopIds) {
        const nodeId = stopNodeMap[stopId]?.nodeId;
        if (nodeId) targetNodeIds.add(nodeId);
    }

    let newEdges = 0;

    for (const originId of newStopIds) {
        if (!transfers[originId]) transfers[originId] = [];
        const startData = stopNodeMap[originId];
        if (!startData) continue;

        const nodeDists = batchDistancesFromOrigin(startData.nodeId, targetNodeIds);
        for (const destId of allStopIds) {
            if (destId === originId) continue;
            const endData = stopNodeMap[destId];
            if (!endData) continue;
            const distOnStreet = nodeDists.get(endData.nodeId);
            if (distOnStreet === undefined) {
                if (!hasTransferTo(transfers, originId, destId)) {
                    appendUnreachableTransfer(transfers, originId, destId);
                    newEdges++;
                }
                continue;
            }
            appendWalkTransfer(
                transfers, originId, destId,
                startData.distToNode + distOnStreet + endData.distToNode
            );
            newEdges++;
        }
    }

    for (const originId of allStopIds) {
        if (newStopSet.has(originId)) continue;
        const startData = stopNodeMap[originId];
        if (!startData) continue;
        if (!transfers[originId]) transfers[originId] = [];

        for (const destId of newStopIds) {
            if (destId === originId) continue;
            const endData = stopNodeMap[destId];
            if (!endData) continue;
            const distOnStreet = queryNetworkDistance(startData.nodeId, endData.nodeId);
            if (distOnStreet === undefined) {
                if (!hasTransferTo(transfers, originId, destId)) {
                    appendUnreachableTransfer(transfers, originId, destId);
                    newEdges++;
                }
                continue;
            }
            appendWalkTransfer(
                transfers, originId, destId,
                startData.distToNode + distOnStreet + endData.distToNode
            );
            newEdges++;
        }
    }

    for (const stopId of allStopIds) {
        if (!transfers[stopId]) transfers[stopId] = [];
    }

    return newEdges;
}

interface ShortcutsCacheFile {
    stopIds?: string[];
    stopHash?: string;
    transfers: TransfersByOrigin;
    fullEdgeCount?: number;
    shortcutEdgeCount: number;
    builtAt?: string;
}

function persistShortcutsCache(stopIds: string[], result: SparseWalkingTransferResult): void {
    try {
        writeFileSync(SHORTCUTS_CACHE_PATH, JSON.stringify({
            stopIds,
            stopHash: stopSetHash(stopIds),
            transfers: result.transfers,
            fullEdgeCount: result.fullEdgeCount,
            shortcutEdgeCount: result.shortcutEdgeCount,
            builtAt: new Date().toISOString(),
        }, null, 2));
        console.log(`Wrote ${SHORTCUTS_CACHE_PATH}`);
    } catch (err) {
        console.warn('Failed to write walking shortcuts cache:', err);
    }
}

function loadShortcutsFromDisk(): { stopIds: string[]; result: SparseWalkingTransferResult } | null {
    if (!existsSync(SHORTCUTS_CACHE_PATH)) return null;
    try {
        const cached = JSON.parse(readFileSync(SHORTCUTS_CACHE_PATH, 'utf8')) as ShortcutsCacheFile;
        if (!cached.transfers) return null;
        const stopIds = cached.stopIds?.length
            ? sortedStopIds(cached.stopIds)
            : inferStopIdsFromTransfers(cached.transfers);
        const result: SparseWalkingTransferResult = {
            transfers: cached.transfers,
            fullEdgeCount: cached.fullEdgeCount ?? countTransferEdges(cached.transfers),
            shortcutEdgeCount: cached.shortcutEdgeCount,
        };
        return { stopIds, result };
    } catch {
        return null;
    }
}

function commitShortcuts(stopIds: string[], result: SparseWalkingTransferResult): SparseWalkingTransferResult {
    inMemoryShortcuts = { stopIds, result };
    return result;
}

/**
 * ULTRA-style sparse walking transfers: full walk matrix + transitive reduction.
 * Preserves optimal walking distances; McRAPTOR only relaxes non-redundant shortcut edges.
 * Loaded shortcuts stay in memory; disk is cold-start only. New stops extend incrementally.
 */
export function buildSparseWalkingTransfers(stopIds: string[]): SparseWalkingTransferResult {
    const sorted = sortedStopIds(stopIds);

    if (inMemoryShortcuts && stopSetsEqual(inMemoryShortcuts.stopIds, sorted)) {
        return inMemoryShortcuts.result;
    }

    let cachedStopIds = inMemoryShortcuts?.stopIds ?? null;
    let cachedResult = inMemoryShortcuts?.result ?? null;

    if (!cachedResult) {
        const fromDisk = loadShortcutsFromDisk();
        if (fromDisk) {
            cachedStopIds = fromDisk.stopIds;
            cachedResult = fromDisk.result;
            console.log(
                `Loaded walking shortcuts from disk into memory (${fromDisk.result.shortcutEdgeCount} edges, ${cachedStopIds.length} stops)`
            );
        }
    }

    if (cachedResult && cachedStopIds) {
        const newStops = addedStopIds(cachedStopIds, sorted);

        if (newStops.length === 0 && isStopSuperset(cachedStopIds, sorted)) {
            const edgeCount = finalizeTransferGraph(cachedResult.transfers, sorted);
            const result: SparseWalkingTransferResult = {
                transfers: cachedResult.transfers,
                fullEdgeCount: edgeCount,
                shortcutEdgeCount: edgeCount,
            };
            return commitShortcuts(cachedStopIds, result);
        }

        if (newStops.length > 0) {
            if (!isStopSuperset(sorted, cachedStopIds)) {
                console.warn(
                    `Walking shortcuts: extending ${newStops.length} new stop(s) on partial cache ` +
                    `(${cachedStopIds.length} cached → ${sorted.length} current).`
                );
            } else {
                console.log(
                    `Extending walking shortcuts for ${newStops.length} new stop(s) ` +
                    `(${cachedStopIds.length} → ${sorted.length})...`
                );
            }
            const transfers = cachedResult.transfers;
            const addedEdges = extendWalkingTransfers(transfers, sorted, newStops);
            const edgeCount = finalizeTransferGraph(transfers, sorted);
            const result: SparseWalkingTransferResult = {
                transfers,
                fullEdgeCount: edgeCount,
                shortcutEdgeCount: edgeCount,
            };
            console.log(`Walking shortcuts extended: +${addedEdges} edges (${edgeCount} total)`);
            persistShortcutsCache(sorted, result);
            return commitShortcuts(sorted, result);
        }
    }

    if (cachedResult && process.env.WALKING_REBUILD_SHORTCUTS !== 'true') {
        console.warn(
            'Walking shortcuts: cache present but stop set changed unexpectedly; ' +
            'using cached graph. Set WALKING_REBUILD_SHORTCUTS=true to force full rebuild.'
        );
        const edgeCount = finalizeTransferGraph(cachedResult.transfers, sorted);
        return commitShortcuts(sorted, {
            transfers: cachedResult.transfers,
            fullEdgeCount: edgeCount,
            shortcutEdgeCount: edgeCount,
        });
    }

    console.log(`Walking shortcuts: full rebuild for ${sorted.length} stops...`);
    const full = buildStopToStopWalkMatrix(sorted);
    const fullEdgeCount = countStopWalkEdges(full);

    console.log(`Applying transitive reduction (${fullEdgeCount} directed walk edges)...`);
    const shortcuts = transitiveReductionShortcuts(sorted, full);
    const shortcutEdgeCount = countStopWalkEdges(shortcuts);

    const transfers = shortcutsToTransfers(shortcuts, metersToWalkDuration);
    const edgeCount = finalizeTransferGraph(transfers, sorted);

    console.log(
        `Walking shortcuts: ${fullEdgeCount} reachable → ${shortcutEdgeCount} after reduction, ` +
        `${edgeCount} total with unreachable pairs`
    );

    const result: SparseWalkingTransferResult = { transfers, fullEdgeCount, shortcutEdgeCount: edgeCount };
    persistShortcutsCache(sorted, result);
    return commitShortcuts(sorted, result);
}

/** @internal Exposed for tests comparing CH vs Dijkstra. */
export function __computeDijkstraAll(startId: string, targets?: Set<string>) {
    return computeDijkstraAll(startId, targets);
}

initializeGraph();
