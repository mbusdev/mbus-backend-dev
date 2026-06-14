/**
 * Contraction hierarchy (CH) walking router for Ann Arbor.
 *
 * Ported from [contraction-hierarchy-js](https://github.com/royhobbstn/contraction-hierarchy-js) (MIT).
 * Used by `walkingMap.ts` for fast street-network distances and polylines when
 * `src/assets/ann_arbor.ch.json` is present.
 *
 * ## Runtime (server)
 *
 * 1. `walkingMap` calls {@link loadContractionHierarchy} at startup if the CH file exists.
 * 2. Coordinate queries snap to the graph via {@link nearestGraphNode} (spatial grid index).
 * 3. **Batch** stop access legs use {@link queryDistancesFromOrigin} (PHAST, one-to-many).
 * 4. **Point-to-point** polylines use {@link queryPath} / {@link queryDistance}.
 *
 * If the CH file is missing or `WALKING_USE_DIJKSTRA=true`, `walkingMap` falls back to full-graph Dijkstra.
 *
 * ## Offline build
 *
 * Regenerate the asset after `ann_arbor.graphml` changes:
 *
 * ```bash
 * npm run build:walking-ch
 * ```
 *
 * Writes `src/assets/ann_arbor.ch.json` (~45MB) and `src/assets/ch-metadata.json`.
 * Commit the CH file via **Git LFS** (see `.gitattributes`) so clones get fast routing without rebuilding.
 *
 * ## Public API
 *
 * | Function | Purpose |
 * |----------|---------|
 * | {@link loadContractionHierarchy} | Load prebuilt CH from disk |
 * | {@link queryDistancesFromOrigin} | PHAST batch distances from one graph node |
 * | {@link queryDistance} | Point-to-point distance |
 * | {@link queryPath} | Point-to-point distance + node path |
 * | {@link nearestGraphNode} | Snap lat/lon to nearest street node |
 * | {@link buildWalkingChAssets} | Offline preprocessor (also invoked by `build:walking-ch`) |
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pathToFileURL } from 'url';
import type { GraphMLNode, GraphMLEdge } from './types';
import { haversine, loadMap } from './loadMap';

// --- min-heap (tinyqueue-style) ---

type HeapCompare<T> = (a: T, b: T) => number;

interface HeapNode {
    heapIndex: number;
}

class NodeHeap<T extends HeapNode> {
    data: T[] = [];
    length = 0;
    private compare: HeapCompare<T>;

    constructor(options: { compare: HeapCompare<T> }) {
        this.compare = options.compare;
    }

    push(item: T) {
        this.data.push(item);
        item.heapIndex = this.length;
        this.length++;
        this._up(this.length - 1);
    }

    pop(): T | undefined {
        if (this.length === 0) return undefined;
        const top = this.data[0];
        this.length--;
        if (this.length > 0) {
            this.data[0] = this.data[this.length];
            this.data[0].heapIndex = 0;
            this._down(0);
        }
        this.data.pop();
        return top;
    }

    peek(): T | undefined {
        return this.data[0];
    }

    updateItem(pos: number) {
        this._down(pos);
        this._up(pos);
    }

    private _up(pos: number) {
        const { data, compare } = this;
        const item = data[pos];
        while (pos > 0) {
            const parent = (pos - 1) >> 1;
            const current = data[parent];
            if (compare(item, current) >= 0) break;
            data[pos] = current;
            current.heapIndex = pos;
            pos = parent;
        }
        data[pos] = item;
        item.heapIndex = pos;
    }

    private _down(pos: number) {
        const { data, compare, length } = this;
        const halfLength = length >> 1;
        const item = data[pos];
        while (pos < halfLength) {
            let left = (pos << 1) + 1;
            const right = left + 1;
            let best = data[left];
            if (right < length && compare(data[right], best) < 0) {
                left = right;
                best = data[right];
            }
            if (compare(best, item) >= 0) break;
            data[pos] = best;
            best.heapIndex = pos;
            pos = left;
        }
        data[pos] = item;
        item.heapIndex = pos;
    }
}

// --- search state pool ---

interface SearchState extends HeapNode {
    id: number;
    dist: number;
    prev?: number;
    visited?: boolean;
    opened: boolean;
    attrs?: number;
}

function createNodePool() {
    let currentInCache = 0;
    const nodeCache: SearchState[] = [];

    return {
        reset() {
            currentInCache = 0;
        },
        createNewState(node: { id: number; dist?: number }): SearchState {
            let cached = nodeCache[currentInCache];
            if (cached) {
                cached.id = node.id;
                cached.dist = node.dist !== undefined ? node.dist : Infinity;
                cached.prev = undefined;
                cached.visited = undefined;
                cached.opened = false;
                cached.heapIndex = -1;
                cached.attrs = undefined;
            } else {
                cached = {
                    id: node.id,
                    dist: node.dist !== undefined ? node.dist : Infinity,
                    opened: false,
                    heapIndex: -1,
                };
                nodeCache[currentInCache] = cached;
            }
            currentInCache++;
            return cached;
        },
    };
}

// --- contraction hierarchy graph ---

interface ChAdjEdge {
    end: number;
    cost: number;
    attrs: number;
}

interface ChEdgeProperties {
    _id: number | number[];
    _cost: number;
    _start_index: number;
    _end_index: number;
    _ordered?: number[];
    [key: string]: unknown;
}

interface PathfinderOptions {
    nodes?: boolean;
}

export interface ChQueryResult {
    total_cost: number;
    nodes?: string[];
}

interface SerializedChGraph {
    _locked: boolean;
    adjacency_list: ChAdjEdge[][];
    reverse_adjacency_list: ChAdjEdge[][];
    contracted_nodes?: number[];
    _nodeToIndexLookup: Record<string, number>;
    _edgeProperties: ChEdgeProperties[];
    _maxUncontractedEdgeIndex: number;
}

interface PhastIncomingEdge {
    from: number;
    cost: number;
}

class OrderNode implements SearchState {
    score: number;
    id: number;
    dist = Infinity;
    opened = false;
    heapIndex = -1;
    constructor(score: number, id: number) {
        this.score = score;
        this.id = id;
    }
}

export class ContractionHierarchyGraph {
    debugMode = false;
    adjacency_list: ChAdjEdge[][] = [];
    reverse_adjacency_list: ChAdjEdge[][] = [];
    contracted_nodes: number[] = [];

    _currentNodeIndex = -1;
    _nodeToIndexLookup: Record<string, number> = {};
    _indexToNodeLookup: Record<number, string> = {};
    _currentEdgeIndex = -1;
    _edgeProperties: ChEdgeProperties[] = [];
    _maxUncontractedEdgeIndex = 0;
    _locked = false;

    private _phastUpIncoming: PhastIncomingEdge[][] | null = null;
    private _phastOrderDesc: number[] | null = null;

    private _createNodePool = createNodePool;

    addEdge(
        start: string,
        end: string,
        properties: { _id: number; _cost: number },
        isUndirected = true
    ) {
        if (this._locked) throw new Error('Graph has been contracted.');
        this._addEdge(start, end, properties, isUndirected);
    }

    private _addEdge(
        start: string,
        end: string,
        edgeProperties: { _id: number; _cost: number },
        isUndirected: boolean
    ) {
        const startNode = String(start);
        const endNode = String(end);
        if (startNode === endNode) return;

        if (this._nodeToIndexLookup[startNode] == null) {
            this._currentNodeIndex++;
            this._nodeToIndexLookup[startNode] = this._currentNodeIndex;
            this._indexToNodeLookup[this._currentNodeIndex] = startNode;
        }
        if (this._nodeToIndexLookup[endNode] == null) {
            this._currentNodeIndex++;
            this._nodeToIndexLookup[endNode] = this._currentNodeIndex;
            this._indexToNodeLookup[this._currentNodeIndex] = endNode;
        }

        const startNodeIndex = this._nodeToIndexLookup[startNode];
        const endNodeIndex = this._nodeToIndexLookup[endNode];

        this._currentEdgeIndex++;
        const props: ChEdgeProperties = {
            ...edgeProperties,
            _start_index: startNodeIndex,
            _end_index: endNodeIndex,
        };
        this._edgeProperties[this._currentEdgeIndex] = props;

        const obj: ChAdjEdge = { end: endNodeIndex, cost: edgeProperties._cost, attrs: this._currentEdgeIndex };
        const reverseObj: ChAdjEdge = { end: startNodeIndex, cost: edgeProperties._cost, attrs: this._currentEdgeIndex };

        if (!this.adjacency_list[startNodeIndex]) this.adjacency_list[startNodeIndex] = [];
        this.adjacency_list[startNodeIndex].push(obj);

        if (!this.reverse_adjacency_list[endNodeIndex]) this.reverse_adjacency_list[endNodeIndex] = [];
        this.reverse_adjacency_list[endNodeIndex].push(reverseObj);

        if (isUndirected) {
            if (!this.adjacency_list[endNodeIndex]) this.adjacency_list[endNodeIndex] = [];
            this.adjacency_list[endNodeIndex].push(reverseObj);
            if (!this.reverse_adjacency_list[startNodeIndex]) this.reverse_adjacency_list[startNodeIndex] = [];
            this.reverse_adjacency_list[startNodeIndex].push(obj);
        }
    }

    private _addContractedEdge(startIndex: number, endIndex: number, properties: ChEdgeProperties) {
        this._currentEdgeIndex++;
        properties._start_index = startIndex;
        properties._end_index = endIndex;
        this._edgeProperties[this._currentEdgeIndex] = properties;

        const obj: ChAdjEdge = { end: endIndex, cost: properties._cost, attrs: this._currentEdgeIndex };
        const reverseObj: ChAdjEdge = { end: startIndex, cost: properties._cost, attrs: this._currentEdgeIndex };

        if (!this.adjacency_list[startIndex]) this.adjacency_list[startIndex] = [];
        this.adjacency_list[startIndex].push(obj);
        if (!this.reverse_adjacency_list[endIndex]) this.reverse_adjacency_list[endIndex] = [];
        this.reverse_adjacency_list[endIndex].push(reverseObj);
    }

    contractGraph() {
        if (this._locked) throw new Error('Network has already been contracted');
        this._locked = true;
        this._maxUncontractedEdgeIndex = this._currentEdgeIndex;

        const finder = this._createChShortcutter();

        const getContractedNeighborCount = (v: number) =>
            (this.adjacency_list[v] || []).reduce((acc, node) => {
                const isContracted = this.contracted_nodes[node.end] != null ? 1 : 0;
                return acc + isContracted;
            }, 0);

        const getVertexScore = (v: number) => {
            const shortcutCount = this._contract(v, true, finder);
            const edgeCount = (this.adjacency_list[v] || []).length;
            const edgeDifference = shortcutCount - edgeCount;
            return edgeDifference + getContractedNeighborCount(v);
        };

        const nh = new NodeHeap<OrderNode>({
            compare: (a, b) => a.score - b.score,
        });

        this.contracted_nodes = [];
        Object.keys(this._nodeToIndexLookup).forEach(key => {
            const index = this._nodeToIndexLookup[key];
            nh.push(new OrderNode(getVertexScore(index), index));
        });

        let contractionLevel = 1;
        const len = nh.length;

        while (nh.length > 0) {
            if (nh.length % 50 === 0) {
                if (this.debugMode) console.log(`${nh.length} / ${len}`);
                this._cleanAdjList(this.adjacency_list);
                this._cleanAdjList(this.reverse_adjacency_list);
            }

            let foundLowest = false;
            let nodeObj = nh.peek()!;
            const oldScore = nodeObj.score;

            do {
                const firstVertex = nodeObj.id;
                const newScore = getVertexScore(firstVertex);
                if (newScore > oldScore) {
                    nodeObj.score = newScore;
                    nh.updateItem(nodeObj.heapIndex);
                }
                nodeObj = nh.peek()!;
                if (nodeObj.id === firstVertex) foundLowest = true;
            } while (!foundLowest);

            const v = nh.pop()!;
            this._contract(v.id, false, finder);
            this.contracted_nodes[v.id] = contractionLevel;
            contractionLevel++;
        }

        this._cleanAdjList(this.adjacency_list);
        this._cleanAdjList(this.reverse_adjacency_list);
        this._arrangeContractedPaths(this.adjacency_list);
        this._arrangeContractedPaths(this.reverse_adjacency_list);

        if (this.debugMode) console.log('Contraction complete');
    }

    private _arrangeContractedPaths(adjList: ChAdjEdge[][]) {
        adjList.forEach((node, index) => {
            node.forEach(edge => {
                const startNode = index;
                const simpleIds: number[] = [];
                const ids: number[] = [edge.attrs];

                while (ids.length) {
                    const id = ids.pop()!;
                    if (id <= this._maxUncontractedEdgeIndex) {
                        simpleIds.push(id);
                    } else {
                        const edgeId = this._edgeProperties[id]._id;
                        if (Array.isArray(edgeId)) ids.push(...edgeId);
                    }
                }

                const links: Record<string, number[]> = {};
                simpleIds.forEach(id => {
                    const properties = this._edgeProperties[id];
                    const si = String(properties._start_index);
                    const ei = String(properties._end_index);
                    if (!links[si]) links[si] = [id];
                    else links[si].push(id);
                    if (!links[ei]) links[ei] = [id];
                    else links[ei].push(id);
                });

                const ordered: number[] = [];
                let lastNode = String(startNode);
                let currentEdgeId: number | null = links[lastNode]?.[0] ?? null;

                while (currentEdgeId != null) {
                    ordered.push(currentEdgeId);
                    const edgeProps: ChEdgeProperties = this._edgeProperties[currentEdgeId];
                    const c1: string = String(edgeProps._start_index);
                    const c2: string = String(edgeProps._end_index);
                    const nextNode: string = c1 === lastNode ? c2 : c1;
                    lastNode = nextNode;
                    const arr: number[] | undefined = links[nextNode];
                    if (!arr || arr.length === 1) break;
                    if (arr.length > 2) throw new Error('Too many edges at node during CH arrange');
                    currentEdgeId = arr[0] === currentEdgeId ? arr[1] : arr[0];
                }

                this._edgeProperties[edge.attrs]._ordered = ordered;
            });
        });
    }

    private _cleanAdjList(adjList: ChAdjEdge[][]) {
        adjList.forEach((node, nodeId) => {
            const fromRank = this.contracted_nodes[nodeId];
            if (fromRank == null) return;
            adjList[nodeId] = node.filter(edge => {
                const toRank = this.contracted_nodes[edge.end];
                if (toRank == null) return true;
                return fromRank < toRank;
            });
        });
    }

    private _contract(
        v: number,
        getCountOnly: boolean,
        finder: ReturnType<ContractionHierarchyGraph['_createChShortcutter']>
    ): number {
        const fromConnections = (this.reverse_adjacency_list[v] || []).filter(c => !this.contracted_nodes[c.end]);
        const toConnections = (this.adjacency_list[v] || []).filter(c => !this.contracted_nodes[c.end]);
        let shortcutCount = 0;

        fromConnections.forEach(u => {
            const dist1 = u.cost;
            let maxTotal = 0;
            toConnections.forEach(w => {
                if (u.end === w.end) return;
                const total = dist1 + w.cost;
                if (total > maxTotal) maxTotal = total;
            });
            if (!toConnections.length) return;

            const path = finder.runDijkstra(u.end, null, v, maxTotal);

            toConnections.forEach(w => {
                if (u.end === w.end) return;
                const dist2 = w.cost;
                const total = dist1 + dist2;
                const dijkstra = path.distances[w.end] ?? Infinity;
                if (total < dijkstra) {
                    shortcutCount++;
                    if (!getCountOnly) {
                        this._addContractedEdge(u.end, w.end, {
                            _cost: total,
                            _id: [u.attrs, w.attrs],
                            _start_index: u.end,
                            _end_index: w.end,
                        });
                    }
                }
            });
        });

        return shortcutCount;
    }

    private _createChShortcutter() {
        const pool = this._createNodePool();
        const adjacencyList = this.adjacency_list;

        return {
            runDijkstra: (
                startIndex: number,
                endIndex: number | null,
                vertex: number,
                total: number
            ) => {
                pool.reset();
                const nodeState: (SearchState | undefined)[] = [];
                const distances: Record<number, number> = {};
                const openSet = new NodeHeap<SearchState>({ compare: (a, b) => a.dist - b.dist });

                let current: SearchState | undefined = pool.createNewState({ id: startIndex, dist: 0 });
                nodeState[startIndex] = current;
                current.opened = true;
                distances[current.id] = 0;

                if (startIndex === endIndex) current = undefined;

                while (current) {
                    (adjacencyList[current.id] || [])
                        .filter(edge => edge.end !== vertex)
                        .forEach(edge => {
                            let node = nodeState[edge.end];
                            if (!node) {
                                node = pool.createNewState({ id: edge.end });
                                nodeState[edge.end] = node;
                            }
                            if (node.visited) return;
                            if (!node.opened) {
                                openSet.push(node);
                                node.opened = true;
                            }
                            const proposed = current!.dist + edge.cost;
                            if (proposed >= node.dist) return;
                            node.dist = proposed;
                            distances[node.id] = proposed;
                            node.prev = current!.id;
                            openSet.updateItem(node.heapIndex);
                        });

                    current.visited = true;
                    const settledAmt = current.dist;
                    current = openSet.pop();
                    if (current && endIndex != null && current.id === endIndex) break;
                    if (settledAmt > total) break;
                }

                return { distances, nodeState };
            },
        };
    }

    createPathfinder(options?: PathfinderOptions) {
        const adjacencyList = this.adjacency_list;
        const reverseAdjacencyList = this.reverse_adjacency_list;
        const edgeProperties = this._edgeProperties;
        const pool = this._createNodePool();
        const nodeToIndexLookup = this._nodeToIndexLookup;
        const indexToNodeLookup = this._indexToNodeLookup;
        const opts = options ?? {};

        const queryContractionHierarchy = (start: string, end: string): ChQueryResult => {
            pool.reset();
            const startIndex = nodeToIndexLookup[String(start)];
            const endIndex = nodeToIndexLookup[String(end)];
            if (startIndex == null || endIndex == null) {
                return { total_cost: Infinity };
            }

            const forwardNodeState: (SearchState | undefined)[] = [];
            const backwardNodeState: (SearchState | undefined)[] = [];
            const forwardDistances: Record<number, number> = {};
            const backwardDistances: Record<number, number> = {};

            let currentStart = pool.createNewState({ id: startIndex, dist: 0 });
            forwardNodeState[startIndex] = currentStart;
            currentStart.opened = true;
            forwardDistances[currentStart.id] = 0;

            let currentEnd = pool.createNewState({ id: endIndex, dist: 0 });
            backwardNodeState[endIndex] = currentEnd;
            currentEnd.opened = true;
            backwardDistances[currentEnd.id] = 0;

            let tentativeShortest = Infinity;
            let tentativeShortestNode: number | null = null;

            function* doDijkstra(
                adj: ChAdjEdge[][],
                initial: SearchState,
                nodeState: (SearchState | undefined)[],
                distances: Record<number, number>,
                reverseDistances: Record<number, number>
            ) {
                const openSet = new NodeHeap<SearchState>({ compare: (a, b) => a.dist - b.dist });
                let current: SearchState | undefined = initial;

                while (current) {
                    (adj[current.id] || []).forEach(edge => {
                        let node = nodeState[edge.end];
                        if (!node) {
                            node = pool.createNewState({ id: edge.end });
                            node.attrs = edge.attrs;
                            nodeState[edge.end] = node;
                        }
                        if (node.visited) return;
                        if (!node.opened) {
                            openSet.push(node);
                            node.opened = true;
                        }
                        const proposed = current!.dist + edge.cost;
                        if (proposed >= node.dist) return;
                        node.dist = proposed;
                        distances[node.id] = proposed;
                        node.attrs = edge.attrs;
                        node.prev = current!.id;
                        openSet.updateItem(node.heapIndex);

                        const reverseDist = reverseDistances[edge.end];
                        if (reverseDist >= 0) {
                            const pathLen = proposed + reverseDist;
                            if (tentativeShortest > pathLen) {
                                tentativeShortest = pathLen;
                                tentativeShortestNode = edge.end;
                            }
                        }
                    });
                    current.visited = true;
                    current = openSet.pop();
                    if (current) yield current;
                }
            }

            if (startIndex !== endIndex) {
                const searchForward = doDijkstra(
                    adjacencyList, currentStart, forwardNodeState, forwardDistances, backwardDistances
                );
                const searchBackward = doDijkstra(
                    reverseAdjacencyList, currentEnd, backwardNodeState, backwardDistances, forwardDistances
                );
                let forwardDone = false;
                let backwardDone = false;
                let sf = searchForward.next();
                let sb = searchBackward.next();

                do {
                    if (!forwardDone) {
                        sf = searchForward.next();
                        if (sf.done) forwardDone = true;
                    }
                    if (!backwardDone) {
                        sb = searchBackward.next();
                        if (sb.done) backwardDone = true;
                    }
                } while (
                    (sf.value && forwardDistances[sf.value.id] < tentativeShortest) ||
                    (sb.value && backwardDistances[sb.value.id] < tentativeShortest)
                );
            } else {
                tentativeShortest = 0;
                tentativeShortestNode = startIndex;
            }

            const result: ChQueryResult = {
                total_cost: tentativeShortest !== Infinity ? tentativeShortest : Infinity,
            };

            if (opts.nodes && tentativeShortestNode != null && tentativeShortest !== Infinity) {
                result.nodes = this._buildNodeList(
                    edgeProperties, forwardNodeState, backwardNodeState,
                    tentativeShortestNode, startIndex, indexToNodeLookup
                );
            }

            return result;
        };

        return { queryContractionHierarchy: queryContractionHierarchy.bind(this) };
    }

    private _buildNodeList(
        edgeProperties: ChEdgeProperties[],
        forwardNodeState: (SearchState | undefined)[],
        backwardNodeState: (SearchState | undefined)[],
        meetingNode: number,
        startNode: number,
        indexToNodeLookup: Record<number, string>
    ): string[] {
        const pathway: { id: number; direction: 'f' | 'b' }[] = [];
        const nodeList: number[] = [meetingNode];

        let currentForward = forwardNodeState[meetingNode];
        let currentBackward = backwardNodeState[meetingNode];

        while (currentForward && currentForward.attrs != null) {
            pathway.push({ id: currentForward.attrs, direction: 'f' });
            nodeList.push(currentForward.prev!);
            currentForward = forwardNodeState[currentForward.prev!];
        }
        pathway.reverse();
        nodeList.reverse();

        while (currentBackward && currentBackward.attrs != null) {
            pathway.push({ id: currentBackward.attrs, direction: 'b' });
            nodeList.push(currentBackward.prev!);
            currentBackward = backwardNodeState[currentBackward.prev!];
        }

        let node = startNode;
        const ordered = pathway.map(p => {
            const start = p.direction === 'f'
                ? edgeProperties[p.id]._start_index
                : edgeProperties[p.id]._end_index;
            const end = p.direction === 'f'
                ? edgeProperties[p.id]._end_index
                : edgeProperties[p.id]._start_index;
            const props = [...(edgeProperties[p.id]._ordered ?? [])];
            if (node !== start) {
                props.reverse();
                node = start;
            } else {
                node = end;
            }
            return props;
        });

        const flattened = ordered.flat();
        const nodes: string[] = [];
        let currentNode = startNode;
        nodes.push(indexToNodeLookup[currentNode]);

        for (const edgeIndex of flattened) {
            const edge = edgeProperties[edgeIndex];
            if (currentNode === edge._start_index) currentNode = edge._end_index;
            else if (currentNode === edge._end_index) currentNode = edge._start_index;
            else currentNode = edge._end_index;
            nodes.push(indexToNodeLookup[currentNode]);
        }

        return nodes;
    }

    /** PHAST: one upward Dijkstra + linear downward scan (one-to-many / one-to-all on CH). */
    queryPhastFromIndex(origin: number, targets?: Set<number>): Map<number, number> {
        this._ensurePhastIndex();
        const n = this._currentNodeIndex + 1;
        const upAdj = this.adjacency_list;
        const upIncoming = this._phastUpIncoming!;
        const orderDesc = this._phastOrderDesc!;

        const dist = new Float64Array(n);
        dist.fill(Infinity);
        dist[origin] = 0;

        const openSet = new NodeHeap<SearchState>({ compare: (a, b) => a.dist - b.dist });
        const pool = createNodePool();
        pool.reset();
        const nodeState: (SearchState | undefined)[] = [];

        let current: SearchState | undefined = pool.createNewState({ id: origin, dist: 0 });
        nodeState[origin] = current;
        current.opened = true;
        openSet.push(current);

        while (current) {
            const settled = current.dist;
            if (settled > dist[current.id]) {
                current = openSet.pop();
                continue;
            }
            for (const edge of upAdj[current.id] || []) {
                const proposed = settled + edge.cost;
                if (proposed >= dist[edge.end]) continue;
                dist[edge.end] = proposed;

                let node = nodeState[edge.end];
                if (!node) {
                    node = pool.createNewState({ id: edge.end, dist: proposed });
                    nodeState[edge.end] = node;
                    node.opened = true;
                    openSet.push(node);
                } else {
                    node.dist = proposed;
                    openSet.updateItem(node.heapIndex);
                }
            }
            current = openSet.pop();
        }

        for (const v of orderDesc) {
            const dv = dist[v];
            if (!Number.isFinite(dv)) continue;
            for (const { from: w, cost } of upIncoming[v]) {
                const proposed = dv + cost;
                if (proposed < dist[w]) dist[w] = proposed;
            }
        }

        const out = new Map<number, number>();
        if (targets && targets.size > 0) {
            for (const t of targets) {
                const d = dist[t];
                if (Number.isFinite(d)) out.set(t, d);
            }
        } else {
            for (let i = 0; i < n; i++) {
                const d = dist[i];
                if (Number.isFinite(d)) out.set(i, d);
            }
        }
        return out;
    }

    private _ensurePhastIndex() {
        if (this._phastUpIncoming && this._phastOrderDesc) return;

        const n = this._currentNodeIndex + 1;
        const upAdj = this.adjacency_list;
        const ranks = this._nodeRanks(n, upAdj);

        const upIncoming: PhastIncomingEdge[][] = Array.from({ length: n }, () => []);
        for (let u = 0; u < n; u++) {
            for (const edge of upAdj[u] || []) {
                upIncoming[edge.end].push({ from: u, cost: edge.cost });
            }
        }

        const orderDesc = Array.from({ length: n }, (_, i) => i).sort((a, b) => ranks[b] - ranks[a]);

        this._phastUpIncoming = upIncoming;
        this._phastOrderDesc = orderDesc;
    }

    private _nodeRanks(n: number, upAdj: ChAdjEdge[][]): Uint32Array {
        if (this.contracted_nodes.length > 0) {
            const ranks = new Uint32Array(n);
            for (let i = 0; i < n; i++) {
                ranks[i] = this.contracted_nodes[i] ?? 0;
            }
            return ranks;
        }

        const inDeg = new Uint32Array(n);
        for (let u = 0; u < n; u++) {
            for (const edge of upAdj[u] || []) {
                inDeg[edge.end]++;
            }
        }

        const ranks = new Uint32Array(n);
        const queue: number[] = [];
        for (let i = 0; i < n; i++) {
            if (inDeg[i] === 0) queue.push(i);
        }

        let r = 0;
        let seen = 0;
        while (queue.length > 0) {
            const u = queue.shift()!;
            ranks[u] = r++;
            seen++;
            for (const edge of upAdj[u] || []) {
                if (--inDeg[edge.end] === 0) queue.push(edge.end);
            }
        }

        if (seen !== n) {
            for (let i = 0; i < n; i++) ranks[i] = i;
        }
        return ranks;
    }

    saveCH(): string {
        if (!this._locked) throw new Error('Save CH only after contraction');
        const data: SerializedChGraph = {
            _locked: this._locked,
            adjacency_list: this.adjacency_list,
            reverse_adjacency_list: this.reverse_adjacency_list,
            contracted_nodes: this.contracted_nodes,
            _nodeToIndexLookup: this._nodeToIndexLookup,
            _edgeProperties: this._edgeProperties,
            _maxUncontractedEdgeIndex: this._maxUncontractedEdgeIndex,
        };
        return JSON.stringify(data);
    }

    loadCH(json: string | SerializedChGraph) {
        const parsed: SerializedChGraph = typeof json === 'string' ? JSON.parse(json) : json;
        this._locked = parsed._locked;
        this.adjacency_list = parsed.adjacency_list;
        this.reverse_adjacency_list = parsed.reverse_adjacency_list;
        this.contracted_nodes = parsed.contracted_nodes ?? [];
        this._nodeToIndexLookup = parsed._nodeToIndexLookup;
        this._edgeProperties = parsed._edgeProperties;
        this._maxUncontractedEdgeIndex = parsed._maxUncontractedEdgeIndex;
        this._indexToNodeLookup = {};
        for (const [node, index] of Object.entries(this._nodeToIndexLookup)) {
            this._indexToNodeLookup[Number(index)] = node;
        }
        this._currentEdgeIndex = this._edgeProperties.length - 1;
        this._currentNodeIndex = Object.keys(this._indexToNodeLookup).length - 1;
        this._phastUpIncoming = null;
        this._phastOrderDesc = null;
    }

    get nodeCount() {
        return Object.keys(this._nodeToIndexLookup).length;
    }
}

