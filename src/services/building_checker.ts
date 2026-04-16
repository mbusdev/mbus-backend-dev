import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import fs from 'fs';
import cron from 'node-cron';
import path from 'path';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_'
});

// API endpoints for OSM data
const box4Url = 'https://api.openstreetmap.org/api/0.6/map?bbox=-83.758000,42.281000,-83.748000,42.288000';
const box3Url = 'https://api.openstreetmap.org/api/0.6/map?bbox=-83.748000,42.281000,-83.737000,42.288000';
const box5Url = 'https://api.openstreetmap.org/api/0.6/map?bbox=-83.758000,42.272000,-83.748000,42.281000';
const box2Url = 'https://api.openstreetmap.org/api/0.6/map?bbox=-83.748000,42.272000,-83.737000,42.281000';
const box11aUrl = 'https://api.openstreetmap.org/api/0.6/map?bbox=-83.840304,42.281000,-83.799152,42.311535';
const box11bUrl = 'https://api.openstreetmap.org/api/0.6/map?bbox=-83.799152,42.281000,-83.758000,42.311535';
const box6aUrl = 'https://api.openstreetmap.org/api/0.6/map?bbox=-83.840304,42.215454,-83.799152,42.281000';
const box6bUrl = 'https://api.openstreetmap.org/api/0.6/map?bbox=-83.799152,42.215454,-83.758000,42.281000';
const box10Url = 'https://api.openstreetmap.org/api/0.6/map?bbox=-83.758000,42.298000,-83.675000,42.311535';
const box8aUrl = 'https://api.openstreetmap.org/api/0.6/map?bbox=-83.758000,42.288000,-83.737000,42.298000';
const box8bUrl = 'https://api.openstreetmap.org/api/0.6/map?bbox=-83.737000,42.281000,-83.700000,42.298000';
const box9Url = 'https://api.openstreetmap.org/api/0.6/map?bbox=-83.700000,42.281000,-83.675000,42.298000';
const box7aUrl = 'https://api.openstreetmap.org/api/0.6/map?bbox=-83.758000,42.215454,-83.7475,42.272000';
const box7cUrl = 'https://api.openstreetmap.org/api/0.6/map?bbox=-83.7475,42.215454,-83.737000,42.272000';
const box7bUrl = 'https://api.openstreetmap.org/api/0.6/map?bbox=-83.737000,42.215454,-83.706,42.281000';
const box7dUrl = 'https://api.openstreetmap.org/api/0.6/map?bbox=-83.706,42.215454,-83.675000,42.281000';
const box12Url = 'https://api.openstreetmap.org/api/0.6/map?bbox=-83.675000,42.235000,-83.645000,42.275000';
const box14aUrl = 'https://api.openstreetmap.org/api/0.6/map?bbox=-83.645000,42.235000,-83.59208,42.275000';
const box14bUrl = 'https://api.openstreetmap.org/api/0.6/map?bbox=-83.59208,42.235000,-83.539160,42.275000';
const box13aUrl = 'https://api.openstreetmap.org/api/0.6/map?bbox=-83.675000,42.215454,-83.60708,42.235000';
const box13bUrl = 'https://api.openstreetmap.org/api/0.6/map?bbox=-83.60708,42.215454,-83.539160,42.235000';

const urls = {
  box4: box4Url,
  box3: box3Url,
  box5: box5Url,
  box2: box2Url,
  box11a: box11aUrl,
  box11b: box11bUrl,
  box6a: box6aUrl,
  box6b: box6bUrl,
  box10: box10Url,
  box8a: box8aUrl,
  box8b: box8bUrl,
  box9: box9Url,
  box7a: box7aUrl,
  box7c: box7cUrl,
  box7b: box7bUrl,
  box7d: box7dUrl,
  box12: box12Url,
  box14a: box14aUrl,
  box14b: box14bUrl,
  box13a: box13aUrl,
  box13b: box13bUrl,
};


