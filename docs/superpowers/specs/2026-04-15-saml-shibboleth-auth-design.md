# SAML Shibboleth Authentication & User Data API Design

**Date:** 2026-04-15
**Status:** Draft
**Scope:** Integrate UMich Shibboleth SSO, implement user data CRUD endpoints, add admin role support

## Context

MaizeBus is an Express/TypeScript backend serving University of Michigan transit data. The committed main branch has no authentication — all endpoints are publicly accessible. We need to gate user-specific functionality behind UMich Shibboleth SSO so that only authenticated UMich users can access personalized features (saved stops, preferences, trip history, etc.).

Dev/admin accounts are UMich users with an elevated `"admin"` role in the existing `InternalAccount.roles` array. No separate DevAccount model or auth flow is needed — admins authenticate via Shibboleth like everyone else. Admin role is assigned manually in MongoDB. Future usage-data endpoints (not yet defined) will be gated by a `requireAdmin` middleware.

## Auth Architecture

### Flow

```
User opens app
  -> GET /auth/login
  -> Redirect to UMich Shibboleth IdP
  -> User authenticates with UMich credentials
  -> IdP POSTs signed SAML assertion to /auth/saml/callback
  -> Passport validates assertion signature using UMich public cert
  -> Extracts uniqname, email, displayName from assertion attributes
  -> InternalAccount upserted (created on first login, lastLoginAt updated on return)
  -> express-session creates session, stored in MongoDB via connect-mongo
  -> httpOnly secure cookie set on client (opaque session ID only)
  -> User redirected to app

Subsequent requests:
  -> express-session loads session from MongoDB using cookie
  -> passport.session() deserializes user onto req.user
  -> requireAuth middleware checks req.isAuthenticated()
  -> Route handler uses req.user.accountId to scope all data queries
```

### Why Sessions Over JWT

Server-side sessions (MongoDB-backed) are the right choice because:

- **Instant revocation:** Delete the session row and the user is logged out immediately.
- **No token leakage risk:** Client only holds an opaque session ID, not a signed blob with user data.
- **Clean logout:** Destroy session + Shibboleth SLO. With JWT, tokens remain valid until expiry.
- **Simpler:** No token refresh logic, no secret rotation, no blacklist tables.

JWT is useful when you cannot maintain server-side state. We can — MongoDB is already our primary datastore.

### SAML Strategy Configuration

**Library:** `@node-saml/passport-saml` via Passport

**IdP endpoints (UMich Shibboleth):**
- Test: `https://shib-idp-staging.dsc.umich.edu/idp/profile/SAML2/POST/SSO`
- Production: `https://shibboleth.umich.edu/idp/profile/SAML2/POST/SSO`

**IdP certificates (downloaded from UMich):**
- Test: `secrets/shibboleth-nonprod-cert.pem`
- Production: `secrets/shibboleth-production-cert.pem`

**SP configuration:**
- Entity ID: `SAML_SP_ENTITY_ID` env var (default: `https://maizebus.app/shibboleth`)
- ACS URL: `SAML_SP_ACS_URL` env var (default: `https://maizebus.app/auth/saml/callback`)
- SP cert/key: `secrets/sp-cert.pem`, `secrets/sp-key.pem` (self-signed, generated via OpenSSL)

**SAML assertion attributes extracted:**
- `urn:oid:0.9.2342.19200300.100.1.1` -> uniqname
- `urn:oid:0.9.2342.19200300.100.1.3` -> email
- `urn:oid:2.16.840.1.113730.3.1.241` -> displayName

**Graceful degradation:** If cert files are missing, SAML is disabled and `/auth/login` returns 503. The server still starts and serves transit data.

## Middleware

### requireAuth

Checks `req.isAuthenticated()` (set by Passport session deserialization). Returns 401 if no valid session. Applied to all `/account/*` routes.

### requireAdmin

Wraps `requireAuth`, then checks if the user's `InternalAccount.roles` array contains `"admin"`. Returns 403 if not an admin. Applied to future usage-data endpoints (not built in this iteration).

### Session Configuration

```
express-session:
  store:              MongoStore (connect-mongo) -> same MongoDB instance
  secret:             SESSION_SECRET env var
  resave:             false
  saveUninitialized:  false
  cookie:
    httpOnly:         true          (no JS access - XSS protection)
    secure:           true in prod  (HTTPS only)
    maxAge:           8 hours
    sameSite:         lax
```

Passport serialize/deserialize stores the user object in the session and restores it on each request.

## Route Structure

All user data endpoints use Approach A: no `:accountId` in URLs. Every query is scoped to `req.user.accountId` implicitly. This eliminates authorization bugs where a missing ownership check could expose another user's data.

