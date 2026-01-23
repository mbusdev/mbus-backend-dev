import { updateBusPositions, initializeRoutes, rebuildGraph } from './services/graphBuilder';
import { processReminders } from './services/reminder';

/**
 * Starts background jobs for updating bus positions, initializing routes, and rebuilding the graph.
 */
export function startBackgroundJobs() {
    initializeRoutes().then(() => {
        console.log("Routes initialized. Building initial graph...");
        rebuildGraph();
    });

    setInterval(updateBusPositions, 7500);
    setInterval(initializeRoutes, 60000);
    setInterval(rebuildGraph, 60 * 1000);
    setInterval(processReminders, 7500);

    console.log("Background jobs started.");
}