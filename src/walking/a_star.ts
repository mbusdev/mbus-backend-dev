import express from 'express';
import fs from 'fs';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';

type GraphMLNode = { id: string; lat: number; lon: number };

type GraphMLEdge = { 
  to: string; 
  dist: number; 
  geometry?: { lat: number, lon: number }[] 
};
type LandmarkDef = { name: string; lat: number; lon: number; nodeId?: string };

export interface WalkingResponse {
  duration: number; // in seconds
  distance: number; // in meters
  path_coords: { lat: number, lon: number }[];
}

export interface BatchWalkingResult {
    nearestNodeId: string;
    distanceToNode: number;
    nodeDistances: Map<string, number>; // Map<NodeId, DistanceFromStartNode>
}

const MAP_FILE = path.resolve(process.cwd(), 'src/assets/ann_arbor.graphml'); 
const CACHE_FILE = path.resolve(process.cwd(), 'src/assets/landmark_dist.json');
const WALKING_SPEED_M_S = 5000 / 3600; // ~1.39 m/s
const DEBUG = false;

let graphNodes: Map<string, GraphMLNode> = new Map();
let graphAdjacency: Map<string, GraphMLEdge[]> = new Map();
const LANDMARK_DISTANCES = new Map<string, Map<string, number>>();

const LANDMARKS: LandmarkDef[] = [
  { name: "Hayward/Hubbard", lat: 42.295877, lon: -83.707688999999 },
  { name: "Crisler Center", lat: 42.264356, lon: -83.744353999999 },
  { name: "Dominos Farms", lat: 42.321140000001, lon: -83.682196000001 },
  { name: "Wall St Structure", lat: 42.288482999999, lon: -83.735965 },
  { name: "Plymouth Park-and-Ride", lat: 42.30597, lon: -83.68852 },
  { name: "Oxford Housing", lat: 42.274684999999, lon: -83.726024999999 }
];

// --- Helper Functions ---

function haversine(aLat: number, aLon: number, bLat: number, bLon: number) {
  const R = 6371000; 
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const sinDlat = Math.sin(dLat / 2);
  const sinDlon = Math.sin(dLon / 2);
  const a = sinDlat * sinDlat + Math.cos(lat1) * Math.cos(lat2) * sinDlon * sinDlon;
  return 2 * R * Math.asin(Math.sqrt(a));
}


function parseWktGeometry(wkt: string): { lat: number, lon: number }[] {
  if (!wkt || !wkt.startsWith('LINESTRING')) return [];
  
  // Remove "LINESTRING (" and ")"
  const clean = wkt.replace(/^LINESTRING\s*\(/i, '').replace(/\)$/, '');
  
  // Split by comma to get coordinate pairs
  const parts = clean.split(',');
  
  return parts.map(pt => {
    // Split by whitespace
    const coords = pt.trim().split(/\s+/);
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    return { lat, lon };
  });
}

