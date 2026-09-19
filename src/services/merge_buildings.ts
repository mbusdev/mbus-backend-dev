import fs from 'fs';
import path from 'path';

interface BuildingEntry {
  ID: string;
  lat: string;
  long: string;
  buildingName?: string;
  abbreviation?: string;
  address: string;
}

/**
 * Reads all *-complete.json files from src/assets/buildings directory,
 * concatenates them into a single array, preserving any abbreviation fields,
 * and writes to a merged file. This merged file is accessed by the frontend.
 */
export async function mergeBuildings(): Promise<BuildingEntry[]> {
  const buildingDataDir = './src/assets/buildings';
  const outputPath = path.join(buildingDataDir, 'merged-buildings.json');

  if (!fs.existsSync(buildingDataDir)) {
    console.error(`Building data directory not found: ${buildingDataDir}`);
    return [];
  }

  const files = fs.readdirSync(buildingDataDir);
  const completeFiles = files.filter(file => file.endsWith('-complete.json'));

  const allBuildings: BuildingEntry[] = [];

  for (const file of completeFiles) {
    const filePath = path.join(buildingDataDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const buildings: BuildingEntry[] = JSON.parse(content);
      allBuildings.push(...buildings);
    } catch (error) {
      console.error(`  Failed to read ${file}: ${error instanceof Error ? error.message : error}`);
    }
  }

  const dedupedBuildings = dedupeBuildingsByAddress(allBuildings);

  // Write the merged data
  fs.writeFileSync(outputPath, JSON.stringify(dedupedBuildings, null, 2));

  return dedupedBuildings;
}

function dedupeBuildingsByAddress(buildings: BuildingEntry[]): BuildingEntry[] {
  const normalizedAddress = (address: string) =>
    address.trim().toLowerCase().replace(/\s+/g, ' ');

  const seen = new Map<string, BuildingEntry>();

  for (const building of buildings) {
    const address = building.address || '';
    const key = normalizedAddress(address);
    const existing = seen.get(key);

    if (!existing) {
      seen.set(key, building);
      continue;
    }

    const existingHasAbbr = Boolean(existing.abbreviation && existing.abbreviation.trim());
    const currentHasAbbr = Boolean(building.abbreviation && building.abbreviation.trim());

    if (currentHasAbbr && !existingHasAbbr) {
      seen.set(key, building);
    }
  }

  return Array.from(seen.values());
}

// Run the merge if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  mergeBuildings().catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}
