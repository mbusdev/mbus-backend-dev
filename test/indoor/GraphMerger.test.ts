import { describe, it, expect } from "vitest";
import { GraphMerger } from "../../src/indoor/GraphMerger";
import { LoadedGraph, PortalEdge } from "../../src/indoor/types";

function makeGraph(buildingId: string, floor: number, nodeIds: string[]): LoadedGraph {
    const nodesById: LoadedGraph["nodesById"] = {};
    const adjacencyList: LoadedGraph["adjacencyList"] = {};

    for (const id of nodeIds) {
        nodesById[id] = { id, type: "corridor", name: id, x: 0, y: 0, buildingId, floor };
        adjacencyList[id] = [];
    }

    return { buildingId, floor, nodesById, edgesById: {}, adjacencyList };
}

describe("GraphMerger.mergeGraphs", () => {
    it("merges disjoint floor graphs into one node/edge/adjacency space", () => {
        const floor1 = makeGraph("dc", 1, ["dc_f1_a", "dc_f1_b"]);
        const floor2 = makeGraph("dc", 2, ["dc_f2_a"]);

        const combined = GraphMerger.mergeGraphs([floor1, floor2]);

        expect(Object.keys(combined.nodesById).sort()).toEqual(["dc_f1_a", "dc_f1_b", "dc_f2_a"]);
        expect(combined.adjacencyList["dc_f1_a"]).toEqual([]);
        expect(combined.adjacencyList["dc_f2_a"]).toEqual([]);
    });

    it("adds a portal edge (e.g. stairs/elevator) to the adjacency list in both directions", () => {
        const floor1 = makeGraph("dc", 1, ["dc_f1_a"]);
        const floor2 = makeGraph("dc", 2, ["dc_f2_a"]);
        const portal: PortalEdge = {
            id: "dc_f1_a__dc_f2_a",
            from: "dc_f1_a",
            to: "dc_f2_a",
            type: "stairs",
            cost: 5
        };

        const combined = GraphMerger.mergeGraphs([floor1, floor2], [portal]);

        expect(combined.adjacencyList["dc_f1_a"]).toEqual([
            { to: "dc_f2_a", cost: 5, edgeId: "dc_f1_a__dc_f2_a", type: "stairs" }
        ]);
        expect(combined.adjacencyList["dc_f2_a"]).toEqual([
            { to: "dc_f1_a", cost: 5, edgeId: "dc_f1_a__dc_f2_a", type: "stairs" }
        ]);
        expect(combined.edgesById["dc_f1_a__dc_f2_a"]).toMatchObject({
            from: "dc_f1_a",
            to: "dc_f2_a",
            cost: 5
        });
    });

    it("throws when a portal edge references a node that wasn't loaded into any of the merged floors", () => {
        const floor1 = makeGraph("dc", 1, ["dc_f1_a"]);
        const portal: PortalEdge = {
            id: "bad_portal",
            from: "dc_f1_a",
            to: "dc_f9_ghost",
            type: "elevator",
            cost: 3
        };

        expect(() => GraphMerger.mergeGraphs([floor1], [portal])).toThrow(/references missing node/);
    });
});