export async function updateBuildings() {
  const osmDataDir = './osm_data';
  const buildingDataDir = './src/assets/buildings';
  
  // Create directories if they don't exist
  if (!fs.existsSync(osmDataDir)) {
    fs.mkdirSync(osmDataDir, { recursive: true });
  }
  if (!fs.existsSync(buildingDataDir)) {
    fs.mkdirSync(buildingDataDir, { recursive: true });
  }

  for (const [name, url] of Object.entries(urls)) {
    console.log(`[${new Date().toISOString()}] Fetching ${name}...`);
    try {
      const response = await axios.get(url, { headers: { 'Accept': 'application/xml' } });
      const xmlData = response.data;
      const xmlSize = Buffer.byteLength(xmlData, 'utf-8');
      
      // Check if existing osm_data file exists and compare size
      const osmFilePath = path.join(osmDataDir, `${name}.json`);
      let shouldUpdate = true;
      
      if (fs.existsSync(osmFilePath)) {
        const existingContent = fs.readFileSync(osmFilePath, 'utf-8');
        const existingSize = Buffer.byteLength(existingContent, 'utf-8');
        
        console.log(`  Existing size: ${existingSize} bytes, New size: ${xmlSize} bytes`);
        
        // Only update if sizes differ
        if (existingSize === xmlSize) {
          console.log(`  Skipping ${name} - data size unchanged`);
          shouldUpdate = false;
        }
      }
      
      if (shouldUpdate) {
        // Parse XML to JSON
        const json = parser.parse(xmlData);
        
        // Save to osm_data directory
        fs.writeFileSync(osmFilePath, JSON.stringify(json, null, 2));
        console.log(`  Saved to ${osmFilePath}`);
        
        // Also save to building-data directory
        const buildingFilePath = path.join(buildingDataDir, `${name}.json`);
        fs.writeFileSync(buildingFilePath, JSON.stringify(json, null, 2));
        console.log(`  Saved to ${buildingFilePath}`);

        // Process and clean the building data into *-complete.json
        processOsmBuildings(buildingFilePath);
      }
    } catch (error) {
      if (error instanceof Error) {
      console.error(`  Failed to fetch ${name}: ${error.message}`);
      }
    }
    
    // Wait 1 minute between requests to avoid rate limiting
    const delayMs = 60000; // 1 minute
    console.log(`  Waiting ${delayMs / 1000} seconds before next request...`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  
  console.log(`[${new Date().toISOString()}] Completed building data sync`);
}


interface LocationAddress {
  house_number?: string;
  road?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
}

interface LocationEntry {
  osm_id: number;
  name: string;
  latitude: number;
  longitude: number;
  type: string;
  tags: Record<string, string>;
  address: LocationAddress;
}

async function reverseGeocode(lat: number, lon: number): Promise<LocationAddress> {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`;
  const response = await axios.get(url, {
    headers: { 'User-Agent': 'mbus-backend/1.0' }
  });
  const addr = response.data?.address || {};
  return {
    house_number: addr.house_number,
    road: addr.road,
    city: addr.city || addr.town || addr.village,
    state: addr.state,
    postcode: addr.postcode,
    country: addr.country,
  };
}

/**
 * Queries the Overpass API for named locations (amenity, shop, tourism, leisure, office)
 * within a bounding box. Missing address data is filled in via Nominatim reverse geocode.
 * Results are saved as a JSON array to outputPath.
 *
 * Bounding box format: (south, west, north, east)
 */
export async function fetchLocationsByBoundingBox(
  south: number,
  west: number,
  north: number,
  east: number,
  outputPath: string
): Promise<LocationEntry[]> {
  const query = `[out:json];
(
  node["amenity"](${south},${west},${north},${east});
  node["shop"](${south},${west},${north},${east});
  node["tourism"](${south},${west},${north},${east});
  node["leisure"](${south},${west},${north},${east});
  node["office"](${south},${west},${north},${east});
);
out body;`;

  console.log(`[${new Date().toISOString()}] Querying Overpass for bbox (${south},${west},${north},${east})...`);

  const response = await axios.post('https://overpass-api.de/api/interpreter', query, {
    headers: { 'Content-Type': 'text/plain' }
  });

  const elements: any[] = response.data.elements || [];
  console.log(`  Found ${elements.length} nodes`);

  const locations: LocationEntry[] = [];

  for (const el of elements) {
    const tags: Record<string, string> = el.tags || {};
    const name = tags['name'];
    if (!name) continue;

    const addrFromTags: LocationAddress = {
      house_number: tags['addr:housenumber'],
      road: tags['addr:street'],
      city: tags['addr:city'],
      state: tags['addr:state'],
      postcode: tags['addr:postcode'],
      country: tags['addr:country'],
    };

    let address = addrFromTags;

    if (!addrFromTags.road && !addrFromTags.house_number) {
      console.log(`  Reverse geocoding "${name}"...`);
      try {
        address = await reverseGeocode(el.lat, el.lon);
      } catch (err) {
        console.error(`  Failed to reverse geocode "${name}": ${err instanceof Error ? err.message : err}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const locationType = tags['amenity'] || tags['shop'] || tags['tourism'] || tags['leisure'] || tags['office'] || 'unknown';

    locations.push({
      osm_id: el.id,
      name,
      latitude: el.lat,
      longitude: el.lon,
      type: locationType,
      tags,
      address,
    });
  }

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify(locations, null, 2));
  console.log(`[${new Date().toISOString()}] Saved ${locations.length} locations to ${outputPath}`);

  return locations;
}


interface BuildingEntry {
  ID: string;
  lat: string;
  long: string;
  buildingName?: string;
  address: string;
}