### Auth Routes (public, no middleware)

| Method | Path | Purpose |
|--------|------|---------|
| GET | /auth/login | Redirect to UMich IdP |
| POST | /auth/saml/callback | Validate assertion, establish session |
| GET | /auth/logout | Destroy session + IdP SLO |
| GET | /auth/me | Return current user info (401 if not authed) |
| GET | /auth/saml/metadata | Serve SP metadata XML |

### User Data Routes (all require `requireAuth`)

**Account:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | /account | Get own account |
| PATCH | /account | Update own account |
| DELETE | /account | Soft-delete (set active=false) |

No `POST /account` — accounts are auto-provisioned during SAML callback on first login.

**Preferences:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | /account/preferences | Get preferences |
| PUT | /account/preferences | Upsert preferences |

**Saved Stops:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | /account/saved-stops | List saved stops |
| POST | /account/saved-stops | Add a saved stop |
| PATCH | /account/saved-stops/:stopId | Update label/pin |
| DELETE | /account/saved-stops/:stopId | Remove saved stop |

**Search History:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | /account/search-history | List (paginated, default 20) |
| POST | /account/search-history | Upsert entry (increments searchCount) |
| DELETE | /account/search-history | Clear all |
| DELETE | /account/search-history/:entryId | Delete one |

**Notification Log:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | /account/notification-log | List (paginated, default 50) |
| POST | /account/notification-log | Create entry |
| PATCH | /account/notification-log/:logId | Mark as opened |

**Trip History:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | /account/trip-history | List trips |
| POST | /account/trip-history | Record trip |
| DELETE | /account/trip-history/:tripId | Delete trip |

**Commute Patterns (system-generated, read + delete only):**

| Method | Path | Purpose |
|--------|------|---------|
| GET | /account/commute-patterns | List patterns |
| DELETE | /account/commute-patterns/:patternId | Delete pattern |

**Personalization Profile (system-generated, read-only):**

| Method | Path | Purpose |
|--------|------|---------|
| GET | /account/personalization-profile | Get profile |

## Data Models

All 8 models are already committed to main. No schema changes needed. The uncommitted `DevAccount` model is dropped entirely.

### InternalAccount

| Field | Type | Constraints |
|-------|------|-------------|
| uniqname | String | required, unique |
| roles | [String] | default: [] |
| active | Boolean | default: true |
| createdAt | Date | default: now |
| lastLoginAt | Date | default: now |

### UserPreferences

| Field | Type | Constraints |
|-------|------|-------------|
| accountId | ObjectId | required, unique, ref: InternalAccount |
| defaultView | String | default: "map" |
| notificationsEnabled | Boolean | default: true |
| notifyMinutesBefore | Number | default: 5 |
| preferredRouteIds | [String] | default: [] |
| accessibilityMode | Boolean | default: false |
| theme | String | default: "system" |
| updatedAt | Date | default: now |

### SavedStop

| Field | Type | Constraints |
|-------|------|-------------|
| accountId | ObjectId | required, ref: InternalAccount |
| stopId | String | required |
| customLabel | String | default: "" |
| pinned | Boolean | default: false |
| pinnedOrder | Number | default: 0 |
| savedAt | Date | default: now |

Index: compound unique `{accountId, stopId}`

### SearchHistory

| Field | Type | Constraints |
|-------|------|-------------|
| accountId | ObjectId | required, ref: InternalAccount |
| query | String | required |
| resultType | String | default: "" |
| resultId | String | default: "" |
| searchCount | Number | default: 1 |
| lastSearchedAt | Date | default: now |

Index: compound unique `{accountId, query, resultId}`

### NotificationLog

| Field | Type | Constraints |
|-------|------|-------------|
| accountId | ObjectId | required, ref: InternalAccount |
| type | String | required |
| routeId | String | default: "" |
| stopId | String | default: "" |
| sentAt | Date | default: now |
| opened | Boolean | default: false |
| openedAt | Date or null | default: null |

### TripHistory

| Field | Type | Constraints |
|-------|------|-------------|
| accountId | ObjectId | required, ref: InternalAccount |
| routeId | String | required |
| boardStopId | String | required |
| alightStopId | String | required |
| startedAt | Date | required |
| endedAt | Date | required |
| source | String | default: "manual" |

### CommutePattern

| Field | Type | Constraints |
|-------|------|-------------|
| accountId | ObjectId | required, ref: InternalAccount |
| fromStopId | String | required |
| toStopId | String | required |
| routeId | String | required |
| daysOfWeek | [Number] | default: [] (0-6, Sun-Sat) |
| typicalHour | Number | required |
| confidence | Number | default: 0 |
| lastSeen | Date | default: now |

