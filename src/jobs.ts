import { updateBusPositions, initializeRoutes, rebuildGraph } from './services/graphBuilder';
import { initializeReminders, processRideReminders, processUniversityReminders } from './services/reminder';

/**
 * Wraps an async job so overlapping runs are skipped: if the previous tick is
 * still in flight (e.g. a slow upstream API), the new tick is dropped instead
 * of piling up requests and letting a stale run overwrite fresher data.
 */
function nonOverlapping(name: string, job: () => Promise<void>): () => Promise<void> {
    let running = false;
    return async () => {
        if (running) {
            console.warn(`Job ${name} still running; skipping this tick`);
            return;
        }
        running = true;
        try {
            await job();
        } catch (e) {
            console.error(`Job ${name} failed`, e);
        } finally {
            running = false;
        }
    };
}

/**
 * Starts background jobs for updating bus positions, initializing routes, and rebuilding the graph.
 */
export function startBackgroundJobs() {
    initializeReminders();

    const guardedUpdatePositions = nonOverlapping('updateBusPositions', updateBusPositions);
    const guardedInitRoutes = nonOverlapping('initializeRoutes', initializeRoutes);
    const guardedRebuild = nonOverlapping('rebuildGraph', rebuildGraph);

    // The boot runs share the same guards as the interval ticks, so a slow
    // boot (e.g. cold walking cache) can never overlap — and stale-overwrite —
    // an interval run of the same job.
    guardedInitRoutes().then(() => {
        console.log("Routes initialized. Building initial graph...");
        return guardedRebuild();
    });

    setInterval(guardedUpdatePositions, 7500);
    setInterval(guardedInitRoutes, 60000);
    setInterval(guardedRebuild, 60 * 1000);
    setInterval(processUniversityReminders, 7500);
    setInterval(processRideReminders, 7500);

    console.log("Background jobs started.");
}
