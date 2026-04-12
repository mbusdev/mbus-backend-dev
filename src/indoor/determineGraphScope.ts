import { parseNodeId } from "./parseNodeId";

export type GraphScope =
  | {
      type: "same_floor";
      buildingId: string;
      floor: number;
    }
  | {
      type: "same_building";
      buildingId: string;
      floors: number[];
    }
  | {
      type: "cross_building";
      buildingIds: string[];
    };

export function determineGraphScope(
  startNodeId: string,
  endNodeId: string
): GraphScope {
  const start = parseNodeId(startNodeId);
  const end = parseNodeId(endNodeId);

  if (
    start.buildingId === end.buildingId &&
    start.floor === end.floor
  ) {
    return {
      type: "same_floor",
      buildingId: start.buildingId,
      floor: start.floor
    };
  }

  if (start.buildingId === end.buildingId) {
    const minFloor = Math.min(start.floor, end.floor);
    const maxFloor = Math.max(start.floor, end.floor);

    const floors: number[] = [];
    for (let f = minFloor; f <= maxFloor; f++) {
      floors.push(f);
    }

    return {
      type: "same_building",
      buildingId: start.buildingId,
      floors
    };
  }

  return {
    type: "cross_building",
    buildingIds: [start.buildingId, end.buildingId]
  };
}