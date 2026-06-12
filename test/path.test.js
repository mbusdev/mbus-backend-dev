var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import axios from 'axios';
import { describe, it, expect, beforeAll } from 'vitest';
const SERVER_PORT = 3000;
const BASE_URL = `http://localhost:${SERVER_PORT}/mbus/api/v3`;
describe('API Endpoints', () => {
    beforeAll(() => __awaiter(void 0, void 0, void 0, function* () {
        try {
            yield axios.get(`${BASE_URL}/getAllPredictions`);
        }
        catch (error) {
            console.error('Server is not running! Please start the server with: npm start');
            process.exit(1);
        }
    }));
    it('should get bus predictions and log stop IDs', () => __awaiter(void 0, void 0, void 0, function* () {
        try {
            const response = yield axios.get(`${BASE_URL}/getAllPredictions`);
            expect(response.status).toBe(200);
            expect(Array.isArray(response.data)).toBe(true);
            // Extract and log unique stop IDs
            const stopIds = new Set();
            response.data.forEach((bus) => {
                if (bus.stops && Array.isArray(bus.stops)) {
                    bus.stops.forEach((stop) => {
                        if (stop.stpid) {
                            stopIds.add(stop.stpid);
                        }
                    });
                }
            });
            const stopIdsArray = Array.from(stopIds);
            console.log('Available stop IDs:', stopIdsArray);
            expect(stopIdsArray.length).toBeGreaterThan(0);
        }
        catch (error) {
            if (axios.isAxiosError(error)) {
                console.error('Error fetching predictions:', error.message);
                if (error.response) {
                    console.error('Response status:', error.response.status);
                    console.error('Response data:', error.response.data);
                }
            }
            throw error;
        }
    }));
    it('should get path between main stops', () => __awaiter(void 0, void 0, void 0, function* () {
        try {
            // Test path from one location to another using coordinates
            const response = yield axios.get(`${BASE_URL}/plan-journey?originLat=42.264356&originLon=-83.744353999999&destLat=42.268067999999&destLon=-83.747307000001`);
            expect(response.status).toBe(200);
            console.log('Path test 1:', JSON.stringify(response.data, null, 2));
            // Test another path with different coordinates
            // const response2 = await axios.get(`${BASE_URL}/plan-journey?originLat=42.277682&originLon=-83.734936&destLat=42.290425&destLon=-83.718150999999`);
            const response2 = yield axios.get(`${BASE_URL}/plan-journey?originLat=42.27389558&originLon=-83.73739576&destLat=42.29303061&destLon=-83.7163671?walkingPenalty=8`);
            expect(response2.status).toBe(200);
            console.log('Path test 2:', JSON.stringify(response2.data, null, 2));
        }
        catch (error) {
            if (axios.isAxiosError(error)) {
                console.error('Error fetching path:', error.message);
                if (error.response) {
                    console.error('Response status:', error.response.status);
                    console.error('Response data:', error.response.data);
                }
            }
            throw error;
        }
    }));
});
