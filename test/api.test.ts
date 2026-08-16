import axios from 'axios';
import { describe, it, expect, beforeAll } from 'vitest';

const SERVER_PORT = 3000;
const BASE_URL = `http://localhost:${SERVER_PORT}/mbus/api/v3`;
const V4_BASE_URL = `http://localhost:${SERVER_PORT}/api/v4`;

describe('API Endpoints', () => {
    beforeAll(async () => {
        try {
            const response = await axios.get(`${BASE_URL}/getBusPositions`);
            console.log(`Server responded to /getBusPositions with status: ${response.status}`);
        } catch (error) {
            console.error('Server is not running! Please start the server with: `npm start` (or your equivalent command).');
            process.exit(1); // Exit if the server isn't reachable
        }
    });

    // --- Bus Positions and Predictions ---
    it('should get bus positions and confirm structure', async () => {
        const response = await axios.get(`${BASE_URL}/getBusPositions`);
        expect(response.status).toBe(200);
        expect(response.data).toHaveProperty('buses');
        expect(Array.isArray(response.data.buses)).toBe(true);
        console.log(`GET /getBusPositions: ${response.data.buses.length} buses found.`);
    });

    it('should get vehicle positions (alias for bus positions) and confirm structure', async () => {
        const response = await axios.get(`${BASE_URL}/getVehiclePositions`);
        expect(response.status).toBe(200);
        expect(response.data).toHaveProperty('buses');
        expect(Array.isArray(response.data.buses)).toBe(true);
        console.log(`GET /getVehiclePositions: ${response.data.buses.length} vehicles found.`);
    });

    it('should get selectable routes and confirm structure', async () => {
        const response = await axios.get(`${BASE_URL}/getSelectableRoutes`);
        expect(response.status).toBe(200);
        expect(response.data).toHaveProperty('bustime-response');
        expect(response.data['bustime-response']).toHaveProperty('routes');
        expect(Array.isArray(response.data['bustime-response'].routes)).toBe(true);
        console.log(`GET /getSelectableRoutes: ${response.data['bustime-response'].routes.length} routes found.`);
    });

    it('should get all cached routes and confirm structure (mb2 legacy)', async () => {
        const response = await axios.get(`${BASE_URL}/getAllRoutes`);
        expect(response.status).toBe(200);
        expect(response.data).toHaveProperty('routes');
        expect(typeof response.data.routes).toBe('object'); // cachedRoutes is an object, not array
        console.log(`GET /getAllRoutes: ${Object.keys(response.data.routes).length} cached routes found.`);
    });

    it('should get all cached routes and confirm structure', async () => {
        const response = await axios.get(`${V4_BASE_URL}/getAllMbusRoutes`);
        expect(response.status).toBe(200);
        expect(typeof response.data).toBe('object'); // should be array
        console.log(`GET /getAllMbusRoutes: ${Object.keys(response.data).length} cached routes found.`);
    });

    it('should get all bus predictions and log stop IDs', async () => {
        try {
            const response = await axios.get(`${BASE_URL}/getAllPredictions`);
            expect(response.status).toBe(200);
            expect(Array.isArray(response.data)).toBe(true);

            // Extract and log unique stop IDs for potential use in other tests
            const stopIds = new Set<string>();
            response.data.forEach((bus: any) => {
                if (bus.stops && Array.isArray(bus.stops)) {
                    bus.stops.forEach((stop: any) => {
                        if (stop.stpid) {
                            stopIds.add(stop.stpid);
                        }
                    });
                }
            });

            const stopIdsArray = Array.from(stopIds);
            console.log('Available stop IDs (from getAllPredictions):', stopIdsArray.slice(0, 5), '...'); // Log first 5
            expect(stopIdsArray.length).toBeGreaterThan(0);


        } catch (error) {
            if (axios.isAxiosError(error)) {
                console.error('Error fetching all predictions:', error.message);
                if (error.response) {
                    console.error('Response status:', error.response.status);
                    console.error('Response data:', error.response.data);
                }
            }
            throw error;
        }
    });

    it('should get predictions for a specific stop ID (if available)', async () => {
        const testStopId = 'M313';
        const response = await axios.get(`${BASE_URL}/getStopPredictions/${testStopId}`);
        expect(response.status).toBe(200);
        expect(response.data).toHaveProperty('bustime-response');
        expect(response.data['bustime-response']).toHaveProperty('prd');
        expect(Array.isArray(response.data['bustime-response'].prd)).toBe(true);
        console.log(`GET /getStopPredictions/${testStopId}: ${response.data['bustime-response'].prd.length} predictions found.`);
    });

    it('should get predictions for a specific bus ID (if available)', async () => {
        const testBusId = '341';
        const response = await axios.get(`${BASE_URL}/getBusPredictions/${testBusId}`);
        expect(response.status).toBe(200);
        expect(response.data).toHaveProperty('bustime-response');
        expect(response.data['bustime-response']).toHaveProperty('prd');
        expect(Array.isArray(response.data['bustime-response'].prd)).toBe(true);
        console.log(`GET /getBusPredictions/${testBusId}: ${response.data['bustime-response'].prd.length} predictions found.`);
    });

    it('should get route information', async () => {
        const response = await axios.get(`${BASE_URL}/getRouteInformation`);
        expect(response.status).toBe(200);
        expect(response.data).toHaveProperty('routeIdToName');
        expect(response.data).toHaveProperty('routeImages');
        expect(response.data).toHaveProperty('metadata');
        expect(response.data).toHaveProperty('routeColors');
        console.log(`GET /getRouteInformation: Contains ${Object.keys(response.data.routeIdToName).length} routes.`);
    });

    it('should get all stops', async () => {
        const response = await axios.get(`${BASE_URL}/getAllStops`);
        expect(response.status).toBe(200);
        expect(typeof response.data).toBe('object'); // Expected to be an object (map of stop IDs to info)
        expect(Object.keys(response.data).length).toBeGreaterThan(0);
        console.log(`GET /getAllStops: ${Object.keys(response.data).length} stops found.`);
    });

    it('should get building locations (assuming it serves a JSON file)', async () => {
        const response = await axios.get(`${BASE_URL}/getBuildingLocations`);
        expect(response.status).toBe(200);
        // Expect a JSON response or file content based on your server's sending
        expect(typeof response.data).toBe('object');
        console.log('GET /getBuildingLocations: Data received (check your console for content).');
    });

    it('should get startup messages', async () => {
        const response = await axios.get(`${BASE_URL}/get-startup-messages`);
        expect(response.status).toBe(200);
        expect(response.data).toHaveProperty('id');
        expect(response.data).toHaveProperty('title');
        expect(response.data).toHaveProperty('message');
        console.log(`GET /get-startup-messages: "${response.data.title}"`);
    });

    // --- Image Endpoint ---
    it('should get a vehicle image for a valid route', async () => {
        const testRoute = 'CN';
        const response = await axios.get(`${BASE_URL}/getVehicleImage/${testRoute}`, { responseType: 'arraybuffer' }); // Expect binary data
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toMatch(/image\/(png|jpeg)/); // Adjust based on actual image type
        expect(response.data.byteLength).toBeGreaterThan(0);
        console.log(`GET /getVehicleImage/${testRoute}: Image received, size ${response.data.byteLength} bytes.`);
    });

    it('should return 400 for an invalid vehicle image route', async () => {
        const invalidRoute = 'INVALID_ROUTE';
        try {
            await axios.get(`${BASE_URL}/getVehicleImage/${invalidRoute}`);
            expect.fail('Expected GET /getVehicleImage to return 400 for an invalid route, but it succeeded.');
        } catch (error) {
            if (axios.isAxiosError(error) && error.response) {
                expect(error.response.status).toBe(400);
                console.log(`GET /getVehicleImage/${invalidRoute}: Correctly returned 400.`);
            } else {
                throw error; // Re-throw other unexpected errors
            }
        }
    });

    // --- Journey Planning ---
    it('should get path between main stops', async () => {
        try {
            const response = await axios.get(`${BASE_URL}/plan-journey?originLat=42.264356&originLon=-83.744353999999&destLat=42.268067999999&destLon=-83.747307000001`);
            expect(response.status).toBe(200);
            expect(response.data).toHaveProperty('journeys');
            expect(Array.isArray(response.data.journeys)).toBe(true);
            // console.log('GET /plan-journey (test 1):', JSON.stringify(response.data.journeys, null, 2));

            const response2 = await axios.get(`${BASE_URL}/plan-journey?originLat=42.27389558&originLon=-83.73739576&destLat=42.29303061&destLon=-83.7163671`);
            expect(response2.status).toBe(200);
            expect(response2.data).toHaveProperty('journeys');
            expect(Array.isArray(response2.data.journeys)).toBe(true);
            // console.log('GET /plan-journey (test 2):', JSON.stringify(response2.data.journeys, null, 2));
        } catch (error) {
            if (axios.isAxiosError(error)) {
                console.error('Error fetching path:', error.message);
                if (error.response) {
                    console.error('Response status:', error.response.status);
                    console.error('Response data:', error.response.data);
                }
            }
            throw error;
        }
    });

    it('should return 400 for missing coordinates in plan-journey', async () => {
        try {
            await axios.get(`${BASE_URL}/plan-journey?originLat=42.264356&originLon=-83.744353999999`); // Missing destLat, destLon
            expect.fail('Expected plan-journey to return 400 for missing parameters, but it succeeded.');
        } catch (error) {
            if (axios.isAxiosError(error) && error.response) {
                expect(error.response.status).toBe(400);
                expect(error.response.data).toHaveProperty('error');
                expect(error.response.data.error).toContain('invalid query params');
                console.log('GET /plan-journey (missing params): Correctly returned 400.');
            } else {
                throw error;
            }
        }
    });
});