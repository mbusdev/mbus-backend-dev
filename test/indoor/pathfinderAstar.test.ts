import { describe, it, expect } from "vitest";
import { Pathfinder } from "../../src/indoor/pathfinderAstar";
import { AdjacencyEdge } from "../../src/indoor/types";

function edge(to: string, cost: number, edgeId: string, opts: Partial<AdjacencyEdge> = {}): AdjacencyEdge {
    return { to, cost, edgeId, type: "walk", ...opts };
}

describe("Pathfinder.shortestPathAStarHeap", () => {
    it("finds the shortest path on a simple graph", () => {
        // A-C direct costs 5; the two-hop A-B-C route (cost 2) should win.
        const adjacencyList: Record<string, AdjacencyEdge[]> = {
            A: [edge("B", 1, "A-B"), edge("C", 5, "A-C")],
            B: [edge("A", 1, "A-B"), edge("C", 1, "B-C")],
            C: [edge("A", 5, "A-C"), edge("B", 1, "B-C")]
        };
        const nodesById = {
            A: { x: 0, y: 0 },
            B: { x: 1, y: 0 },
            C: { x: 2, y: 0 }
        };

        const result = Pathfinder.shortestPathAStarHeap(adjacencyList, nodesById, "A", "C");

        expect(result.nodePath).toEqual(["A", "B", "C"]);
        expect(result.totalCost).toBe(2);
        expect(result.steps.map(s => s.edgeId)).toEqual(["A-B", "B-C"]);
    });

    it("returns an empty path with Infinity cost when the goal is unreachable", () => {
        const adjacencyList: Record<string, AdjacencyEdge[]> = {
            A: [edge("B", 1, "A-B")],
            B: [edge("A", 1, "A-B")],
            C: []
        };
        const nodesById = { A: { x: 0, y: 0 }, B: { x: 1, y: 0 }, C: { x: 10, y: 10 } };

        const result = Pathfinder.shortestPathAStarHeap(adjacencyList, nodesById, "A", "C");

        expect(result.nodePath).toEqual([]);
        expect(result.totalCost).toBe(Infinity);
    });

    it("accessibleOnly skips edges explicitly marked as not accessible", () => {
        // Direct edge A-B is cheap but marked inaccessible (e.g. stairs); A-C-B is the
        // accessible detour.
        const adjacencyList: Record<string, AdjacencyEdge[]> = {
            A: [edge("B", 1, "stairs", { accessibility: false }), edge("C", 3, "A-C")],
            B: [edge("A", 1, "stairs", { accessibility: false }), edge("C", 3, "C-B")],
            C: [edge("A", 3, "A-C"), edge("B", 3, "C-B")]
        };
        const nodesById = { A: { x: 0, y: 0 }, B: { x: 1, y: 0 }, C: { x: 0, y: 1 } };

        const direct = Pathfinder.shortestPathAStarHeap(adjacencyList, nodesById, "A", "B", false);
        expect(direct.nodePath).toEqual(["A", "B"]);
        expect(direct.totalCost).toBe(1);

        const accessible = Pathfinder.shortestPathAStarHeap(adjacencyList, nodesById, "A", "B", true);
        expect(accessible.nodePath).toEqual(["A", "C", "B"]);
        expect(accessible.totalCost).toBe(6);
    });

    it.fails(
        "KNOWN BUG: an inadmissible cross-floor heuristic can make A* return a non-optimal path",
        () => {
            // Simulates two floors whose (x, y) coordinates come from independent local
            // coordinate systems, as real floor plans do. B sits on the true shortest path
            // (A-B-G, cost 2), but its coordinates are numerically far from G's, so h(B) is
            // huge. C sits on a much worse path (A-C-G, cost 51), but its coordinates happen
            // to be numerically close to G's, so h(C) is tiny.
            //
            // The algorithm returns as soon as the goal is POPPED from the heap rather than
            // once it's provably optimal, so the misleading heuristic makes it settle for the
            // A-C-G path and return before A-B-G is ever explored. This is a real risk for any
            // route that spans a vertical connection (stairs/elevator) between floors whose
            // node coordinates aren't on a shared coordinate system.
            const adjacencyList: Record<string, AdjacencyEdge[]> = {
                A: [edge("B", 1, "A-B"), edge("C", 1, "A-C")],
                B: [edge("A", 1, "A-B"), edge("G", 1, "B-G")],
                C: [edge("A", 1, "A-C"), edge("G", 50, "C-G")],
                G: [edge("B", 1, "B-G"), edge("C", 50, "C-G")]
            };
            const nodesById = {
                A: { x: 0, y: 0 },
                B: { x: 1000, y: 0 }, // far away in B's own floor's coordinate system
                C: { x: 0, y: 0 },    // coincidentally close to G's coordinate system
                G: { x: 0, y: 0 }
            };

            const result = Pathfinder.shortestPathAStarHeap(adjacencyList, nodesById, "A", "G");

            // This is the correct answer. It currently fails: the function returns cost 51 via
            // A-C-G instead of cost 2 via A-B-G. If this test starts passing, the heuristic bug
            // has been fixed -- remove `.fails` above.
            expect(result.totalCost).toBe(2);
            expect(result.nodePath).toEqual(["A", "B", "G"]);
        }
    );
});
