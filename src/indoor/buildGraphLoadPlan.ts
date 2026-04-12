import { determineGraphScope } from "./determineGraphScope";
import { parseNodeId } from "./parseNodeId";

export type GraphLoadTarget = {
  buildingId: string;
  floor: number;
};

export type GraphLoadPlan = {
  targets: GraphLoadTarget[];
};

export function buildGraphLoadPlan(
  startNodeId: string,
  endNodeId: string
): GraphLoadPlan {
  const scope = determineGraphScope(startNodeId, endNodeId);
  const start = parseNodeId(startNodeId);
  const end = parseNodeId(endNodeId);

  if (scope.type === "same_floor") {
    return {
      targets: [
        {
          buildingId: scope.buildingId,
          floor: scope.floor
        }
      ]
    };
  }

  if (scope.type === "same_building") {
    return {
      targets: scope.floors.map(floor => ({
        buildingId: scope.buildingId,
        floor
      }))
    };
  }

  return {
    targets: [
      {
        buildingId: start.buildingId,
        floor: start.floor
      },
      {
        buildingId: end.buildingId,
        floor: end.floor
      }
    ]
  };
}