/**
 * Reads a raw OSM .json file (as produced by updateBuildings), extracts nodes with
 * a valid street address, and writes a cleaned *-complete.json to the same directory.
 *
 * Mappings applied:
 *   @_id                          -> ID
 *   @_lat                         -> lat
 *   @_lon                         -> long
 *   tag[@_k="name"]               -> buildingName
 *   tag[@_k="addr:housenumber"]
 *     + tag[@_k="addr:street"]    -> address  (concatenated, e.g. "3711 Plaza Drive")
 *
 * Nodes without both addr:housenumber and addr:street are dropped.
 * Multiple nodes sharing the same @_id are merged into one entry.
 */
export function processOsmBuildings(inputFilePath: string): void {
  const raw = JSON.parse(fs.readFileSync(inputFilePath, 'utf-8'));
  const nodes: any[] = raw?.osm?.node ?? [];
  const ways: any[] = raw?.osm?.way ?? [];

  const byId = new Map<string, BuildingEntry>();

  // Build a node coordinate lookup for way centroid calculation
  const nodeLookup = new Map<string, { lat: string; lon: string }>();
  for (const node of nodes) {
    const nid: string = node['@_id'];
    const nlat: string = node['@_lat'];
    const nlon: string = node['@_lon'];
    if (nid && nlat && nlon) {
      nodeLookup.set(nid, { lat: nlat, lon: nlon });
    }
  }

  for (const node of nodes) {
    const id: string = node['@_id'];
    const lat: string = node['@_lat'];
    const lon: string = node['@_lon'];

    if (!id) continue;

    // tag may be a single object or an array depending on how many tags the node has
    const rawTag = node.tag;
    const tags: any[] = Array.isArray(rawTag) ? rawTag : rawTag ? [rawTag] : [];

    const tagMap: Record<string, string> = {};
    for (const t of tags) {
      if (t['@_k'] && t['@_v'] !== undefined) {
        tagMap[t['@_k']] = t['@_v'];
      }
    }

    const houseNumber = tagMap['addr:housenumber'];
    const street = tagMap['addr:street'];
    const name = tagMap['name'];
    const address = houseNumber && street ? `${houseNumber} ${street}` : undefined;

    if (byId.has(id)) {
      // Merge missing fields into the existing entry
      const existing = byId.get(id)!;
      if (!existing.buildingName && name) existing.buildingName = name;
      if (!existing.address && address) existing.address = address;
    } else {
      if (!lat || !lon) continue;
      byId.set(id, {
        ID: id,
        lat,
        long: lon,
        ...(name ? { buildingName: name } : {}),
        address: address ?? '',
      });
    }
  }

  // Process way elements (actual building footprints in OSM).
  // buildingName is optional — most buildings don't have one.
  for (const way of ways) {
    const id: string = way['@_id'];
    if (!id) continue;

    const rawTag = way.tag;
    const tags: any[] = Array.isArray(rawTag) ? rawTag : rawTag ? [rawTag] : [];

    const tagMap: Record<string, string> = {};
    for (const t of tags) {
      if (t['@_k'] && t['@_v'] !== undefined) {
        tagMap[t['@_k']] = t['@_v'];
      }
    }

    // Only process ways that are tagged as buildings
    if (!tagMap['building']) continue;

    const houseNumber = tagMap['addr:housenumber'];
    const street = tagMap['addr:street'];
    const name = tagMap['name'];
    const address = houseNumber && street ? `${houseNumber} ${street}` : undefined;

    // Compute centroid from referenced nodes
    const nds: any[] = Array.isArray(way.nd) ? way.nd : way.nd ? [way.nd] : [];
    const coords: { lat: number; lon: number }[] = [];
    for (const nd of nds) {
      const ref: string = nd['@_ref'];
      const nodeCoord = nodeLookup.get(ref);
      if (nodeCoord) {
        coords.push({ lat: parseFloat(nodeCoord.lat), lon: parseFloat(nodeCoord.lon) });
      }
    }

    if (coords.length === 0) continue;

    const avgLat = (coords.reduce((sum, c) => sum + c.lat, 0) / coords.length).toFixed(7);
    const avgLon = (coords.reduce((sum, c) => sum + c.lon, 0) / coords.length).toFixed(7);

    if (byId.has(id)) {
      const existing = byId.get(id)!;
      if (!existing.buildingName && name) existing.buildingName = name;
      if (!existing.address && address) existing.address = address;
    } else {
      byId.set(id, {
        ID: id,
        lat: avgLat,
        long: avgLon,
        ...(name ? { buildingName: name } : {}),
        address: address ?? '',
      });
    }
  }

  // Drop entries that ended up with no address
  const results = Array.from(byId.values()).filter(e => e.address);

  const dir = path.dirname(inputFilePath);
  const base = path.basename(inputFilePath, '.json');
  const outputPath = path.join(dir, `${base}-complete.json`);

  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`[${new Date().toISOString()}] Saved ${results.length} buildings to ${outputPath}`);
}


// Keep the process running
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  process.exit(0);
});




























