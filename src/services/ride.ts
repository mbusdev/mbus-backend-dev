// COPY OF MBUS.TS BUT MODIFIED FOR THE RIDE

import axios from 'axios';
import * as process from "node:process";
import dotenv from "dotenv";
import { Pattern, PatternsArraySchema } from './bustimeCommon';

dotenv.config();

const RIDE_API_KEY = process.env.RIDE_API_KEY;
const BASE_URL = process.env.RIDE_URL || 'https://rt.theride.org/bustime/api/v3/';

const client = axios.create({
    baseURL: BASE_URL,
    params: { key: RIDE_API_KEY, format: 'json' }
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
        return PatternsArraySchema.parse(resData);
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
                    // theride doesn't seem to support unix timestamps so this doesn't do anything
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