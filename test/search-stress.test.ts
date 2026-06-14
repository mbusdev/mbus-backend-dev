import axios from 'axios';
import { describe, it, expect, beforeAll } from 'vitest';

const SERVER_PORT = 3000;
const BASE_URL = `http://localhost:${SERVER_PORT}/mbus/api/v3`;

/** Axios errors embed functions (e.g. transformRequest) that Vitest cannot clone over RPC. */
function toPlainError(error: unknown, label: string): Error {
    if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const detail = status != null ? ` (HTTP ${status})` : '';
        return new Error(`${label}: ${error.message}${detail}`);
    }
    if (error instanceof Error) return new Error(`${label}: ${error.message}`);
    return new Error(`${label}: ${String(error)}`);
}

describe('Stress Test Pathing Endpoint', () => {
    beforeAll(async () => {
        try {
            await axios.get(`${BASE_URL}/getAllPredictions`, { timeout: 10_000 });
        } catch (error) {
            console.error('Server is not running! Please start the server with: npm start');
            process.exit(1);
        }
    });

    it('should handle many concurrent /plan-journey requests', async () => {
        const numRequests = 50;
        const origin = { lat: 42.264356, lon: -83.744354 };
        const destination = { lat: 42.268068, lon: -83.747307 };

        // Requests queue on single-threaded Node; allow enough time for the full batch.
        const requestTimeoutMs = 180_000;

        const requests = Array.from({ length: numRequests }, (_, i) => {
            const offset = i * 0.0001;
            const originLat = origin.lat + offset;
            const originLon = origin.lon + offset;
            const destLat = destination.lat + offset;
            const destLon = destination.lon + offset;

            const url = `${BASE_URL}/plan-journey?originLat=${originLat}&originLon=${originLon}&destLat=${destLat}&destLon=${destLon}`;
            return axios.get(url, { timeout: requestTimeoutMs })
                .then(response => {
                    expect(response.status).toBe(200);
                    return { index: i + 1, ok: true as const };
                })
                .catch(error => {
                    throw toPlainError(error, `Request ${i + 1}`);
                });
        });

        const start = Date.now();
        const results = await Promise.allSettled(requests);
        const duration = Date.now() - start;

        const failures = results
            .map((r, i) => (r.status === 'rejected' ? { index: i + 1, reason: r.reason } : null))
            .filter((f): f is { index: number; reason: unknown } => f != null);

        if (failures.length > 0) {
            for (const f of failures) {
                const msg = f.reason instanceof Error ? f.reason.message : String(f.reason);
                console.error(`Request ${f.index} failed:`, msg);
            }
            throw new Error(`${failures.length}/${numRequests} stress requests failed after ${duration}ms`);
        }

        console.log(`✅ All ${numRequests} requests completed in ${duration}ms`);
    }, 300_000);
});
