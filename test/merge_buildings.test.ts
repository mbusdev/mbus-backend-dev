import fs from 'fs/promises';
import path from 'path';
import { describe, expect, it, beforeAll } from 'vitest';
import { mergeBuildings } from '../src/services/merge_buildings';

describe('mergeBuildings', () => {
  const buildingDataDir = path.join(process.cwd(), 'src/assets/buildings');
  const outputPath = path.join(buildingDataDir, 'merged-buildings.json');

  beforeAll(async () => {
    try {
      await fs.unlink(outputPath);
    } catch {
      // ignore if the file does not exist
    }
  });

  it('runs the merger and writes merged-buildings.json', async () => {
    const merged = await mergeBuildings();

    expect(Array.isArray(merged)).toBe(true);
    expect(merged.length).toBeGreaterThanOrEqual(0);

    if (merged.length > 0) {
      expect(merged[0]).toEqual(
        expect.objectContaining({
          ID: expect.any(String),
          address: expect.any(String),
          lat: expect.any(String),
          long: expect.any(String),
        }),
      );
    }

    const writtenContents = await fs.readFile(outputPath, 'utf-8');
    const parsed = JSON.parse(writtenContents);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toEqual(merged.length);
  });
});
