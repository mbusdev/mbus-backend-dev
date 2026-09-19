import { describe, it, expect, afterAll } from 'vitest';
import { processOsmBuildings } from '@/services/building_checker';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Copy a real OSM asset to a temp file so processOsmBuildings doesn't
// overwrite the checked-in -complete.json.
const BOX3_SRC = path.resolve('./src/assets/buildings/box3.json');
const tmpInput = path.join(os.tmpdir(), `box3-test-${Date.now()}.json`);
const tmpOutput = tmpInput.replace('.json', '-complete.json');

fs.copyFileSync(BOX3_SRC, tmpInput);

afterAll(() => {
  for (const f of [tmpInput, tmpOutput]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe('processOsmBuildings (box3)', () => {
  // Run once; all tests share the output.
  processOsmBuildings(tmpInput);

  let results: any[];

  it('writes a valid JSON array', () => {
    expect(fs.existsSync(tmpOutput)).toBe(true);
    results = JSON.parse(fs.readFileSync(tmpOutput, 'utf-8'));
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it('every entry has required fields ID, lat, long, address', () => {
    results = JSON.parse(fs.readFileSync(tmpOutput, 'utf-8'));
    for (const entry of results) {
      expect(typeof entry.ID).toBe('string');
      expect(entry.ID.length).toBeGreaterThan(0);
      expect(typeof entry.lat).toBe('string');
      expect(typeof entry.long).toBe('string');
      expect(typeof entry.address).toBe('string');
      expect(entry.address.length).toBeGreaterThan(0);
    }
  });

  it('buildingName, when present, is a non-empty string', () => {
    results = JSON.parse(fs.readFileSync(tmpOutput, 'utf-8'));
    for (const entry of results) {
      if ('buildingName' in entry) {
        expect(typeof entry.buildingName).toBe('string');
        expect(entry.buildingName.length).toBeGreaterThan(0);
      }
    }
  });

  it('includes buildings that have no name (buildingName is optional)', () => {
    results = JSON.parse(fs.readFileSync(tmpOutput, 'utf-8'));
    const unnamed = results.filter((e: any) => !('buildingName' in e));
    expect(unnamed.length).toBeGreaterThan(0);
  });

  it('includes the known unnamed building at 800 Fuller Street', () => {
    results = JSON.parse(fs.readFileSync(tmpOutput, 'utf-8'));
    const entry = results.find((e: any) => e.address === '800 Fuller Street');
    expect(entry).toBeDefined();
    expect(entry.buildingName).toBeUndefined();
  });

  it('includes the named building Ann Arbor City Hall with correct address', () => {
    results = JSON.parse(fs.readFileSync(tmpOutput, 'utf-8'));
    const entry = results.find((e: any) => e.buildingName === 'Ann Arbor City Hall');
    expect(entry).toBeDefined();
    expect(entry.address).toBe('301 East Huron Street');
  });

  it('includes more buildings than the previous node-only pass (29)', () => {
    results = JSON.parse(fs.readFileSync(tmpOutput, 'utf-8'));
    expect(results.length).toBeGreaterThan(29);
  });
});
