import * as process from "node:process";
import dotenv from "dotenv";
import { createBusTimeClient } from './bustimeClient';

dotenv.config();

const api = createBusTimeClient({
    baseURL: process.env.MBUS_URL || 'https://mbus.ltp.umich.edu/bustime/api/v3/',
    apiKey: process.env.MBUS_API_KEY,
    label: 'mbus',
});

export const fetchVehicles = api.fetchVehicles;
export const fetchRoutes = api.fetchRoutes;
export const fetchPatterns = api.fetchPatterns;
export const fetchPredictions = api.fetchPredictions;
