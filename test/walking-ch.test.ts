import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeAll } from 'vitest';
import { loadMap } from '../src/walking/loadMap';
import * as chRouter from '../src/walking/contractionHierarchy';
import { __computeDijkstraAll } from '../src/walking/walkingMap';

const CH_FILE = path.resolve(process.cwd(), 'src/assets/ann_arbor.ch.json');
const chAvailable = fs.existsSync(CH_FILE);

/** Sample node pairs spread across the Ann Arbor walking graph. */
function sampleNodePairs(graph: Map<string, unknown>, count = 12): [string, string][] {
    const ids = [...graph.keys()];
    const pairs: [string, string][] = [];
    const step = Math.max(1, Math.floor(ids.length / count));
    for (let i = 0; i < ids.length - step && pairs.length < count; i += step) {
        pairs.push([ids[i], ids[i + step]]);
    }
    if (pairs.length < 2 && ids.length >= 2) {
        pairs.push([ids[0], ids[ids.length - 1]]);
    }
    return pairs;
}

describe.skipIf(!chAvailable)('Contraction hierarchy walking', () => {
    beforeAll(() => {
        chRouter.loadContractionHierarchy();
    });

    it('loads CH and reports routing mode', () => {
        expect(chRouter.isChLoaded()).toBe(true);
    });

    it('CH distances match Dijkstra within 1m on sample pairs', () => {
        const { graph } = loadMap();
        const pairs = sampleNodePairs(graph);

        for (const [start, end] of pairs) {
            const dijkstra = __computeDijkstraAll(start, new Set([end])).get(end);
            const ch = chRouter.queryDistance(start, end);

            expect(dijkstra, `missing Dijkstra for ${start} -> ${end}`).toBeDefined();
            expect(ch, `missing CH for ${start} -> ${end}`).not.toBeNull();

            if (dijkstra === undefined || ch == null) continue;
            expect(Math.abs(dijkstra - ch)).toBeLessThanOrEqual(1);
        }
    });

    it('returns null for disconnected or unknown nodes', () => {
        expect(chRouter.queryDistance('nonexistent-node-a', 'nonexistent-node-b')).toBeNull();
    });

    it('PHAST batch distances match Dijkstra within 1m', () => {
        const { graph } = loadMap();
        const ids = [...graph.keys()];
        const step = Math.max(1, Math.floor(ids.length / 80));
        const targets = new Set<string>();
        for (let i = step; i < ids.length && targets.size < 40; i += step) {
            targets.add(ids[i]);
        }
        const origin = ids[0];

        const dijkstra = __computeDijkstraAll(origin, targets);
        const phast = chRouter.queryDistancesFromOrigin(origin, targets);
        expect(phast).not.toBeNull();

        for (const t of targets) {
            const d = dijkstra.get(t);
            const p = phast!.get(t);
            expect(d, `missing Dijkstra for ${origin} -> ${t}`).toBeDefined();
            expect(p, `missing PHAST for ${origin} -> ${t}`).toBeDefined();
            if (d === undefined || p === undefined) continue;
            expect(Math.abs(d - p)).toBeLessThanOrEqual(1);
        }
    });
});

describe('Contraction hierarchy asset', () => {
    it('documents how to build CH when asset is missing', () => {
        if (chAvailable) {
            expect(fs.statSync(CH_FILE).size).toBeGreaterThan(0);
            return;
        }
        console.warn(
            'Skipping CH validation — run npm run build:walking-ch to generate src/assets/ann_arbor.ch.json'
        );
    });
});
