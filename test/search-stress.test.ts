import axios from 'axios';
import { describe, it, expect, beforeAll } from 'vitest';

const SERVER_PORT = 3000;
const BASE_URL = `http://localhost:${SERVER_PORT}/mbus/api/v3`;

describe('Stress Test Pathing Endpoint', () => {
    beforeAll(async () => {
        try {
            await axios.get(`${BASE_URL}/getAllPredictions`);
        } catch (error) {
            console.error('Server is not running! Please start the server with: npm start');
            process.exit(1);
        }
    });

    it('should handle many concurrent /plan-journey requests', async () => {
        const numRequests = 50; // adjust for desired stress level
        const origin = { lat: 42.264356, lon: -83.744354 };
        const destination = { lat: 42.268068, lon: -83.747307 };

        // Generate multiple unique request URLs (could vary coordinates slightly)
        const requests = Array.from({ length: numRequests }, (_, i) => {
            const offset = i * 0.0001;
            const originLat = origin.lat + offset;
            const originLon = origin.lon + offset;
            const destLat = destination.lat + offset;
            const destLon = destination.lon + offset;

            const url = `${BASE_URL}/plan-journey?originLat=${originLat}&originLon=${originLon}&destLat=${destLat}&destLon=${destLon}`;
            return axios.get(url)
                .then(response => {
                    expect(response.status).toBe(200);
                    return response.data;
                })
                .catch(error => {
                    console.error(`Request ${i + 1} failed:`, error.message);
                    if (error.response) {
                        console.error('Response status:', error.response.status);
                    }
                    throw error;
                });
        });

        const start = Date.now();
        try {
            const responses = await Promise.all(requests);
            const duration = Date.now() - start;
            console.log(`✅ All ${numRequests} requests completed in ${duration}ms`);
        } catch (error) {
            console.error('❌ Some requests failed during stress test.');
            throw error;
        }
    }, 40000); // Optional: increase timeout for stress test
});
