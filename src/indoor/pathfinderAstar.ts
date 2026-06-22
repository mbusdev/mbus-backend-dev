import { Heap } from "heap-js";
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

interface HeapNode {
    nodeId: string;
    f: number;
}

export class Pathfinder {
    public static shortestPathAStarHeap(
        adjacencyList: Record<string, AdjacencyEdge[]>,
        nodesById: Record<string, any>,
        start: string,
        goal: string,
        accessibleOnly: boolean = false
    ): PathResult {
        const distances: Record<string, number> = {};
        const visited = new Set<string>();
        const previousNode: Record<string, string | null> = {};
        const previousEdge: Record<string, AdjacencyEdge | null> = {};

        for (const node in adjacencyList) {
            distances[node] = Infinity;
            previousNode[node] = null;
            previousEdge[node] = null;
        }
        distances[start] = 0;

        const minHeap = new Heap<HeapNode>((a,b) => a.f - b.f);
        minHeap.push({nodeId: start, f:0});

        function heuristic(nodeId:string): number {
            const a = nodesById[nodeId];
            const b = nodesById[goal];
            if(!a || !b) return 0;
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            return Math.sqrt(dx*dx + dy*dy);
        }

        while(!minHeap.isEmpty()){
            const currentNodeObj = minHeap.pop()!;
            const current = currentNodeObj.nodeId;

            if(visited.has(current)) continue;
            if(current == goal) break;

            visited.add(current);

            for(const neighbor of adjacencyList[current]){
                if(visited.has(neighbor.to)) continue;
                if(accessibleOnly && neighbor.accessibility === false) continue;

                const newDist = distances[current] + neighbor.cost;

                if(newDist < distances[neighbor.to]){
                    distances[neighbor.to] = newDist;
                    previousNode[neighbor.to] = current;
                    previousEdge[neighbor.to] = neighbor;

                    minHeap.push({
                        nodeId: neighbor.to,
                        f: newDist + heuristic(neighbor.to)
                    });
                }
            }
        }

        if (distances[goal] === Infinity) {
            return { nodePath: [], steps: [], totalCost: Infinity };
        }

        const nodePath: string[] = [];
        const steps: PathStep[] = [];
        let cur: string | null = goal;

        while (cur !== null) {
            nodePath.push(cur);
            const prev: string | null = previousNode[cur];
            const edge = previousEdge[cur];
            if (prev && edge) {
                steps.push({
                    from: prev,
                    to: cur,
                    edgeId: edge.edgeId,
                    cost: edge.cost,
                    type: edge.type
                });
            }
            cur = prev;
        }

        nodePath.reverse();
        steps.reverse();

        return { nodePath, steps, totalCost: distances[goal] };
    }
}