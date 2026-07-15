import { describe, it, expect } from "vitest";
import { determineGraphScope } from "../../src/indoor/determineGraphScope";

describe("determineGraphScope", () => {
    it("classifies same building + same floor as same_floor", () => {
        const scope = determineGraphScope("dc_f1_a", "dc_f1_b");
        expect(scope).toEqual({ type: "same_floor", buildingId: "dc", floor: 1 });
    });

    it("classifies same building + different floor as same_building with an inclusive floor range", () => {
        const scope = determineGraphScope("dc_f1_a", "dc_f3_b");
        expect(scope).toEqual({ type: "same_building", buildingId: "dc", floors: [1, 2, 3] });
    });

    it("orders the floor range regardless of which endpoint is on the higher floor", () => {
        const scope = determineGraphScope("dc_f3_a", "dc_f1_b");
        expect(scope).toEqual({ type: "same_building", buildingId: "dc", floors: [1, 2, 3] });
    });

    it("classifies different buildings as cross_building", () => {
        const scope = determineGraphScope("dc_f1_a", "ug_f1_b");
        expect(scope).toEqual({ type: "cross_building", buildingIds: ["dc", "ug"] });
    });
});
