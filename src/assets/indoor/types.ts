export type RawNodeType = "corridor" | "door" | "stair" | "elevator";//to check if inputfile is lack of nodes/edges

export interface RawNode {
  id: string;
  type: RawNodeType;
  name: string;
  x: number;
  y: number;
  connectsTo?: string[];
}

export interface RawEdge {
  id: string;
  from: string;
  to: string;
  cost: number;
  type: "walk";
}

export interface RawVerticalConnection {
  id: string;
  from: string;
  to: string;
  type: "stairs" | "elevator";
  accessibility: boolean;
  cost: number;
}

export interface FloorGraphJson {
  schemaVersion: string;
  buildingId: string;
  floor: number;
  nodes: RawNode[];
  edges: RawEdge[];
  verticalConnections?: RawVerticalConnection[];
}


// for pathfinder 

export type NodeType = RawNodeType;
export type EdgeType = "walk" | "stairs" | "elevator";

export interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  x: number;
  y: number;
  buildingId: string;
  floor: number;
  connectsTo?: string[];
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: EdgeType;
  cost: number;
  distance?: number;
  accessibility?: boolean;
}

export interface AdjacencyEdge {
  to: string;
  cost: number;
  edgeId: string;
  type: EdgeType;
}

export interface LoadedGraph {
  buildingId: string;
  floor: number;
  nodesById: Record<string, GraphNode>;
  edgesById: Record<string, GraphEdge>;
  adjacencyList: Record<string, AdjacencyEdge[]>;
}