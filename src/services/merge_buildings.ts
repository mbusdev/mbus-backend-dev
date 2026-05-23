import fs from 'fs';
import path from 'path';

interface BuildingEntry {
  ID: string;
  lat: string;
  long: string;
  buildingName?: string;
  address: string;
}

/**
 * Reads all *-complete.json files from src/assets/buildings directory,
 * concatenates them into a single array, and writes to a merged file.
 * This merged file is accessed by the frontend.1
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

  console.log(`[${new Date().toISOString()}] Found ${completeFiles.length} complete building files`);

  const allBuildings: BuildingEntry[] = [];
  let totalCount = 0;

  for (const file of completeFiles) {
    const filePath = path.join(buildingDataDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const buildings: BuildingEntry[] = JSON.parse(content);
      allBuildings.push(...buildings);
      totalCount += buildings.length;
      console.log(`  ${file}: ${buildings.length} buildings`);
    } catch (error) {
      console.error(`  Failed to read ${file}: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Write the merged data
  fs.writeFileSync(outputPath, JSON.stringify(allBuildings, null, 2));
  console.log(`[${new Date().toISOString()}] Merged ${totalCount} buildings into ${outputPath}`);

  return allBuildings;
}

// Run the merge if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  mergeBuildings().catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}