/** Build an uncontracted CH graph from a walking adjacency list (GraphML node string ids). */
export function buildGraphFromAdjacency(
    adjacency: Map<string, GraphMLEdge[]>,
    options?: { debugMode?: boolean }
): ContractionHierarchyGraph {
    const graph = new ContractionHierarchyGraph();
    graph.debugMode = options?.debugMode ?? false;

    const directedMin = new Map<string, number>();
    for (const [from, edges] of adjacency) {
        for (const edge of edges) {
            const key = `${from}|${edge.to}`;
            const prev = directedMin.get(key);
            if (prev == null || edge.dist < prev) {
                directedMin.set(key, edge.dist);
            }
        }
    }

    const undirectedMin = new Map<string, { a: string; b: string; cost: number }>();
    for (const [key, cost] of directedMin) {
        const [a, b] = key.split('|');
        const pairKey = a < b ? `${a}|${b}` : `${b}|${a}`;
        const prev = undirectedMin.get(pairKey);
        if (prev == null || cost < prev.cost) {
            undirectedMin.set(pairKey, { a, b, cost });
        }
    }

    let edgeId = 1;
    for (const { a, b, cost } of undirectedMin.values()) {
        graph.addEdge(a, b, { _id: edgeId++, _cost: cost }, true);
    }

    return graph;
}

