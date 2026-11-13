import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { get, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Runs before the imports below: an in-memory database, fixture floor plans and a mocked Google
// verifier, so these tests need neither a running server nor anything in data/.
const verifyIdToken = vi.hoisted(() => {
    process.env.AUTH_DB_PATH = ':memory:';
    process.env.FLOORPLANS_DIR = 'test/fixtures/floorplans';
    process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-characters';
    process.env.GOOGLE_CLIENT_IDS = 'ios-id, android-id, web-id';
    process.env.ACCESS_TOKEN_TTL = '30m';
    return vi.fn();
});
vi.mock('google-auth-library', () => ({ OAuth2Client: class { verifyIdToken = verifyIdToken; } }));

import express from 'express';
import jwt from 'jsonwebtoken';
import auth from '../src/routes/auth';
import floorplans from '../src/routes/floorplans';
import { db } from '../src/services/authDb';

const SECRET = process.env.JWT_SECRET!;
const UMICH = { sub: 'g-1', hd: 'umich.edu', email_verified: true, email: 'student@umich.edu', name: 'Stu Dent' };

let server: Server;
let base: string;

beforeAll(() => {
    const app = express();
    app.use(express.json());
    app.use('/auth', auth);
    app.use('/floorplans', floorplans);
    app.get('/public', (_req, res) => res.json({ ok: true }));
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });
beforeEach(() => { verifyIdToken.mockReset(); });

const post = (path: string, body: unknown) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const gated = (token?: string, path = '', headers: Record<string, string> = {}) =>
    fetch(`${base}/floorplans${path}`, { headers: token ? { authorization: `Bearer ${token}`, ...headers } : headers });
const googleSays = (payload: object) => verifyIdToken.mockResolvedValue({ getPayload: () => payload });

async function signIn(payload: object = UMICH) {
    googleSays(payload);
    const res = await post('/auth/google', { idToken: 'google-id-token' });
    return { res, body: await res.json() };
}
const liveTokens = (userId: number) =>
    (db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL').get(userId) as { n: number }).n;

describe('requireAuth on floor plan routes', () => {
    it('rejects a request without a token', async () => {
        const res = await gated();
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ code: 'NO_TOKEN' });
    });

    it('rejects a garbage token', async () => {
        const res = await gated('garbage');
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ code: 'INVALID_TOKEN' });
    });

    it('reports an expired token as TOKEN_EXPIRED', async () => {
        const expired = jwt.sign({ sub: '1', exp: Math.floor(Date.now() / 1000) - 10 }, SECRET, { algorithm: 'HS256' });
        const res = await gated(expired);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ code: 'TOKEN_EXPIRED' });
    });

    it('rejects tokens that are not HS256 or not signed with our secret', async () => {
        const otherAlg = jwt.sign({ sub: '1' }, SECRET, { algorithm: 'HS512' });
        const unsigned = jwt.sign({ sub: '1' }, '', { algorithm: 'none' });
        const otherSecret = jwt.sign({ sub: '1' }, 'x'.repeat(40), { algorithm: 'HS256' });
        for (const token of [otherAlg, unsigned, otherSecret]) {
            const res = await gated(token);
            expect(res.status).toBe(401);
            expect(await res.json()).toEqual({ code: 'INVALID_TOKEN' });
        }
    });

    it('accepts a valid access token', async () => {
        const { body } = await signIn();
        expect((await gated(body.accessToken)).status).toBe(200);
        expect(jwt.decode(body.accessToken)).toMatchObject({ sub: String(body.user.id) });
    });

    it('gates every path under the prefix, existing or not', async () => {
        for (const path of ['/test-hall', '/nope', '/test-hall/extra']) {
            expect((await gated(undefined, path)).status).toBe(401);
        }
    });

    it('leaves other routes public', async () => {
        expect((await fetch(`${base}/public`)).status).toBe(200);
    });
});

describe('floor plan JSON', () => {
    let token: string;
    beforeAll(async () => { token = (await signIn()).body.accessToken; });

    it('lists the buildings found in FLOORPLANS_DIR and skips files that are not floor plans', async () => {
        const res = await gated(token);
        expect(await res.json()).toEqual({
            buildings: [{ buildingId: 'test-hall', building: 'Test Hall', floors: [{ id: 'th-f1', name: '1' }, { id: 'th-f2', name: '2' }] }],
        });
    });

    it('serves a building unchanged, minified and gzipped', async () => {
        const source = readFileSync('test/fixtures/floorplans/test-hall.json', 'utf8');
        const res = await gated(token, '/test-hall');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
        expect(res.headers.get('content-encoding')).toBe('gzip');
        expect(res.headers.get('cache-control')).toBe('private, no-cache');
        expect(await res.json()).toEqual(JSON.parse(source));

        const plain = await gated(token, '/test-hall', { 'accept-encoding': 'identity' });
        expect(plain.headers.get('content-encoding')).toBeNull();
        expect(await plain.text()).toBe(JSON.stringify(JSON.parse(source)));
    });

    it('answers 304 without a body when the client already has the current version', async () => {
        const etag = (await gated(token, '/test-hall')).headers.get('etag')!;
        // Not fetch(): it adds `Cache-Control: no-cache` to a request with If-None-Match, which asks for a full response.
        const conditional = (headers: Record<string, string>) => new Promise<{ status?: number, body: string }>((resolve, reject) => {
            get(`${base}/floorplans/test-hall`, { headers: { 'if-none-match': etag, ...headers } }, res => {
                let body = '';
                res.on('data', chunk => { body += chunk; }).on('end', () => resolve({ status: res.statusCode, body }));
            }).on('error', reject);
        });
        expect(await conditional({ authorization: `Bearer ${token}` })).toEqual({ status: 304, body: '' });
        expect((await conditional({})).status).toBe(401);
    });

    it('answers 404 for an unknown building', async () => {
        const res = await gated(token, '/nope');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ code: 'NOT_FOUND' });
    });
});

