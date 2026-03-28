import { FloorGraphJson, AdjacencyEdge, LoadedGraph } from "./types";

export class GraphLoader {
  public static loadFloorGraph(data: FloorGraphJson): LoadedGraph {
    const adj: Record<string, AdjacencyEdge[]> = {};
    const nodesById: Record<string, any> = {};
    const edgesById: Record<string, any> = {};

    for (const node of data.nodes) {
      adj[node.id] = [];

      nodesById[node.id] = {
        ...node,
        buildingId: data.buildingId,
        floor: data.floor
      };
    }

    for (const edge of data.edges) {
      edgesById[edge.id] = edge;

      adj[edge.from].push({
        to: edge.to,
        cost: edge.cost,
        edgeId: edge.id,
        type: edge.type
      });

      adj[edge.to].push({
        to: edge.from,
        cost: edge.cost,
        edgeId: edge.id,
        type: edge.type
      });
    }

    return {
      buildingId: data.buildingId,
      floor: data.floor,
      nodesById,
      edgesById,
      adjacencyList: adj
    };
  }
}