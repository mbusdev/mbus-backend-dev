import { Transfer, TransfersByOrigin } from '../raptor/types';

/** Directed stop-to-stop walking distances in meters (only reachable pairs). */
export type StopWalkMeters = Map<string, Map<string, number>>;

const METER_TOLERANCE = 1;

/**
 * ULTRA-style shortcut graph: transitive reduction on walking times.
 * Removes origin→dest when some intermediate stop yields an equal-or-better path.
 * Preserves all shortest-path walking distances (no quality loss for time-based walks).
 */
export function transitiveReductionShortcuts(
    stops: string[],
    durations: StopWalkMeters,
    toleranceMeters = METER_TOLERANCE
): StopWalkMeters {
    const shortcuts = new Map<string, Map<string, number>>();

    for (const origin of stops) {
        const outgoing = durations.get(origin);
        if (!outgoing) continue;

        for (const [dest, directMeters] of outgoing) {
            if (origin === dest) continue;

            let redundant = false;
            for (const mid of stops) {
                if (mid === origin || mid === dest) continue;
                const leg1 = durations.get(origin)?.get(mid);
                const leg2 = durations.get(mid)?.get(dest);
                if (leg1 == null || leg2 == null) continue;
                if (leg1 >= directMeters || leg2 >= directMeters) continue;
                if (leg1 + leg2 <= directMeters + toleranceMeters) {
                    redundant = true;
                    break;
                }
            }

            if (!redundant) {
                if (!shortcuts.has(origin)) shortcuts.set(origin, new Map());
                shortcuts.get(origin)!.set(dest, directMeters);
            }
        }
    }

    return shortcuts;
}

export function shortcutsToTransfers(
    shortcuts: StopWalkMeters,
    metersToDuration: (meters: number) => number
): TransfersByOrigin {
    const transfers: TransfersByOrigin = {};

    for (const [origin, outgoing] of shortcuts) {
        const list: Transfer[] = [];
        for (const [destination, meters] of outgoing) {
            list.push({
                origin,
                destination,
                duration: metersToDuration(meters),
                startTime: 0,
                endTime: Number.MAX_SAFE_INTEGER,
            });
        }
        if (list.length > 0) transfers[origin] = list;
    }

    return transfers;
}

export function countStopWalkEdges(graph: StopWalkMeters): number {
    let n = 0;
    for (const outgoing of graph.values()) n += outgoing.size;
    return n;
}
