import { describe, it, expect } from "vitest";
import { parseNodeId } from "../../src/indoor/parseNodeId";

describe("parseNodeId", () => {
    it("parses a standard node id into buildingId, floor, raw", () => {
        const result = parseNodeId("dc_f1_corridor_1");
        expect(result).toEqual({
            buildingId: "dc",
            floor: 1,
            raw: "dc_f1_corridor_1"
        });
    });

    it("parses multi-digit floor numbers", () => {
        const result = parseNodeId("ug_f12_lobby");
        expect(result.buildingId).toBe("ug");
        expect(result.floor).toBe(12);
    });

    it("throws on a node id with fewer than two segments", () => {
        expect(() => parseNodeId("dc")).toThrow(/Invalid nodeId format/);
    });

    it("throws when the floor segment doesn't start with 'f'", () => {
        expect(() => parseNodeId("dc_1_corridor")).toThrow(/Invalid floor segment/);
    });

    it("throws when the floor segment has no digits after 'f'", () => {
        expect(() => parseNodeId("dc_f_corridor")).toThrow(/Invalid floor segment/);
    });
});
