import fs from 'fs';
import { XMLParser } from 'fast-xml-parser';
import path from 'path';
import { GraphMLNode, GraphMLEdge } from './types';

const MAP_FILE = path.resolve(process.cwd(), 'src/assets/ann_arbor.graphml');
const DEBUG = false;

/**
 * Parses a Well-Known Text (WKT) LINESTRING into an array of coordinate objects.
 * @param wkt - The WKT string (e.g., "LINESTRING (lon lat, lon lat)").
 * @returns Array of { lat, lon } points.
 */
function parseWktGeometry(wkt: string): { lat: number, lon: number }[] {
    if (!wkt || !wkt.startsWith('LINESTRING')) return [];

    // Remove "LINESTRING (" and ")"
    const clean = wkt.replace(/^LINESTRING\s*\(/i, '').replace(/\)$/, '');
    const parts = clean.split(',');

    return parts.map(pt => {
        const coords = pt.trim().split(/\s+/);
        const lon = Number(coords[0]);
        const lat = Number(coords[1]);
        return { lat, lon };
    });
}

/**
 * Calculates the great-circle distance between two points using the Haversine formula.
 * @param aLat - Latitude of point A.
 * @param aLon - Longitude of point A.
 * @param bLat - Latitude of point B.
 * @param bLon - Longitude of point B.
 * @returns Distance in meters.
 */
export function haversine(aLat: number, aLon: number, bLat: number, bLon: number) {
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

/**
 * Loads and parses the GraphML map file into a usable graph structure.
 * * Performs the following steps:
 * 1. Reads the XML file.
 * 2. Extracts Nodes (lat/lon).
 * 3. Extracts Edges (filtering for walkable types like 'footway', 'path').
 * 4. Parses edge geometry (WKT) if available.
 * 5. Prunes disconnected components, keeping only the largest connected subgraph.
 * * @returns An object containing the map of Nodes and the Adjacency List (graph).
 */
export function loadMap() {
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
                    geometry: forwardGeo,
                    types: rawTypes,
                });
                // Add Target -> Source
                graph.get(target)!.push({
                    to: source,
                    dist: length,
                    geometry: reverseGeo,
                    types: rawTypes,
                });
                totalEdges += 2;
            }
        }
    }

    // prune disconnected components, keep only largest
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
        while (head < queue.length) {
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

    return { nodes: nodesById, graph };
}