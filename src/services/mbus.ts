import axios from 'axios';
import * as process from "node:process";
import dotenv from "dotenv";
import { Pattern, PatternsArraySchema } from './bustimeTypes';

dotenv.config();

const API_KEY = process.env.MBUS_API_KEY;
const BASE_URL = process.env.MBUS_URL || 'https://mbus.ltp.umich.edu/bustime/api/v3/';

const client = axios.create({
    baseURL: BASE_URL,
    params: { key: API_KEY, format: 'json' }
});

/** Fetches vehicle positions for the given routes. */
export async function fetchVehicles(routes: string[]) {
    const chunks = [];
    for (let i = 0; i < routes.length; i += 10) chunks.push(routes.slice(i, i + 10));

    const promises = chunks.map(async chunk => {
        try {
            const res = await client.get('/getvehicles', {
                params: { requestType: 'getvehicles', rt: chunk.join(',') },
            });
            return res.data['bustime-response']?.vehicle || [];
        } catch (e) {
            console.warn('Fetch vehicles failed', e);
            return [];
        }
    });
    const results = await Promise.all(promises);
    return results.flat();
}

/** Fetches all available routes. */
export async function fetchRoutes() {
    try {
        const res = await client.get('/getroutes', { params: { requestType: 'getroutes' } });
        return res.data['bustime-response']?.routes || [];
    } catch (e) {
        console.error("Fetch Routes failed", e);
        return [];
    }
}

/** Fetches route patterns (path points) for a specific route. */
export async function fetchPatterns(rt: string): Promise<Pattern[]> {
    try {
        const res = await client.get('/getpatterns', {
            params: { requestType: 'getpatterns', rt: rt, rtpidatafeed: 'bustime' }
        });
        const resData = res.data['bustime-response']?.ptr as unknown;
        const patterns = PatternsArraySchema.parse(resData);
        return patterns;
    } catch (e) {
        console.error("Fetch Patterns failed", e);
        return [];
    }
}

/** Fetches predictions for multiple stop IDs. */
export async function fetchPredictions(stopIds: string[], routes: string[]) {
    const chunks = [];
    for (let i = 0; i < stopIds.length; i += 10) chunks.push(stopIds.slice(i, i + 10));

    const promises = chunks.map(async chunk => {
        try {
            const res = await client.get('/getpredictions', {
                params: {
                    requestType: 'getpredictions',
                    stpid: chunk.join(','),
                    rt: routes.join(','),
                    tmres: 's',
                    unixTime: true,
                }
            });
            return res.data;
        } catch (e) {
            return [];
        }
    });

    return Promise.all(promises);
}