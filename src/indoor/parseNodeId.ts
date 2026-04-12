export type ParsedNodeId = {
  buildingId: string;
  floor: number;
  raw: string;
};

export function parseNodeId(nodeId: string): ParsedNodeId {
  const parts = nodeId.split("_");

  if (parts.length < 2) {
    throw new Error(`Invalid nodeId format: ${nodeId}`);
  }

  const buildingId = parts[0];
  const floorPart = parts[1];

  if (!/^f\d+$/.test(floorPart)) {
    throw new Error(`Invalid floor segment in nodeId: ${nodeId}`);
  }

  const floor = Number(floorPart.slice(1));

  return {
    buildingId,
    floor,
    raw: nodeId
  };
}