// --- runtime loader / query API ---

const CH_FILE = path.resolve(process.cwd(), 'src/assets/ann_arbor.ch.json');
const CH_META_FILE = path.resolve(process.cwd(), 'src/assets/ch-metadata.json');
const GRAPHML_FILE = path.resolve(process.cwd(), 'src/assets/ann_arbor.graphml');

let chGraph: ContractionHierarchyGraph | null = null;
let pathfinder: ReturnType<ContractionHierarchyGraph['createPathfinder']> | null = null;

export function getChFilePath() {
    return CH_FILE;
}

/** True after a successful {@link loadContractionHierarchy}. */
export function isChLoaded() {
    return chGraph != null && pathfinder != null;
}

/**
 * Load `src/assets/ann_arbor.ch.json` into memory. Call once at startup.
 * @throws If the CH file is missing (run `npm run build:walking-ch` or pull Git LFS).
 */
export function loadContractionHierarchy(): void {
    if (!fs.existsSync(CH_FILE)) {
        throw new Error(
            `Missing contraction hierarchy at ${CH_FILE}. Run: npm run build:walking-ch`
        );
    }

    const graph = new ContractionHierarchyGraph();
    graph.loadCH(fs.readFileSync(CH_FILE, 'utf8'));
    chGraph = graph;
    pathfinder = graph.createPathfinder({ nodes: true });

    if (fs.existsSync(CH_META_FILE) && fs.existsSync(GRAPHML_FILE)) {
        try {
            const meta = JSON.parse(fs.readFileSync(CH_META_FILE, 'utf8'));
            const hash = crypto.createHash('sha256').update(fs.readFileSync(GRAPHML_FILE)).digest('hex');
            if (meta.graphmlSha256 && meta.graphmlSha256 !== hash) {
                console.warn(
                    '[CH] ann_arbor.ch.json may be stale — graphml hash differs from ch-metadata.json. Re-run npm run build:walking-ch'
                );
            }
        } catch {
            /* ignore metadata read errors */
        }
    }

    console.log(`[CH] Loaded contraction hierarchy (${graph.nodeCount} nodes)`);
}

