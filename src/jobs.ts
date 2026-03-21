import { updateBusPositions, initializeRoutes, rebuildGraph } from './services/graphBuilder';
import { processRideReminders, processUniversityReminders } from './services/reminder';

/**
 * Starts background jobs for updating bus positions, initializing routes, and rebuilding the graph.
 */
export function startBackgroundJobs() {
    return;
    initializeRoutes().then(() => {
        console.log("Routes initialized. Building initial graph...");
        rebuildGraph();
    });

    setInterval(updateBusPositions, 7500);
    setInterval(initializeRoutes, 60000);
    setInterval(rebuildGraph, 60 * 1000);
    setInterval(processUniversityReminders, 7500);
    setInterval(processRideReminders, 7500);

    console.log("Background jobs started.");
}