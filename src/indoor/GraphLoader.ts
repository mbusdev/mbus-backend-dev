
import { FloorGraphJson, AdjacencyEdge, GraphEdge, GraphNode, LoadedGraph } from "./types";

export class GraphLoader {
  public static loadFloorGraph(data: FloorGraphJson): LoadedGraph {
    const adj: Record<string, AdjacencyEdge[]> = {};
    const nodesById: Record<string, GraphNode> = {};
    const edgesById: Record<string, GraphEdge> = {};

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

    for (const vc of data.verticalConnections ?? []) {
      const graphEdge: GraphEdge = {
        id: vc.id,
        from: vc.from,
        to: vc.to,
        type: vc.type,
        cost: vc.cost,
        accessibility: vc.accessibility
      };
      edgesById[vc.id] = graphEdge;

      if (adj[vc.from]) {
        adj[vc.from].push({
          to: vc.to,
          cost: vc.cost,
          edgeId: vc.id,
          type: vc.type
        });
      }

      if (adj[vc.to]) {
        adj[vc.to].push({
          to: vc.from,
          cost: vc.cost,
          edgeId: vc.id,
          type: vc.type
        });
      }
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
