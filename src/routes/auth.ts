/*
 * Gated routes (the only routes that require a signed-in umich.edu user):
 *
 *   GET /mbus/api/v3/floorplans               list of buildings with floor plans
 *   GET /mbus/api/v3/floorplans/:buildingId   one building's floor plan JSON
 *   ...and any other path under /mbus/api/v3/floorplans/ (the gate is on the router, src/routes/floorplans.ts)
 *
 * Everything else, including /mbus/api/v3/auth/* itself, is public. Mount `requireAuth` on the routes
 * listed here and nowhere else.
 */
import express from 'express';
import jwt from 'jsonwebtoken';
import * as crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { db } from '../services/authDb';

declare global {
    namespace Express {
        interface Request {
            /** Set by `requireAuth`: the signed-in user's id (`users.id`, as a string). */
            user?: { id: string };
        }
    }
}

const JWT_SECRET = process.env.JWT_SECRET ?? '';
const GOOGLE_CLIENT_IDS = (process.env.GOOGLE_CLIENT_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const ACCESS_TOKEN_TTL = (process.env.ACCESS_TOKEN_TTL || '30m') as jwt.SignOptions['expiresIn'];
const REFRESH_TOKEN_TTL_MS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 60) * 24 * 60 * 60 * 1000;

// Without a real secret nothing may be issued or accepted: /auth/* and every gated route answer 503.
const configured = JWT_SECRET.length >= 32 && GOOGLE_CLIENT_IDS.length > 0;
if (!configured) {
    console.warn('Auth is not configured (needs JWT_SECRET of 32+ characters and GOOGLE_CLIENT_IDS); /auth and /floorplans will respond 503.');
}

const google = new OAuth2Client();

const upsertUser = db.prepare(`
    INSERT INTO users (google_sub, email, name, created_at, last_login_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(google_sub) DO UPDATE SET
      email = excluded.email, name = excluded.name, last_login_at = excluded.last_login_at
    RETURNING id, email, name`);
const insertToken = db.prepare('INSERT INTO refresh_tokens (user_id, token_hash, expires_at, created_at, device) VALUES (?, ?, ?, ?, ?)');
const findToken = db.prepare('SELECT user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ?');
const revokeToken = db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL');
const revokeAllForUser = db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL');

type User = { id: number, email: string, name: string | null };
type TokenRow = { user_id: number, expires_at: number, revoked_at: number | null };

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const deviceOf = (req: express.Request) => req.get('user-agent')?.slice(0, 200) ?? null;

/** Issues an access JWT and stores a new refresh token (hashed) for the user. Identity-provider agnostic. */
function issueTokens(userId: number, device: string | null) {
    const now = Date.now();
    const refreshToken = crypto.randomBytes(32).toString('base64url');
    insertToken.run(userId, sha256(refreshToken), now + REFRESH_TOKEN_TTL_MS, now, device);
    const accessToken = jwt.sign({ sub: String(userId) }, JWT_SECRET, { algorithm: 'HS256', expiresIn: ACCESS_TOKEN_TTL });
    return { accessToken, refreshToken };
}

const login = db.transaction((sub: string, email: string, name: string | null, device: string | null) => {
    const now = Date.now();
    const user = upsertUser.get(sub, email, name, now, now) as User;
    return { ...issueTokens(user.id, device), user };
});

/** Rotates a refresh token. Returns the new pair, or the reason the presented token was refused. */
const rotate = db.transaction((refreshToken: string, device: string | null) => {
    const now = Date.now();
    const hash = sha256(refreshToken);
    const row = findToken.get(hash) as TokenRow | undefined;
    if (!row) return 'invalid';
    if (row.expires_at < now) return 'expired';
    if (row.revoked_at !== null) {
        // An already rotated token came back: assume it leaked and sign the user out everywhere.
        revokeAllForUser.run(now, row.user_id);
        return 'reuse_detected';
    }
    revokeToken.run(now, hash);
    return issueTokens(row.user_id, device);
});

function deny(res: express.Response, status: number, code: string, reason: string) {
    console.warn(`auth failure: ${reason}`);
    res.status(status).json({ code });
}

/**
 * Express router for sign-in and session tokens, mounted at `/mbus/api/v3/auth`.
 */
const router = express.Router();

router.use((_req, res, next) => {
    if (!configured) return void res.status(503).json({ code: 'AUTH_NOT_CONFIGURED' });
    next();
});

/**
 * Exchanges a Google ID token for our own tokens. Only Google Workspace accounts of the umich.edu
 * hosted domain are accepted; the email address is never used for that decision.
 * @param req - Express request with body `{ idToken: string }`
 * @param res - Express response: `{ accessToken, refreshToken, user: { id, email, name } }`
 * @param next - Express error callback
 */
export async function googleSignIn(req: express.Request, res: express.Response, next: express.NextFunction) {
    try {
        const idToken = req.body?.idToken;
        if (typeof idToken !== 'string') return void res.status(400).json({ code: 'BAD_REQUEST' });

        let p;
        try {
            p = (await google.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_IDS })).getPayload();
        } catch (err) {
            // Only the start of Google's message: longer ones can quote the token's contents.
            return deny(res, 401, 'INVALID_GOOGLE_TOKEN', `invalid (${String((err as Error).message).slice(0, 60)})`);
        }
        if (p?.hd !== 'umich.edu' || p.email_verified !== true || !p.email) return deny(res, 403, 'UMICH_ACCOUNT_REQUIRED', 'bad_hd');

        res.json(login(p.sub, p.email, p.name ?? null, deviceOf(req)));
    } catch (err) {
        next(err);
    }
}
router.post('/google', googleSignIn);

/**
 * Rotates a refresh token: the presented token is revoked and a new pair is returned. Presenting a
 * token that was already revoked revokes every refresh token of that user.
 * @param req - Express request with body `{ refreshToken: string }`
 * @param res - Express response: `{ accessToken, refreshToken }`, or 401
 */
export function refresh(req: express.Request, res: express.Response) {
    const refreshToken = req.body?.refreshToken;
    if (typeof refreshToken !== 'string') return void res.status(400).json({ code: 'BAD_REQUEST' });
    const result = rotate(refreshToken, deviceOf(req));
    if (typeof result === 'string') return deny(res, 401, 'INVALID_REFRESH_TOKEN', result);
    res.json(result);
}
router.post('/refresh', refresh);

/**
 * Revokes a refresh token if it exists.
 * @param req - Express request with body `{ refreshToken: string }`
 * @param res - Express response: always 204
 */
export function logout(req: express.Request, res: express.Response) {
    const refreshToken = req.body?.refreshToken;
    if (typeof refreshToken === 'string') revokeToken.run(Date.now(), sha256(refreshToken));
    res.sendStatus(204);
}
router.post('/logout', logout);

/**
 * Requires a valid access token in `Authorization: Bearer <token>` and sets `req.user`.
 * Responds 401 with code `NO_TOKEN`, `INVALID_TOKEN` or `TOKEN_EXPIRED`; clients refresh on
 * `TOKEN_EXPIRED` and sign in again on the other two.
 * @param req - Express request
 * @param res - Express response
 * @param next - Called when the token is valid
 */
export function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (!configured) return void res.status(503).json({ code: 'AUTH_NOT_CONFIGURED' });
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    if (!token) return void res.status(401).json({ code: 'NO_TOKEN' });
    try {
        const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
        req.user = { id: payload.sub! };
        next();
    } catch (err) {
        const code = err instanceof jwt.TokenExpiredError ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
        res.status(401).json({ code });
    }
}

export default router;
