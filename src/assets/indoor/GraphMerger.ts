import { LoadedGraph, CombinedGraph, PortalEdge, GraphEdge, AdjacencyEdge } from "./types";//combined loaded graphs intoa a bigger combined graph with portal edges

export class GraphMerger {
  public static mergeGraphs(
    graphs: LoadedGraph[],
    portalEdges: PortalEdge[] = []
  ): CombinedGraph {
    const combined: CombinedGraph = {
      nodesById: {},
      edgesById: {},
      adjacencyList: {}
    };

    for (const graph of graphs) {
      // nodes
      for (const [nodeId, node] of Object.entries(graph.nodesById)) {
        combined.nodesById[nodeId] = node;
        combined.adjacencyList[nodeId] = combined.adjacencyList[nodeId] || [];
      }

      // edges
      for (const [edgeId, edge] of Object.entries(graph.edgesById)) {
        combined.edgesById[edgeId] = edge;
      }

      // adjacency
      for (const [nodeId, edges] of Object.entries(graph.adjacencyList)) {
        combined.adjacencyList[nodeId] = combined.adjacencyList[nodeId] || [];
        combined.adjacencyList[nodeId].push(...edges);
      }
    }

    for (const portal of portalEdges) {
      const fromExists = !!combined.nodesById[portal.from];
      const toExists = !!combined.nodesById[portal.to];

      if (!fromExists || !toExists) {
        throw new Error(
          `Portal edge ${portal.id} references missing node(s): from=${portal.from}, to=${portal.to}`
        );
      }

      const portalAsGraphEdge: GraphEdge = {
        id: portal.id,
        from: portal.from,
        to: portal.to,
        type: portal.type,
        cost: portal.cost,
        distance: portal.distance,
        accessibility: portal.accessibility
      };

      combined.edgesById[portal.id] = portalAsGraphEdge;

      const forward: AdjacencyEdge = {
        to: portal.to,
        cost: portal.cost,
        edgeId: portal.id,
        type: portal.type
      };

      const backward: AdjacencyEdge = {
        to: portal.from,
        cost: portal.cost,
        edgeId: portal.id,
        type: portal.type
      };

      combined.adjacencyList[portal.from].push(forward);
      combined.adjacencyList[portal.to].push(backward);
    }

    return combined;
  }
}