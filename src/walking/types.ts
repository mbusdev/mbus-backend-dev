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
    geometry?: { lat: number, lon: number }[] 
};
