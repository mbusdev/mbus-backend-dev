<div align="center">
  <img src="static/logo.png" width="150" alt="Maizebus Logo">
  <h1>Maizebus Backend</h1>

  <p>
    <a href="https://mbusdev.github.io/mbus-backend-dev/">
      <img src="https://img.shields.io/badge/Documentation-Available-blue?style=for-the-badge&logo=typescript" alt="Documentation" />
    </a>
    <img src="https://img.shields.io/badge/License-ISC-green?style=for-the-badge" alt="License" />
  </p>

  <p>
    Backend service for the Magic Bus application. Handles real-time bus tracking, route management, and multi-modal journey planning (bus + walking) using the McRaptor algorithm.
  </p>
</div>

## Setup

First, obtain an API key for the Magic Bus backend from [the official Magic Bus Website](https://mbus.ltp.umich.edu/dev-account).

Then, define the `MBUS_API_KEY` environment variable with your API key.

To install dependencies, run `npm i`

## (WIP) Firebase (Push Notifications) Setup

Create a Firebase project if you haven't already, and set `FIREBASE_PROJECT_ID` to its id. Follow the steps
[here](https://firebase.google.com/docs/admin/setup#initialize_the_sdk_in_non-google_environments) to create a service
account key file. Place this file into `secrets/` and point `GOOGLE_APPLICATION_CREDENTIALS` to it. 
(you can do this temporarily with export GOOGLE_APPLICATION_CREDENTIALS="./secrets/your-filename.json")

Some additional resources for iOS [here](https://firebase.flutter.dev/docs/messaging/apple-integration/). Make
sure that the firebase project is configured with the same app id as xcode.

## Running the Backend

To run the backend, run `npm start`.

By default, the service runs on port 3000. To define a port for the service to run on, define an environment variable called `PORT` before running the backend.

## Authentication (floor plans)

Bus tracking, stops, routes and reminders are public. Everything under `/mbus/api/v3/floorplans/*` requires a
signed-in umich.edu Google account. Requires Node 22 or newer.

- `POST /mbus/api/v3/auth/google` with `{ idToken }` (a Google ID token) returns `{ accessToken, refreshToken, user }`.
  The account's hosted domain must be `umich.edu`.
- Gated requests send `Authorization: Bearer <accessToken>`. A 401 carries `code` `NO_TOKEN`, `INVALID_TOKEN` or
  `TOKEN_EXPIRED`; on `TOKEN_EXPIRED` the client refreshes.
- `POST /mbus/api/v3/auth/refresh` with `{ refreshToken }` returns a new pair and revokes the old refresh token.
  Presenting an already used refresh token signs the user out everywhere.
- `POST /mbus/api/v3/auth/logout` with `{ refreshToken }` revokes it.

Set `JWT_SECRET` and `GOOGLE_CLIENT_IDS` in `.env` (see `.env_example`); without them these routes respond 503 and
the rest of the API is unaffected. Users and refresh tokens are stored in `data/auth.sqlite`, which is created on
first start and must survive deploys. Back it up with `sqlite3 data/auth.sqlite ".backup backup.sqlite"`, not by
copying the file while the server runs.

### Floor plans

- `GET /mbus/api/v3/floorplans` returns `{ buildings: [{ buildingId, building, floors: [{ id, name }] }] }`.
- `GET /mbus/api/v3/floorplans/:buildingId` returns that building's floor plan JSON.

Floor plan files are not in git. Put one JSON file per building in `data/floorplans/` (or `FLOORPLANS_DIR`) and
restart the server; a building is addressed by the `buildingId` inside its file, not by the file name. Each file
is minified and gzipped once at startup, and responses carry an `ETag`, so a client that sends `If-None-Match`
gets an empty 304 while its copy is current.

Floor plan handlers belong in `src/routes/floorplans.ts`, where the gate is applied to the whole router. Never
expose the floor plan directory with `express.static`.

The auth and floor plan tests need no running server: `npx vitest run test/auth.test.ts`

## Documentation

This project uses TSDoc for code documentation.
To compile the static documentation:
```bash
npm run docs
```
The documentation is served at `http://localhost:3000/docs` or this [link](https://mbusdev.github.io/mbus-backend-dev/).

## Tests

This project uses **Vitest** for fast unit and integration testing.

- Run all tests: `npm test`
- Run stress tests: `npm run stress-test`

An example of passing the tests is below.

<img src="static/test_example.png" width="300" alt="test example">


## Contributing
Before submitting a pull request to main, please make sure you pass all the tests and can compile docs. If you believe some of the tests faulty or no longer needed after your commit, please contact Andrew Yu or Ryan Lu on Slack.