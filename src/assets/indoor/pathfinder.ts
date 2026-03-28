import { AdjacencyEdge } from "./types";

export interface PathStep {
  from: string;
  to: string;
  edgeId: string;
  cost: number;
  type: string;
}

export interface PathResult {
  nodePath: string[];
  steps: PathStep[];
  totalCost: number;
}

export class Pathfinder {
  public static shortestPath(
    adjacencyList: Record<string, AdjacencyEdge[]>,
    start: string,
    goal: string
  ): PathResult {
    const distances: Record<string, number> = {};
    const visited = new Set<string>();

    // previousNode[to] = from
    const previousNode: Record<string, string | null> = {};

    // previousEdge[to] = 走到这个点时用的那条边
    const previousEdge: Record<string, AdjacencyEdge | null> = {};

    for (const node in adjacencyList) {
      distances[node] = Infinity;
      previousNode[node] = null;
      previousEdge[node] = null;
    }

    distances[start] = 0;

    while (true) {
      let current: string | null = null;
      let smallest = Infinity;

      for (const node in distances) {
        if (!visited.has(node) && distances[node] < smallest) {
          smallest = distances[node];
          current = node;
        }
      }

      if (current === null) {
        break;
      }

      if (current === goal) {
        break;
      }

      visited.add(current);

      for (const neighbor of adjacencyList[current]) {
        if (visited.has(neighbor.to)) {
          continue;
        }

        const newDist = distances[current] + neighbor.cost;

        if (newDist < distances[neighbor.to]) {
          distances[neighbor.to] = newDist;
          previousNode[neighbor.to] = current;
          previousEdge[neighbor.to] = neighbor;
        }
      }
    }

    if (distances[goal] === Infinity) {
      return {
        nodePath: [],
        steps: [],
        totalCost: Infinity
      };
    }

    const nodePath: string[] = [];
    const steps: PathStep[] = [];

    let cur: string | null = goal;

while (cur !== null) {
  const currentNode: string = cur;
  nodePath.push(currentNode);

  const prev: string | null = previousNode[currentNode];
  const edge: AdjacencyEdge | null = previousEdge[currentNode];

  if (prev !== null && edge !== null) {
    steps.push({
      from: prev,
      to: currentNode,
      edgeId: edge.edgeId,
      cost: edge.cost,
      type: edge.type
    });
  }

  cur = prev;
}

    nodePath.reverse();
    steps.reverse();

    return {
      nodePath,
      steps,
      totalCost: distances[goal]
    };
  }
}