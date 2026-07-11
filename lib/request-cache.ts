import * as React from "react";

// Request-scoped memoization shim shared across the query layer.
//
// React's per-request cache() exists only in the canary React that Next vendors
// for server components. The plain `react` package that tsx entrypoints
// (scripts/notify.ts, scripts/seed.ts) resolve doesn't export it, so importing
// the named binding crashes the notify sidecar at module load. Fall back to
// identity there: those scripts run each query at most once per tick, so
// per-request dedup is meaningless outside Next anyway. Outside a server request
// (e.g. the DB test tier) React.cache also has no dispatcher and simply calls
// through, so a cached read stays behaviorally identical to an uncached one.
export const cache: typeof React.cache =
  (React as { cache?: typeof React.cache }).cache ?? ((fn) => fn);
