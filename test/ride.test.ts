import axios from 'axios';
import { describe, it, expect } from 'vitest';

const SERVER_PORT = 3000;
const BASE_URL = `http://localhost:${SERVER_PORT}/mbus/api/v3`;
const V4_BASE_URL = `http://localhost:${SERVER_PORT}/api/v4`;

describe('The Ride (AAATA) API Endpoints', () => {

    // --- Ride Positions ---
    it('should get Ride bus positions', async () => {
        const response = await axios.get(`${BASE_URL}/getRidePositions`);
        expect(response.status).toBe(200);
        // Based on getBusPositions, we expect a similar structure, usually { buses: [...] }
        // or just the raw object from state.curRidePositions
        expect(typeof response.data).toBe('object');
        
        // If the structure matches MBus:
        if (response.data.buses) {
            expect(Array.isArray(response.data.buses)).toBe(true);
            console.log(`GET /getRidePositions: ${response.data.buses.length} Ride buses found.`);
        } else {
            console.log('GET /getRidePositions: Data received', Object.keys(response.data));
        }
    });

    // --- Ride Routes ---
    it('should get all Ride routes (mb2 legacy)', async () => {
        const response = await axios.get(`${BASE_URL}/getAllRideRoutes`);
        expect(response.status).toBe(200);
        expect(response.data).toHaveProperty('routes');
        expect(typeof response.data.routes).toBe('object');
        
        const routeCount = Object.keys(response.data.routes).length;
        console.log(`GET /getAllRideRoutes: ${routeCount} Ride routes found.`);
        expect(routeCount).toBeGreaterThanOrEqual(0);
    });

    it('should get all Ride routes', async () => {
        const response = await axios.get(`${V4_BASE_URL}/getAllRideRoutes`);
        expect(response.status).toBe(200);
        expect(typeof response.data).toBe('object');
        
        const routeCount = Object.keys(response.data).length;
        console.log(`GET /getAllRideRoutes: ${routeCount} Ride routes found.`);
        expect(routeCount).toBeGreaterThanOrEqual(0);
    });

    // --- Ride Stops ---
    it('should get all Ride stops', async () => {
        const response = await axios.get(`${BASE_URL}/getAllRideStops`);
        expect(response.status).toBe(200);
        expect(Array.isArray(response.data)).toBe(true);
        
        console.log(`GET /getAllRideStops: ${response.data.length} Ride stops found.`);
        
        // Check structure of a stop if array is not empty
        if (response.data.length > 0) {
            expect(response.data[0]).toHaveProperty('stpid');
            expect(response.data[0]).toHaveProperty('lat');
            expect(response.data[0]).toHaveProperty('lon');
        }
    });

    // --- Ride Predictions (By Stop) ---
    it('should get predictions for a specific Ride stop ID', async () => {
        // 1. Fetch all stops first to get a valid ID
        const stopsRes = await axios.get(`${BASE_URL}/getAllRideStops`);
        
        if (stopsRes.data.length > 0) {
            // Pick the first available stop ID
            const testStopId = stopsRes.data[0].stpid;
            
            // 2. Test the prediction endpoint with that ID
            const response = await axios.get(`${BASE_URL}/getRideStopPredictions/${testStopId}`);
            
            expect(response.status).toBe(200);
            expect(response.data).toHaveProperty('bustime-response');
            expect(response.data['bustime-response']).toHaveProperty('prd');
            
            // Note: The Ride API often returns an empty array if no bus is coming, 
            // but the structure should still hold.
            const preds = response.data['bustime-response'].prd;
            expect(Array.isArray(preds)).toBe(true);
            console.log(`GET /getRideStopPredictions/${testStopId}: ${preds.length} predictions found.`);
        } else {
            console.warn('Skipping /getRideStopPredictions test: No Ride stops available to query.');
        }
    });

    // --- Ride Predictions (By Bus/Vehicle) ---
    it('should get predictions for a specific Ride bus ID', async () => {
        // 1. Fetch positions to find an active bus
        const posRes = await axios.get(`${BASE_URL}/getRidePositions`);
        let testBusId = '9999'; // Default dummy ID
        
        // Attempt to find a real bus ID
        if (posRes.data.buses && posRes.data.buses.length > 0) {
            testBusId = posRes.data.buses[0].id || posRes.data.buses[0].vid;
        }

        const response = await axios.get(`${BASE_URL}/getRidePredictions/${testBusId}`);
        expect(response.status).toBe(200);
        expect(response.data).toHaveProperty('bustime-response');
        expect(response.data['bustime-response']).toHaveProperty('prd');
        
        const preds = response.data['bustime-response'].prd;
        expect(Array.isArray(preds)).toBe(true);
        console.log(`GET /getRidePredictions/${testBusId}: ${preds.length} predictions found.`);
    });

    // --- Key Stops Configuration ---
    it('should get key stops configuration', async () => {
        const response = await axios.get(`${BASE_URL}/get-key-stops`);
        expect(response.status).toBe(200);
        expect(typeof response.data).toBe('object');
        
        // Verify a known key stop exists (from source code)
        expect(response.data).toHaveProperty('C250');
        expect(response.data['C250']).toBe('Central Campus Transit Center');
        
        console.log(`GET /get-key-stops: Configuration retrieved successfully.`);
    });

    // --- Nearest Stops (Utility) ---
    it('should calculate nearest stops', async () => {
        // Coordinates for Central Campus Transit Center roughly
        const lat = 42.2745;
        const lon = -83.7345;
        const k = 3;

        const response = await axios.get(`${BASE_URL}/nearest-stops?lat=${lat}&lon=${lon}&k=${k}`);
        
        expect(response.status).toBe(200);
        expect(response.data).toHaveProperty('nearestStops');
        expect(Array.isArray(response.data.nearestStops)).toBe(true);
        expect(response.data.nearestStops.length).toBeLessThanOrEqual(k);
        
        console.log(`GET /nearest-stops: Found ${response.data.nearestStops.length} stops near ${lat}, ${lon}.`);
    });
});