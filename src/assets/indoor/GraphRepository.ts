import { Collection } from "mongodb";//search graphs in MongoDB
import { FloorGraphJson } from "./types";

export class GraphRepository {
  constructor(
    private readonly floorGraphsCollection: Collection<FloorGraphJson>
  ) {}

  public async getFloorGraph(
    buildingId: string,
    floor: number
  ): Promise<FloorGraphJson | null> {
    return await this.floorGraphsCollection.findOne({ buildingId, floor });
  }

  public async getFloorGraphs(
    targets: { buildingId: string; floor: number }[]
  ): Promise<FloorGraphJson[]> {
    if (targets.length === 0) {
      return [];
    }

    const orQuery = targets.map(t => ({
      buildingId: t.buildingId,
      floor: t.floor
    }));

    return await this.floorGraphsCollection
      .find({ $or: orQuery })
      .toArray();
  }
}