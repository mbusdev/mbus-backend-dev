import axios from 'axios';

/**
 * BusTime reports many failures as HTTP 200 with a bustime-response.error
 * array. Per-stop/per-route entries ("No arrival times", "No data found for
 * parameter") carry an identifying field (stpid/vid/rt) and are normal parts
 * of a healthy response. A SYSTEM error (invalid API key, daily transaction
 * limit exceeded) has only a msg and means the whole request failed — treating
 * it as an empty-but-successful response would wipe live caches downstream.
 *
 * Any HTTP-200 body that is not a well-formed BusTime envelope at all (a
 * proxy maintenance HTML page, an empty object, a non-array error field) is
 * also a system failure: an out-of-protocol response must never be mistaken
 * for "no buses".
 */
export function hasBusTimeSystemError(data: any): boolean {
    const envelope = data?.['bustime-response'];
    if (envelope === null || typeof envelope !== 'object') return true;
    const errors = envelope.error;
    if (errors === undefined) return false;
    if (!Array.isArray(errors)) return true;
    return errors.some((e: any) => e && !e.stpid && !e.vid && !e.rt);
}

export interface BusTimeClient {
    /** Returns null when any chunk fails (network or system error), so callers
     *  keep their previous data instead of mistaking failure for "no vehicles". */
    fetchVehicles(routes: string[]): Promise<any[] | null>;
    fetchRoutes(): Promise<any[]>;
    fetchPatterns(rt: string): Promise<any[]>;
    /** Failed chunks resolve to null so callers can detect partial failures. */
    fetchPredictions(stopIds: string[], routes: string[]): Promise<any[]>;
}

/**
 * Shared BusTime v3 API client. The UM (mbus) and TheRide feeds speak the same
 * protocol; parametrizing here keeps chunking, timeouts, and failure contracts
 * in exactly one place instead of two drifting copies.
 */
export function createBusTimeClient(options: { baseURL: string, apiKey: string | undefined, label: string }): BusTimeClient {
    const { baseURL, apiKey, label } = options;
    const client = axios.create({
        baseURL,
        params: { key: apiKey, format: 'json' },
        timeout: 15000
    });

    const chunked = <T>(items: T[], size: number): T[][] => {
        const chunks: T[][] = [];
        for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
        return chunks;
    };

    return {
        async fetchVehicles(routes: string[]): Promise<any[] | null> {
            const promises = chunked(routes, 10).map(async chunk => {
                try {
                    const res = await client.get('/getvehicles', {
                        params: { requestType: 'getvehicles', rt: chunk.join(',') },
                    });
                    if (hasBusTimeSystemError(res.data)) {
                        console.warn(`[${label}] getvehicles system error`, JSON.stringify(res.data?.['bustime-response']?.error ?? 'malformed response body'));
                        return null;
                    }
                    return res.data['bustime-response']?.vehicle || [];
                } catch (e) {
                    console.warn(`[${label}] fetch vehicles failed`, e instanceof Error ? e.message : e);
                    return null;
                }
            });
            const results = await Promise.all(promises);
            if (results.some(r => r === null)) return null;
            return (results as any[][]).flat();
        },

        async fetchRoutes(): Promise<any[]> {
            try {
                const res = await client.get('/getroutes', { params: { requestType: 'getroutes' } });
                if (hasBusTimeSystemError(res.data)) {
                    console.warn(`[${label}] getroutes system error`, JSON.stringify(res.data?.['bustime-response']?.error ?? 'malformed response body'));
                    return [];
                }
                return res.data['bustime-response']?.routes || [];
            } catch (e) {
                console.error(`[${label}] fetch routes failed`, e instanceof Error ? e.message : e);
                return [];
            }
        },

        async fetchPatterns(rt: string): Promise<any[]> {
            try {
                const res = await client.get('/getpatterns', {
                    params: { requestType: 'getpatterns', rt, rtpidatafeed: 'bustime' }
                });
                if (hasBusTimeSystemError(res.data)) return [];
                return res.data['bustime-response']?.ptr || [];
            } catch (e) {
                return [];
            }
        },

        async fetchPredictions(stopIds: string[], routes: string[]): Promise<any[]> {
            const promises = chunked(stopIds, 10).map(async chunk => {
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
                    if (hasBusTimeSystemError(res.data)) {
                        console.warn(`[${label}] getpredictions system error`, JSON.stringify(res.data?.['bustime-response']?.error ?? 'malformed response body'));
                        return null;
                    }
                    return res.data;
                } catch (e) {
                    console.warn(`[${label}] fetch predictions chunk failed`, e instanceof Error ? e.message : e);
                    return null;
                }
            });
            return Promise.all(promises);
        },
    };
}