### PersonalizationProfile

| Field | Type | Constraints |
|-------|------|-------------|
| accountId | ObjectId | required, unique, ref: InternalAccount |
| topStopIds | [String] | default: [] |
| topRouteIds | [String] | default: [] |
| topBuildingIds | [String] | default: [] |
| peakUsageHours | [Number] | default: [] |
| computedAt | Date | default: now |

## Error Handling

| Condition | Status | Response |
|-----------|--------|----------|
| No session / expired | 401 | `{ error: "Authentication required" }` |
| Valid session, not admin | 403 | `{ error: "Insufficient permissions" }` |
| SAML assertion invalid | — | Passport rejects, redirect to login |
| SAML certs missing | 503 | `/auth/login` returns service unavailable |
| Resource not found | 404 | `{ error: "Not found" }` |
| Duplicate saved stop | 409 | `{ error: "Already saved" }` |
| Invalid request body | 400 | `{ error: "<zod validation details>" }` |
| Server error | 500 | `{ error: "Internal server error" }` |

## Security Summary

- SAML assertions cryptographically signed by UMich IdP — verified using their public cert
- Sessions stored server-side in MongoDB — client holds only an opaque session ID
- Cookies: `httpOnly` (no JS access), `secure` (HTTPS only in prod), `sameSite: lax`
- `saveUninitialized: false` — no phantom sessions for unauthenticated visitors
- All data queries scoped to `req.user.accountId` — no URL-based account ID, no ownership bypass possible
- Request body validation via Zod on all write endpoints
- Soft deletes for accounts (reversible), hard deletes for user-generated data

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| MONGODB_URI | Yes | MongoDB connection string |
| SESSION_SECRET | Yes | express-session signing secret |
| SAML_ENV | Yes | "test" or "production" — selects IdP endpoints |
| SAML_SP_ENTITY_ID | No | SP entity ID (default: https://maizebus.app/shibboleth) |
| SAML_SP_ACS_URL | No | Assertion callback URL (default: https://maizebus.app/auth/saml/callback) |
| PORT | No | Server port (default: 3000) |
| NODE_ENV | No | "production" enables secure cookies |

## Files to Create or Modify

| File | Action | Purpose |
|------|--------|---------|
| src/auth/saml.ts | Create | SAML strategy, user provisioning, passport config |
| src/routes/auth.ts | Create | Auth endpoints (login, callback, logout, me, metadata) |
| src/routes/users.ts | Rewrite | User data CRUD — Approach A (no :accountId in URLs) |
| src/middleware/requireAuth.ts | Create | Session auth guard |
| src/middleware/requireAdmin.ts | Create | Admin role guard |
| src/types/express.d.ts | Create | Express.User type augmentation |
| src/app.ts | Modify | Add session, passport, connect-mongo, mount auth + user routes |
| .env_example | Modify | Add SAML and session env vars |
| package.json | Modify | Add passport, passport-saml, express-session, connect-mongo, zod |

## Files NOT Created (Excluded From Design)

These files exist in the current uncommitted working directory but are intentionally excluded from this design. They should be discarded, not carried forward.

| File | Reason |
|------|--------|
| src/db/models/DevAccount.ts | Not needed — admin role on InternalAccount replaces it |
| src/routes/dev.ts | Not needed — no separate dev auth flow |
| src/middleware/requireDev.ts | Not needed — replaced by requireAdmin |

## Deferred (Not In Scope)

- Usage data GET endpoints for admin users (data collection strategy TBD)
- Transit API auth gating (decision deferred)
- Rate limiting
- CSRF protection (JSON API, not HTML forms)

## Verification

1. **SAML flow:** Start server with `SAML_ENV=test`, hit `/auth/login`, confirm redirect to UMich staging IdP. After login, confirm session is established, `/auth/me` returns user, and InternalAccount is created in MongoDB.
2. **Session persistence:** Restart server, confirm session survives (connect-mongo).
3. **User data CRUD:** Authenticate, then test each endpoint group — create, read, update, delete. Confirm all queries are scoped to the logged-in user's accountId.
4. **Ownership isolation:** Authenticate as two different users. Confirm neither can see the other's data.
5. **Auth rejection:** Hit `/account/*` endpoints without a session — confirm 401.
6. **Admin role:** Set `roles: ["admin"]` on an account in MongoDB, confirm `requireAdmin` passes. Remove it, confirm 403.
7. **Logout:** Hit `/auth/logout`, confirm session destroyed, subsequent requests return 401.