/** PHAST: one origin graph node → many targets (used for McRaptor walk-access batches). */
export function queryDistancesFromOrigin(
    startNodeId: string,
    targetNodeIds: Iterable<string>
): Map<string, number> | null {
    if (!chGraph) return null;
    const startIdx = chGraph._nodeToIndexLookup[String(startNodeId)];
    if (startIdx == null) return null;

    const targetIdx = new Set<number>();
    for (const tid of targetNodeIds) {
        const idx = chGraph._nodeToIndexLookup[String(tid)];
        if (idx != null) targetIdx.add(idx);
    }

    const byIdx = chGraph.queryPhastFromIndex(startIdx, targetIdx);
    const out = new Map<string, number>();
    for (const [idx, d] of byIdx) {
        const nodeId = chGraph._indexToNodeLookup[idx];
        if (nodeId) out.set(nodeId, d);
    }
    return out;
}

/** Shortest-path distance in meters between two graph node IDs, or null if unreachable. */
export function queryDistance(startNodeId: string, endNodeId: string): number | null {
    if (!pathfinder) return null;
    const result = pathfinder.queryContractionHierarchy(startNodeId, endNodeId);
    if (!Number.isFinite(result.total_cost) || result.total_cost === Infinity) return null;
    return result.total_cost;
}

