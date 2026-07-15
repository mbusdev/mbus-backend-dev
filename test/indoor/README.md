# Indoor navigation unit tests

Pure unit tests for the indoor navigation pipeline (`src/indoor/`). Unlike
`test/api.test.ts` and `test/path.test.ts`, these do **not** require a running
server, Mongo, or Redis -- they call the exported functions/classes directly
with in-memory fixtures.

Run with:

```bash
npx vitest run test/indoor
```

or as part of the full suite: `npm test`.

## Coverage

- `parseNodeId.test.ts` - node id parsing and its error cases.
- `determineGraphScope.test.ts` - same_floor / same_building / cross_building
  classification.
- `buildGraphLoadPlan.test.ts` - which floor documents get loaded from Mongo
  for a given start/end node pair.
- `GraphMerger.test.ts` - merging multiple floor graphs and wiring up portal
  (vertical connection) edges.
- `pathfinderAstar.test.ts` - A* correctness, unreachable goals, and
  `accessibleOnly` filtering.

## Known gaps flagged by these tests

Two tests intentionally document bugs/gaps found while reviewing the indoor
nav code, rather than hiding them:

1. **`buildGraphLoadPlan.test.ts` - "KNOWN GAP: a cross-building route..."**
   `determineGraphScope` recognizes a `cross_building` case, but
   `buildGraphLoadPlan` only ever loads the two endpoint floors, with no
   target representing an outdoor/connector path between the buildings. Once
   merged, the two floor graphs are disconnected, so `computeIndoorRoute`
   silently returns an empty path (`totalCost: Infinity`) for any
   cross-building request instead of a real route or a clear error. This test
   passes today because it documents current behavior; if a connector-graph
   concept gets added, update this test to match.

2. **`pathfinderAstar.test.ts` - "KNOWN BUG: an inadmissible cross-floor
   heuristic..."** The A* heuristic is straight-line distance using each
   node's raw `(x, y)`. Those coordinates are local to each floor plan, so
   comparing them across floors (i.e. across a portal/vertical-connection
   edge) is not a valid distance measure and can make the heuristic
   inadmissible. This test is marked `it.fails(...)` with a constructed
   counterexample where A* returns a cost-51 path when a cost-2 path exists.
   If the heuristic is fixed (e.g. by zeroing it across floor/building
   boundaries, or using a per-floor-normalized measure), this test will start
   passing -- remove `.fails` at that point so it becomes a normal regression
   test.

All other tests assert the currently-correct, intended behavior.
