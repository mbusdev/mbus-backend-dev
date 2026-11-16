import express from 'express';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { requireAuth } from './auth';

const DIR = process.env.FLOORPLANS_DIR || './data/floorplans';

/** A JSON response prepared once at startup, so a request only copies bytes. */
type Doc = { json: Buffer, gzip: Buffer, etag: string };

function prepare(value: unknown): Doc {
    const json = Buffer.from(JSON.stringify(value)); // minified: the source files are pretty-printed
    const etag = `W/"${crypto.createHash('sha1').update(json).digest('base64url')}"`;
    return { json, gzip: zlib.gzipSync(json, { level: 9 }), etag };
}

// One JSON file per building in FLOORPLANS_DIR, keyed by its `buildingId`. The files are not in git.
// A file that cannot be read is skipped so that it cannot take the bus API down with it.
const buildings = new Map<string, Doc>();
const summaries: { buildingId: string, building: string, floors: { id: string, name: string }[] }[] = [];
for (const file of fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => f.endsWith('.json')).sort() : []) {
    try {
        const plan = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
        if (typeof plan.buildingId !== 'string' || !Array.isArray(plan.floors)) throw new Error('missing buildingId or floors');
        buildings.set(plan.buildingId, prepare(plan));
        summaries.push({
            buildingId: plan.buildingId,
            building: plan.building,
            floors: plan.floors.map((f: { id: string, name: string }) => ({ id: f.id, name: f.name })),
        });
    } catch (err) {
        console.error(`Skipping floor plan ${file}: ${(err as Error).message}`);
    }
}
const index = prepare({ buildings: summaries });
console.log(`Loaded ${buildings.size} floor plan(s) from ${DIR}`);

function send(req: express.Request, res: express.Response, doc: Doc) {
    // The client may keep its copy but has to revalidate it; an unchanged plan is then answered with an empty 304.
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-cache', 'ETag': doc.etag, 'Vary': 'Accept-Encoding' });
    if (req.acceptsEncodings('gzip')) res.set('Content-Encoding', 'gzip').send(doc.gzip);
    else res.send(doc.json);
}

/**
 * Express router for floor plans, mounted at `/mbus/api/v3/floorplans`.
 *
 * Everything under this prefix requires a signed-in umich.edu user: the gate is on the router, so
 * every handler below it is protected. Never expose `FLOORPLANS_DIR` through `express.static`.
 */
const router = express.Router();
router.use(requireAuth);

/**
 * Lists the buildings that have floor plans.
 * @param req - Express request
 * @param res - Express response: `{ buildings: [{ buildingId, building, floors: [{ id, name }] }] }`
 */
export function getFloorplans(req: express.Request, res: express.Response) {
    send(req, res, index);
}
router.get('/', getFloorplans);

/**
 * Returns one building's floor plan, exactly as authored: every floor with its walls, rooms, POIs and nav graph.
 * @param req - Express request with the `buildingId` path param
 * @param res - Express response: the building's JSON document, or 404
 */
export function getFloorplan(req: express.Request, res: express.Response) {
    const doc = buildings.get(req.params.buildingId);
    if (!doc) return void res.status(404).json({ code: 'NOT_FOUND' });
    send(req, res, doc);
}
router.get('/:buildingId', getFloorplan);

export default router;
