import { describe, it, expect } from "vitest";
import { buildGraphLoadPlan } from "../../src/indoor/buildGraphLoadPlan";

describe("buildGraphLoadPlan", () => {
    it("loads a single target for a same-floor route", () => {
        const plan = buildGraphLoadPlan("dc_f1_a", "dc_f1_b");
        expect(plan.targets).toEqual([{ buildingId: "dc", floor: 1 }]);
    });

    it("loads one target per floor for a same-building, multi-floor route", () => {
        const plan = buildGraphLoadPlan("dc_f1_a", "dc_f3_b");
        expect(plan.targets).toEqual([
            { buildingId: "dc", floor: 1 },
            { buildingId: "dc", floor: 2 },
            { buildingId: "dc", floor: 3 }
        ]);
    });

    it("KNOWN GAP: a cross-building route only loads the two endpoint floors, with no connector graph between them", () => {
        // determineGraphScope reports "cross_building", but buildGraphLoadPlan never adds any
        // target representing the outdoor/connector path between the two buildings. The two
        // floor graphs loaded here will therefore be entirely disconnected once merged -- see
        // GraphMerger.test.ts and pathfinderAstar.test.ts for the downstream consequence
        // (computeIndoorRoute silently returns an empty path instead of an error or a real route).
        const plan = buildGraphLoadPlan("dc_f1_a", "ug_f1_b");
        expect(plan.targets).toEqual([
            { buildingId: "dc", floor: 1 },
            { buildingId: "ug", floor: 1 }
        ]);
    });
});
