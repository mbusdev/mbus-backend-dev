# OFFICIAL DESIGN DOC FOR documented.ts
**link to flowchart on figjam or alternative:** none
**Developer(s):** Edward Zhang
**Feature / Algorithm Name:** documented
* *Status:* Implemented
* *Date:* 2026-08-15
* *Reviewers:* none (this doc was created after the fact, which isn't ideal)

## Goals
- generate OpenAPI specs for the api served by the backend, for use in creating documentation or generating clients
- make it easy to validate request inputs and handle them in a type safe way

## Core Algorithm / Behavioral Steps (Pseudocode / Logic flow)
1. instead of using Express.js directly, the new wrapper functions are used
    - you pass in Zod schemas representing the request and response formats
    - it sets up an express handler that first uses Zod to parse/validate the request, before calling your handler with pre-parsed data
    - your handler must return a value, preventing mistakes with not doing so causing requests to hang
2. these wrapper functions update an object that holds information about all routes defined (prefix string, route string, res/req schemas)
3. process that object into an OpenAPI spec
    - Zod provides a way to convert from its schemas to json schemas, which is the core of this
        - the conversion will create sub-schemas for you if you define the Zod schema you want to be split out with an id
        - conversion is local per object, so sub-schemas would be duplicated if naively merged
            - workaround: create a "model object" containing all schemas then use the subschema of that for the global subschema list
    - post-processing done to clean it up to just what OpenAPI needs
4. output the spec to the console or a file

## Input 
- environment variables for enabling the spec generation portion (wrappers always used) and determining where to output the specs to
- what people pass into the express wrappers

## Output
- an api that rejects invalid inputs with good error messages
- OpenAPI specs
**Files Created:**
- `src/routes/documented.ts`
- `test/documented.test.ts`
**Files Modified:**
- `src/routes/api.ts` (migrate some existing routes over to test things)
## Edge Cases
- stuff that can't be expressed in json schema but can be in Zod would make spec generation error (catch in CI)
- complex http stuff like headers, redirects
    - use express directly or configure middleware
- middleware can break things: make sure the type of req/res data isn't changed by the middleware
- legacy routes & initial prototyping may still use express directly

## Testing Strategy 
- basic coverage of all features
    - (GET, POST) \* (path, query, body(s)) \* (valid input, invalid input)
    - check inputs are parsed correctly
    - check that the generated spec makes sense
- regression tests for any bug that shows up during implementation or later usage

# Original PR Text Before It Got Split
## Description / Rationale
This PR targets a few things about the current codebase that can be improved. The first (and initial motivation) was the poor state of documentation for people seeking to consume the api that the backend serves. The functions in `src/routes/api.ts` were exported and also have doc comments in an attempt to alleviate this, but this remained messy. The canonical way to specific an http api is with OpenAPI, which gives a spec/definition that can be plugged into various client generators and doc uis, but that leaves the challenge of writing/generating the spec. The other two (request parsing, generating clients) came as extensions of this.

### Existing approaches considered and why I don't like them
- spec as source of truth + generating server stubs from them (openai specs are a pain to write by hand)
- tsoa (mandatory separate build step)
- elysia, effect (requires full framework change)
- express middleware solutions (req/res schemas are only determined from ad-hoc from actual traffic)
- express + openapi defs in js doc (still requires knowing openapi format a bit, can become desynced w/ actual logic)

- aside: I recently found https://github.com/RobinTail/express-zod-api, which is quite similar to what I did and could be a migration target if this doesn't work out

### Goals of my approach
- partially migrating is perfectly fine as it is just a thin wrapper over express
- handles request parsing & validation for you for a nice pit of success 
- can't be out of sync: typescript compiler will yell at you
- you don't need to know openapi (will need to use Zod, which is already used for reminders & indoor navigation)
- openapi output is quality enough that it can be used to generate working dart clients

### Technical Details
- user facing (also see docs @ https://docs.mb.thething.fyi/refs/heads/http-api-docs/typedoc/modules/routes_documented.html)
  - main interface is three wrappers around `app.use`, `router.get`, `router.post`
  - instead of the handler giving you an express `req` and `res`, you get request details pre-parsed and return an object representing the response
  - the formats the route accepts are passed an object containing zod schemas for query params, path params, and bodies
- internals
  - all spec generation is done during runtime (this seemed the simplest — no need to deal with typedoc or the ts compiler api, metaprogramming is hard)
  - the main interface takes a context object, which holds the necessary information for generating the spec
  - the `finalize` function has the majority of the spec making logic
  - zod allows you to get the json schema of most normal zod schemas, this was very useful to use

## Type of Change
- [x] New feature (`feat`)
- [ ] Bug fix (`fix`)
- [ ] Refactor / code improvement
- [ ] Dependency / build update
- [ ] Documentation
- [ ] Other (explain)

## Related Issues
Progress towards #40
Depends on #45 

## Changes Made
- Flutter: n/a
- Backend (TypeScript):
  - src/routes/documented.ts: contains all the logic as described above
  - test/documented.test.ts: unit testing, in particular done in response to regressions/bugs that occured during development
    - a typo could result in the schemas being wrong so all bits of that have coverage
    - the `id` field was being filtered wrongly
  - added openapi spec deployment to CI: uploaded via FTP to the same place that typedoc docs are being sent
  - changed a few existing routes to use the library for initial testing (mostly reminder stuff because I wrote them, but I've also done it for getAllRoutes and getAllRideRoutes since)
- Firebase / Shared: n/a

## Testing Done
**Flutter:**
- [ ] Tested on:
  - [ ] iOS Simulator
  - [x] Android Emulator (dart generated client works when used for a limited set of routes!)
  - [ ] Physical device

## Screenshots / Demo (if UI or notification change)
example spec: https://docs.mb.thething.fyi/refs/heads/http-api-docs/openapi/spec.json
as rendered docs: go to https://elements-demo.stoplight.io and paste the url above

## Checklist
- [x] Commit messages follow Conventional Commits
- [x] PR title follows `[type](scope): short description`
- [x] PR target branch is not `main` and is our current working update branch (e.g. `maizebus2.1`)
- [x] No `print()` / `debugPrint()` / `console.log()` left in production code
- [x] Secrets / keys not committed

