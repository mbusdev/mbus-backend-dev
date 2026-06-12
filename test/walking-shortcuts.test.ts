import { describe, it, expect } from 'vitest';
import {
    transitiveReductionShortcuts,
    countStopWalkEdges,
    StopWalkMeters,
} from '../src/walking/walkingShortcuts';

function shortestWalkMeters(
    origin: string,
    dest: string,
    stops: string[],
    graph: StopWalkMeters
): number | undefined {
    if (origin === dest) return 0;

    const idx = new Map(stops.map((s, i) => [s, i]));
    const n = stops.length;
    const dist: number[][] = Array.from({ length: n }, () => Array(n).fill(Infinity));

    for (let i = 0; i < n; i++) dist[i][i] = 0;

    for (const [from, outgoing] of graph) {
        const i = idx.get(from);
        if (i == null) continue;
        for (const [to, meters] of outgoing) {
            const j = idx.get(to);
            if (j == null) continue;
            dist[i][j] = Math.min(dist[i][j], meters);
        }
    }

    for (let k = 0; k < n; k++) {
        for (let i = 0; i < n; i++) {
            if (!Number.isFinite(dist[i][k])) continue;
            for (let j = 0; j < n; j++) {
                if (!Number.isFinite(dist[k][j])) continue;
                const via = dist[i][k] + dist[k][j];
                if (via < dist[i][j]) dist[i][j] = via;
            }
        }
    }

    const oi = idx.get(origin);
    const di = idx.get(dest);
    if (oi == null || di == null) return undefined;
    const d = dist[oi][di];
    return Number.isFinite(d) ? d : undefined;
}

function shortcutsPreserveDistances(
    stops: string[],
    full: StopWalkMeters,
    shortcuts: StopWalkMeters,
    toleranceMeters = 1
): boolean {
    for (const origin of stops) {
        for (const dest of stops) {
            if (origin === dest) continue;
            const fullDist = shortestWalkMeters(origin, dest, stops, full);
            const shortDist = shortestWalkMeters(origin, dest, stops, shortcuts);
            if (fullDist == null && shortDist == null) continue;
            if (fullDist == null || shortDist == null) return false;
            if (Math.abs(fullDist - shortDist) > toleranceMeters) return false;
        }
    }
    return true;
}

function buildSampleGraph(): { stops: string[]; full: StopWalkMeters } {
    const stops = ['A', 'B', 'C', 'D'];
    const full: StopWalkMeters = new Map([
        ['A', new Map([['B', 100], ['C', 200]])],
        ['B', new Map([['A', 100], ['C', 100], ['D', 50]])],
        ['C', new Map([['A', 200], ['B', 100]])],
        ['D', new Map([['B', 50]])],
    ]);
    return { stops, full };
}

describe('walkingShortcuts', () => {
    it('removes transitively redundant edges while preserving shortest paths', () => {
        const { stops, full } = buildSampleGraph();
        const shortcuts = transitiveReductionShortcuts(stops, full);

        expect(shortcuts.get('A')?.has('C')).toBe(false);
        expect(shortcuts.get('A')?.get('B')).toBe(100);
        expect(shortcuts.get('B')?.get('C')).toBe(100);
        expect(shortcuts.get('D')?.get('B')).toBe(50);

        expect(shortcutsPreserveDistances(stops, full, shortcuts)).toBe(true);
    });

    it('reduces edge count on a hub graph', () => {
        const { stops, full } = buildSampleGraph();
        const shortcuts = transitiveReductionShortcuts(stops, full);
        expect(countStopWalkEdges(shortcuts)).toBeLessThan(countStopWalkEdges(full));
        expect(shortestWalkMeters('A', 'C', stops, shortcuts)).toBe(200);
    });

    it('keeps all edges when no hub shortcuts exist', () => {
        const stops = ['X', 'Y', 'Z'];
        const full: StopWalkMeters = new Map([
            ['X', new Map([['Y', 100]])],
            ['Y', new Map([['X', 100], ['Z', 100]])],
            ['Z', new Map([['Y', 100]])],
        ]);
        const shortcuts = transitiveReductionShortcuts(stops, full);
        expect(countStopWalkEdges(shortcuts)).toBe(countStopWalkEdges(full));
        expect(shortcutsPreserveDistances(stops, full, shortcuts)).toBe(true);
    });
});