export function nearestNode(nodes: Map<string, GraphMLNode>, lat: number, lon: number) {
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

function reconstructPath(cameFrom: Map<string, string>, current: string) {
  const total = [current];
  while (cameFrom.has(current)) {
    current = cameFrom.get(current)!;
    total.push(current);
  }
  return total.reverse();
}

// --- Core Loading Logic ---

function loadMap() {
  console.log('Loading GraphML map from', MAP_FILE);
  const xml = fs.readFileSync(MAP_FILE, 'utf8');
  
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: true,
    isArray: (name: string) => ['node', 'edge', 'data', 'key'].includes(name)
  });
  
  const parsed = parser.parse(xml) as any;
  const nodesById = new Map<string, GraphMLNode>();
  const graph = new Map<string, GraphMLEdge[]>();

  const WALKABLE_TYPES = new Set([
    'pedestrian', 'footway', 'path', 'steps', 
    'living_street', 'residential', 'service', 
    'track', 'corridor', 'crossing', 'cycleway',
    'bridleway', 'unclassified'
  ]);

  const graphml = parsed.graphml || parsed['graphml:graphml'] || parsed;

  // Build a mapping from key id to attr.name
  const keyIdToAttr: Record<string, string> = {};
  if (graphml.key) {
    const keys = Array.isArray(graphml.key) ? graphml.key : [graphml.key];
    for (const keyElem of keys) {
      const id = keyElem.id;
      const attrName = keyElem['attr.name'] || keyElem.attrname || keyElem['attrname'] || keyElem['attr_name'];
      if (id && attrName) keyIdToAttr[id] = attrName;
    }
  }

  const graphElem = graphml.graph || graphml['graph'] || (graphml[Object.keys(graphml).find(k => k.endsWith('graph'))!]);
  if (!graphElem) {
    console.error('Invalid GraphML file: missing <graph>');
    return { nodes: nodesById, graph };
  }

  // 1. Parse Nodes
  if (graphElem.node) {
    for (const node of graphElem.node) {
      const id = node.id;
      let lat = null, lon = null;
      
      if (node.data) {
        for (const d of node.data) {
          let key = d['@_key'] || d.key;
          if (Array.isArray(key)) key = key[0];
          
          const attr = keyIdToAttr[key];
          const value = d['#text'] ?? d['#value'] ?? d['$'] ?? d.value ?? d;
          
          if (attr === 'y') lat = Number(value);
          if (attr === 'x') lon = Number(value);
        }
      }
      
      if (lat !== null && lon !== null) {
        nodesById.set(String(id), { id: String(id), lat, lon });
      }
    }
  }

  if (DEBUG) console.log(`Loaded ${nodesById.size} nodes from GraphML`);

  // Initialize adjacency lists
  for (const [id] of nodesById) {
    graph.set(id, []);
  }

  let totalEdges = 0;
  let skippedEdges = 0;

  // 2. Parse Edges
  if (graphElem.edge) {
    for (const edge of graphElem.edge) {
      const source = String(edge.source);
      const target = String(edge.target);
      
      let length: number | undefined = undefined;
      let highway: string = '';
      let wktString: string | null = null;

      if (edge.data) {
        for (const d of edge.data) {
          let key = d['@_key'] || d.key;
          if (Array.isArray(key)) key = key[0];
          
          const attr = keyIdToAttr[key];
          const value = d['#text'] ?? d['#value'] ?? d['$'] ?? d.value ?? d;

          if (attr === 'length') {
            length = Number(value);
          }
          if (attr === 'highway') {
            highway = String(value);
          }
          
          if (attr === 'geometry' || attr === 'wkt' || (typeof value === 'string' && value.startsWith('LINESTRING'))) {
             wktString = String(value);
          }
        }
      }

      const rawTypes = highway.replace(/[\[\]'"]/g, '').split(',');
      const isWalkable = rawTypes.some(t => WALKABLE_TYPES.has(t.trim()));

      if (!isWalkable) {
        skippedEdges++;
        continue; 
      }

      if (length === undefined) {
        const n1 = nodesById.get(source);
        const n2 = nodesById.get(target);
        if (n1 && n2) {
          length = haversine(n1.lat, n1.lon, n2.lat, n2.lon);
        }
      }

      // Prepare Geometry
      let forwardGeo: { lat: number, lon: number }[] | undefined;
      let reverseGeo: { lat: number, lon: number }[] | undefined;

      if (wktString) {
        forwardGeo = parseWktGeometry(wktString);
        // Create a reversed copy for the backward edge
        reverseGeo = [...forwardGeo].reverse();
      }

      if (nodesById.has(source) && nodesById.has(target) && length !== undefined) {
        // Add Source -> Target
        graph.get(source)!.push({ 
            to: target, 
            dist: length, 
            geometry: forwardGeo 
        });
        // Add Target -> Source
        graph.get(target)!.push({ 
            to: source, 
            dist: length, 
            geometry: reverseGeo 
        });
        totalEdges += 2;
      }
    }
  }

  // --- Connected Components Pruning ---
  const visited = new Set<string>();
  let maxComponentSize = 0;
  let maxComponentNodes = new Set<string>();
  let componentCount = 0;

  for (const startNodeId of nodesById.keys()) {
    if (visited.has(startNodeId)) continue;

    componentCount++;
    const currentComponent = new Set<string>();
    const queue = [startNodeId];
    visited.add(startNodeId);
    currentComponent.add(startNodeId);

    let head = 0;
    while(head < queue.length) {
        const u = queue[head++];
        const neighbors = graph.get(u) || [];
        
        for (const edge of neighbors) {
            if (!visited.has(edge.to)) {
                visited.add(edge.to);
                currentComponent.add(edge.to);
                queue.push(edge.to);
            }
        }
    }

    if (currentComponent.size > maxComponentSize) {
        maxComponentSize = currentComponent.size;
        maxComponentNodes = currentComponent;
    }
  }

  let prunedCount = 0;
  for (const [id] of nodesById) {
    if (!maxComponentNodes.has(id)) {
      nodesById.delete(id);
      graph.delete(id);
      prunedCount++;
    }
  }

  if (DEBUG) {
    console.log(`Created ${totalEdges} edges (Skipped ${skippedEdges} non-walkable edges)`);
    console.log(`Found ${componentCount} disconnected clusters.`);
    console.log(`Kept largest cluster with ${maxComponentSize} nodes.`);
    console.log(`Pruned ${prunedCount} nodes from smaller/isolated clusters.`);
  }

  return { nodes: nodesById, graph };
}

// --- A* and Dijkstra Logic ---

class MinHeap {
  private arr: { id: string; f: number }[] = [];
  push(item: { id: string; f: number }) { this.arr.push(item); this._siftUp(); }
  pop() { if (this.arr.length === 0) return null; const top = this.arr[0]; const last = this.arr.pop()!; if (this.arr.length) { this.arr[0] = last; this._siftDown(); } return top; }
  size() { return this.arr.length; }
  private _siftUp() { let i = this.arr.length - 1; while (i > 0) { const p = Math.floor((i - 1) / 2); if (this.arr[i].f >= this.arr[p].f) break; [this.arr[i], this.arr[p]] = [this.arr[p], this.arr[i]]; i = p; } }
  private _siftDown() { let i = 0; const n = this.arr.length; while (true) { const l = 2 * i + 1; const r = 2 * i + 2; let smallest = i; if (l < n && this.arr[l].f < this.arr[smallest].f) smallest = l; if (r < n && this.arr[r].f < this.arr[smallest].f) smallest = r; if (smallest === i) break; [this.arr[i], this.arr[smallest]] = [this.arr[smallest], this.arr[i]]; i = smallest; } }
}

function computeDijkstraAll(startId: string): Map<string, number> {
    const distances = new Map<string, number>();
    const minHeap = new MinHeap();
    
    distances.set(startId, 0);
    minHeap.push({ id: startId, f: 0 });
    
    while(minHeap.size() > 0) {
        const { id: u, f: d } = minHeap.pop()!;
        if (d > (distances.get(u) ?? Infinity)) continue;
        const neighbors = graphAdjacency.get(u) ?? [];
        for(const edge of neighbors) {
            const newDist = d + edge.dist;
            if (newDist < (distances.get(edge.to) ?? Infinity)) {
                distances.set(edge.to, newDist);
                minHeap.push({ id: edge.to, f: newDist });
            }
        }
    }
    return distances;
}

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
      console.log(`Computation finished in ${(t1-t0).toFixed(0)}ms`);
      saveLandmarkDistances(LANDMARK_DISTANCES);
  }
}

// --- Main Exported Functions ---

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
                const nextId = result.pathIds[i+1];
                
                // Find the specific edge used to get to nextId
                const edge = graphAdjacency.get(currId)?.find(e => e.to === nextId);
                
                if (edge && edge.geometry && edge.geometry.length > 0) {
                    // Stitch geometry. 
                    for (let k = 1; k < edge.geometry.length; k++) {
                        pathCoords.push(edge.geometry[k]);
                    }
                } else {
                    // No detailed geometry? Just draw line to next node.
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

export function getWalkingDistancesFrom(lat: number, lon: number): BatchWalkingResult {
    if (graphNodes.size === 0) initializeGraph();

    const nearest = nearestNode(graphNodes, lat, lon);
    if (!nearest.id) throw new Error("No graph node found near origin");

    const distMap = computeDijkstraAll(nearest.id);

    return {
        nearestNodeId: nearest.id,
        distanceToNode: nearest.dist, 
        nodeDistances: distMap
    };
}

export function findNearestNode(lat: number, lon: number) {
    if (graphNodes.size === 0) initializeGraph();
    return nearestNode(graphNodes, lat, lon);
}

export const WALKING_SPEED = WALKING_SPEED_M_S;

// Trigger initialization
initializeGraph();