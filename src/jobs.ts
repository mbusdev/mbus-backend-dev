import { updateBusPositions, initializeRoutes, rebuildGraph } from './services/graphBuilder';
import { processRideReminders, processUniversityReminders } from './services/reminder';
import { updateBuildings } from './services/building_checker';
import { mergeBuildings } from './services/merge_buildings';
import cron from 'node-cron';
/**
 * Starts background jobs for updating bus positions, initializing routes, and rebuilding the graph.
 */
export function startBackgroundJobs() {
    initializeRoutes().then(() => {
        console.log("Routes initialized. Building initial graph...");
        rebuildGraph();
    });

    const one_week = 7 * 24 * 60 * 60 * 1000;
    setInterval(updateBusPositions, 7500 /* 7.5 seconds */);
    setInterval(initializeRoutes, 60 * 1000 /* 60 seconds */);
    setInterval(rebuildGraph, 60 * 1000);
    setInterval(processUniversityReminders, 7500 /* 7.5 seconds */);
    setInterval(processRideReminders, 7500 /* 7.5 seconds */);
    
    // Schedule: 0 mins, 3 hours (3 AM), any day of month, any month, 0 (Sunday)
    cron.schedule('0 3 * * 0', () => {
        console.log("Running Sunday 3 AM maintenance task...");
        updateBuildings().then(() => {
            console.log("Buildings extracted. Ready to prepare file.");
            mergeBuildings();
        });
        
    }, {
        timezone: "America/New_York" // Critical: Set your local timezone
    });
    

    console.log("Background jobs started.");
}