describe('POST /auth/google', () => {
    it('signs in a umich.edu account and checks the audience against every client id', async () => {
        const { res, body } = await signIn();
        expect(res.status).toBe(200);
        expect(body.user).toEqual({ id: expect.any(Number), email: 'student@umich.edu', name: 'Stu Dent' });
        expect(body.refreshToken).toMatch(/^[\w-]{43}$/);
        expect(verifyIdToken).toHaveBeenCalledWith({ idToken: 'google-id-token', audience: ['ios-id', 'android-id', 'web-id'] });
    });

    it('stores only a hash of the refresh token', async () => {
        const { body } = await signIn();
        const hashes = db.prepare('SELECT token_hash FROM refresh_tokens').all().map((r: any) => r.token_hash);
        expect(hashes).not.toContain(body.refreshToken);
        expect(hashes.every((h: string) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
    });

    it('keeps one user row per Google account', async () => {
        const first = await signIn();
        const second = await signIn({ ...UMICH, name: 'Renamed' });
        expect(second.body.user).toEqual({ ...first.body.user, name: 'Renamed' });
    });

    it.each([
        ['a personal Gmail account', { ...UMICH, hd: undefined, email: 'someone@gmail.com' }],
        ['another Workspace domain', { ...UMICH, hd: 'example.edu' }],
        ['a umich.edu address without the hd claim', { ...UMICH, hd: undefined }],
        ['an unverified email', { ...UMICH, email_verified: false }],
    ])('rejects %s with 403', async (_name, payload) => {
        const { res, body } = await signIn(payload);
        expect(res.status).toBe(403);
        expect(body).toEqual({ code: 'UMICH_ACCOUNT_REQUIRED' });
    });

    it('rejects a token Google does not verify with 401', async () => {
        verifyIdToken.mockRejectedValue(new Error('Wrong recipient, payload audience != requiredAudience'));
        const res = await post('/auth/google', { idToken: 'forged' });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ code: 'INVALID_GOOGLE_TOKEN' });
    });

    it('rejects a request without an idToken with 400', async () => {
        expect((await post('/auth/google', {})).status).toBe(400);
        expect(verifyIdToken).not.toHaveBeenCalled();
    });
});

describe('POST /auth/refresh', () => {
    it('rotates the refresh token and returns a working pair', async () => {
        const { body } = await signIn();
        const res = await post('/auth/refresh', { refreshToken: body.refreshToken });
        const rotated = await res.json();
        expect(res.status).toBe(200);
        expect(rotated.refreshToken).not.toBe(body.refreshToken);
        expect((await gated(rotated.accessToken)).status).toBe(200);
        expect((await post('/auth/refresh', { refreshToken: rotated.refreshToken })).status).toBe(200);
    });

    it('treats a reused refresh token as theft and revokes every token of that user', async () => {
        const { body } = await signIn({ ...UMICH, sub: 'g-reuse' });
        const otherDevice = await signIn({ ...UMICH, sub: 'g-reuse' });
        const first = await post('/auth/refresh', { refreshToken: body.refreshToken });
        const rotated = await first.json();
        expect(first.status).toBe(200);
        expect(liveTokens(body.user.id)).toBe(2);

        const second = await post('/auth/refresh', { refreshToken: body.refreshToken });
        expect(second.status).toBe(401);
        expect(await second.json()).toEqual({ code: 'INVALID_REFRESH_TOKEN' });
        expect(liveTokens(body.user.id)).toBe(0);
        expect((await post('/auth/refresh', { refreshToken: rotated.refreshToken })).status).toBe(401);
        expect((await post('/auth/refresh', { refreshToken: otherDevice.body.refreshToken })).status).toBe(401);
    });

    it('rejects unknown and expired refresh tokens', async () => {
        expect((await post('/auth/refresh', { refreshToken: 'unknown' })).status).toBe(401);

        const { body } = await signIn({ ...UMICH, sub: 'g-expired' });
        db.prepare('UPDATE refresh_tokens SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1, body.user.id);
        expect((await post('/auth/refresh', { refreshToken: body.refreshToken })).status).toBe(401);
    });
});

describe('POST /auth/logout', () => {
    it('revokes the refresh token and always answers 204', async () => {
        const { body } = await signIn({ ...UMICH, sub: 'g-logout' });
        expect((await post('/auth/logout', { refreshToken: body.refreshToken })).status).toBe(204);
        expect(liveTokens(body.user.id)).toBe(0);
        expect((await post('/auth/refresh', { refreshToken: body.refreshToken })).status).toBe(401);
        expect((await post('/auth/logout', { refreshToken: 'unknown' })).status).toBe(204);
        expect((await post('/auth/logout', {})).status).toBe(204);
    });
});
