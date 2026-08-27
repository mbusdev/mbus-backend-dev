import * as process from "node:process";
import dotenv from "dotenv";
import { createBusTimeClient } from './bustimeClient';

dotenv.config();

const api = createBusTimeClient({
    baseURL: process.env.RIDE_URL || 'https://rt.theride.org/bustime/api/v3/',
    apiKey: process.env.RIDE_API_KEY,
    label: 'ride',
});

export const fetchVehicles = api.fetchVehicles;
export const fetchRoutes = api.fetchRoutes;
export const fetchPatterns = api.fetchPatterns;
export const fetchPredictions = api.fetchPredictions;
