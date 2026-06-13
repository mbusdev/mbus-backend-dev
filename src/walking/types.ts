/**
 * Represents a node in the street graph derived from GraphML.
 */
export type GraphMLNode = { 
    /** Unique identifier for the node (from OSM/GraphML). */
    id: string; 
    /** Latitude coordinate. */
    lat: number; 
    /** Longitude coordinate. */
    lon: number; 
};

/**
 * Represents a directed edge (street segment) connecting two nodes.
 */
export type GraphMLEdge = { 
    /** The ID of the target node this edge leads to. */
    to: string; 
    /** Length of the edge in meters. */
    dist: number; 
    /** Detailed geometry points (WKT) for rendering curved paths. */
    geometry?: { lat: number, lon: number }[];
    /** Types of path */
    types: string[];
    names: string[];
};

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
    /** Ordered list of coordinates representing where the actual nodes are. */
    node_coords: { lat: number, lon: number, prevEdgeTypes: string[] | null, prevEdgeNames: string[] | null }[];
    /** List of pairs of coordinates representing additional edges to show. */
    extra_edges: { lat1: number, lon1: number, lat2: number, lon2: number }[];
}

/**
 * Definition for a navigation landmark used in the ALT heuristic algorithm.
 */
export type LandmarkDef = {
    /** Display name of the landmark. */
    name: string; 
    /** Latitude coordinate. */
    lat: number; 
    /** Longitude coordinate. */
    lon: number; 
    /** The Graph Node ID nearest to this landmark (computed at runtime). */
    nodeId?: string; 
};