/** Shortest path between two graph nodes (distance + contracted node sequence). */
export function queryPath(
    startNodeId: string,
    endNodeId: string
): { distance: number; nodeIds: string[] } | null {
    if (!pathfinder) return null;
    const result = pathfinder.queryContractionHierarchy(startNodeId, endNodeId);
    if (!Number.isFinite(result.total_cost) || result.total_cost === Infinity || !result.nodes?.length) {
        return null;
    }
    return { distance: result.total_cost, nodeIds: result.nodes };
}

/** ~200m grid cells for fast nearest-node lookup (full 51k scan was ~20ms per call). */
const NEAREST_GRID_DEG = 0.002;
let nearestNodeGrid: Map<string, GraphMLNode[]> | null = null;
let nearestNodeGridSize = 0;

/** Build spatial grid index for {@link nearestGraphNode}. Call when graph nodes change. */
export function buildNearestNodeIndex(nodes: Map<string, GraphMLNode>) {
    const grid = new Map<string, GraphMLNode[]>();
    for (const n of nodes.values()) {
        const key = `${Math.floor(n.lat / NEAREST_GRID_DEG)}|${Math.floor(n.lon / NEAREST_GRID_DEG)}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(n);
        else grid.set(key, [n]);
    }
    nearestNodeGrid = grid;
    nearestNodeGridSize = nodes.size;
}

/** Snap coordinates to the nearest walking-graph node (haversine distance to node center). */
export function nearestGraphNode(
    nodes: Map<string, GraphMLNode>,
    lat: number,
    lon: number
): { id: string; dist: number } | null {
    if (!nearestNodeGrid || nearestNodeGridSize !== nodes.size) {
        buildNearestNodeIndex(nodes);
    }

    const grid = nearestNodeGrid!;
    const cx = Math.floor(lat / NEAREST_GRID_DEG);
    const cy = Math.floor(lon / NEAREST_GRID_DEG);
    const cellMeters = NEAREST_GRID_DEG * 111_000;

    let bestId: string | null = null;
    let bestDist = Infinity;

    for (let ring = 0; ring < 40; ring++) {
        for (let dx = -ring; dx <= ring; dx++) {
            for (let dy = -ring; dy <= ring; dy++) {
                if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
                const bucket = grid.get(`${cx + dx}|${cy + dy}`);
                if (!bucket) continue;
                for (const n of bucket) {
                    const d = haversine(lat, lon, n.lat, n.lon);
                    if (d < bestDist) {
                        bestDist = d;
                        bestId = n.id;
                    }
                }
            }
        }
        if (bestId != null && bestDist <= ring * cellMeters) break;
    }

    return bestId ? { id: bestId, dist: bestDist } : null;
}

export function stitchPathCoords(
    pathIds: string[],
    graphNodes: Map<string, GraphMLNode>,
    graphAdjacency: Map<string, GraphMLEdge[]>,
    originLat: number,
    originLon: number,
    destLat: number,
    destLon: number
): { lat: number; lon: number }[] {
    const pathCoords: { lat: number; lon: number }[] = [{ lat: originLat, lon: originLon }];

    if (pathIds.length > 0) {
        const startNode = graphNodes.get(pathIds[0]);
        if (startNode) pathCoords.push({ lat: startNode.lat, lon: startNode.lon });

        for (let i = 0; i < pathIds.length - 1; i++) {
            const currId = pathIds[i];
            const nextId = pathIds[i + 1];
            const edge = graphAdjacency.get(currId)?.find(e => e.to === nextId);

            if (edge?.geometry && edge.geometry.length > 0) {
                for (let k = 1; k < edge.geometry.length; k++) {
                    pathCoords.push(edge.geometry[k]);
                }
            } else {
                const nextNode = graphNodes.get(nextId);
                if (nextNode) pathCoords.push({ lat: nextNode.lat, lon: nextNode.lon });
            }
        }
    }

    pathCoords.push({ lat: destLat, lon: destLon });
    return pathCoords;
}

// --- offline preprocessor ---

/**
 * Build CH from `ann_arbor.graphml` and write `ann_arbor.ch.json` + `ch-metadata.json`.
 * Invoked by `npm run build:walking-ch` (~minutes, high memory).
 */
export async function buildWalkingChAssets(): Promise<void> {
    if (!fs.existsSync(GRAPHML_FILE)) {
        console.error(`GraphML not found: ${GRAPHML_FILE}`);
        process.exit(1);
    }

    console.log('Loading GraphML...');
    const { nodes, graph } = loadMap();
    console.log(`Nodes: ${nodes.size}, building CH graph...`);

    const chGraphBuilt = buildGraphFromAdjacency(graph, { debugMode: true });
    console.log(`CH graph nodes: ${chGraphBuilt.nodeCount}`);
    console.log('Contracting — this may take several minutes...');
    const t0 = performance.now();
    chGraphBuilt.contractGraph();
    console.log(`Contraction finished in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

    const serialized = chGraphBuilt.saveCH();
    fs.writeFileSync(CH_FILE, serialized);
    console.log(`Wrote ${CH_FILE} (${(serialized.length / 1e6).toFixed(1)} MB)`);

    const graphmlSha256 = crypto.createHash('sha256').update(fs.readFileSync(GRAPHML_FILE)).digest('hex');
    const meta = {
        graphmlPath: 'src/assets/ann_arbor.graphml',
        graphmlSha256,
        nodeCount: nodes.size,
        builtAt: new Date().toISOString(),
        chImplementation: 'src/walking/contractionHierarchy.ts',
    };
    fs.writeFileSync(CH_META_FILE, JSON.stringify(meta, null, 2));
    console.log(`Wrote ${CH_META_FILE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    buildWalkingChAssets().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
