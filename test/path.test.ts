import axios from 'axios';
import { describe, it, expect, beforeAll } from 'vitest';

const SERVER_PORT = 3000;
const BASE_URL = `http://localhost:${SERVER_PORT}/mbus/api/v3`;

describe('API Endpoints', () => {
    beforeAll(async () => {
        try {
            // Check if server is running
            await axios.get(`${BASE_URL}/getAllPredictions`);
        } catch (error) {
            console.error('Server is not running! Please start the server with: npm start');
            process.exit(1);
        }
    });

    it('should get bus predictions and log stop IDs', async () => {
        try {
            const response = await axios.get(`${BASE_URL}/getAllPredictions`);
            expect(response.status).toBe(200);
            expect(Array.isArray(response.data)).toBe(true);
            
            // Extract and log unique stop IDs
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
            console.log('Available stop IDs:', stopIdsArray);
            expect(stopIdsArray.length).toBeGreaterThan(0);
        } catch (error) {
            if (axios.isAxiosError(error)) {
                console.error('Error fetching predictions:', error.message);
                if (error.response) {
                    console.error('Response status:', error.response.status);
                    console.error('Response data:', error.response.data);
                }
            }
            throw error;
        }
    });

    it('should get path between main stops', async () => {
        try {
            const response = await axios.get(`${BASE_URL}/plan-journey?origin=N428&destination=M309`);
            expect(response.status).toBe(200);
            console.log('Path M305 -> C211:', JSON.stringify(response.data, null, 2));
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

}); 