// COMMIT-SCOPED memoization, across requests (#5073).
//
// The third lifetime in this tree. `cache()` (lib/request-cache.ts) lasts one request;
// `tickCached` (lib/tick-cache.ts) lasts one profile's notification tick. Both are
// bounded by a SCOPE somebody opens and closes. This one is bounded by the DATABASE:
// an entry survives as many requests as nothing commits, and dies the moment anything
// does. The dashboard's six Show-everything gathers are 32-47% of a warm render and
// none of them change between two loads with no write in between.
//
// NOT A TTL, and lib/tick-cache.ts sets out the reason at length: a time-bounded memo
// over a suppression bus reads as "still silenced" after the write that should have
// cleared it, and on a health surface that is the dangerous direction. Nothing here is
// bounded by the clock.
//
// THE VERSION IS A PAIR, because neither half can see what the other sees.
//   - `PRAGMA data_version` moves when ANOTHER CONNECTION commits and never for this
//     connection's own writes. Three processes write this file (the web app, the hourly
//     notify tick, the poll sidecar), so this half is how the sidecar's
//     `upcoming_dismissals` deletes and the poll loop's writes reach a web request.
//   - `total_changes()` counts the rows THIS connection has written since it opened,
//     which is exactly the half `data_version` is blind to.
// Both halves are proved live, and proved load-bearing by removal, in
// lib/__db_tests__/dashboard-tail-memo.test.ts.
//
// WHY total_changes() RATHER THAN A COUNTER IN writeTx. #5073 proposed incrementing a
// counter inside `writeTx` on the grounds that it is "the one path every mutation
// takes". It is not, and the difference is a stale health reading. `writeTx` is where
// every write TRANSACTION goes — lib/__tests__/immediate-tx.test.ts enforces that and
// nothing else — but a single-statement write needs no transaction and dozens skip it.
// `deleteAppointment` (app/(app)/encounters/appointment-actions.ts) removes the row with
// one prepared statement and no wrapper, and `getScheduledAppointments` is one of the
// gathers memoized here, so a writeTx-only counter would have served the deleted
// appointment straight back to the dashboard. SQLite's own counter has no such hole and
// needs no instrumentation at any write site.
//
// OVER-INVALIDATION IS THE DESIGN, not an accident: neither half of the version is per
// profile, so any write anywhere drops every profile's entry. Making it per profile
// would need every write to name its profile at the boundary; the cost of not doing so
// is one recompute after a write, which is what every load pays today.
//
// ONE VERSION READ PER REQUEST. `cache()` holds the pair for the request, so a commit
// midway through a render is observed by the NEXT request instead of splitting one
// render across two snapshots — the same rule the request cache already implies.
// Outside a request `cache()` is identity, and then this wrapper is a plain
// passthrough: a DB test, a script and the notify sidecar compute every call, exactly
// as `cache()` and `tickCached` degrade outside their own scopes.
import type Database from "better-sqlite3";
import { db, hoistedStatement } from "./db";
import { cache } from "./request-cache";

const OWN_WRITES = hoistedStatement("SELECT total_changes() AS changes");

function readVersion(): string {
  const others = db.pragma("data_version", { simple: true }) as number;
  const own = (OWN_WRITES.get() as { changes: number }).changes;
  return `${others}.${own}`;
}

// One request's version, read at the first memo use and held for the rest of it.
const requestVersion = cache(readVersion);

// WHETHER A REQUEST SCOPE IS OPEN AT ALL, asked of `cache()` itself rather than of a
// framework internal. Inside a request `cache()` memoizes, so a zero-argument factory
// hands back the SAME object twice; outside one it is identity (lib/request-cache.ts)
// and mints a new object per call. Two calls and an identity comparison is the whole
// test, and it is true of React's `cache` and of the render harness's stand-in alike.
const requestToken = cache((): object => ({}));

function inRequest(): boolean {
  return requestToken() === requestToken();
}

interface Store {
  version: string;
  entries: Map<string, unknown>;
}

// Keyed on the CONNECTION, like lib/db.ts's statement cache and for the same reason:
// the shared-registry DB tier swaps the database between test files, and a new handle
// must not inherit the old file's answers. That is also why this module needs no entry
// in setup-shared.ts's `resetCarriedState` — the swap drops the store with the handle.
//
// WHAT IT RETAINS, AND WHY THAT NEEDS NO EVICTION. One entry per (gather, key) for every
// profile this process has served SINCE THE LAST COMMIT, and any write anywhere empties
// the whole store — so the live set is one version's worth of dashboards, never a
// history, and the key space cannot creep behind it either: changing a unit or a format
// preference is itself a write. Measured across the six seeded personas, the heaviest
// (bodybuilder) holds 61 588 bytes of JSON-equivalent, 52 124 of it `gatherCoachingInput`
// alone. That byte count UNDERSTATES it in one way worth naming: `gatherCoachingInput`'s
// result carries closures — `weather.canDo` is
// `(candidate) => canDoIndoorActivity(profileId, candidate)` (lib/queries/coaching.ts) —
// which JSON does not see, so their captured scopes are held until the next commit too.
const stores = new WeakMap<Database.Database, Store>();

function storeAt(version: string): Store {
  let store = stores.get(db);
  if (!store) {
    store = { version, entries: new Map() };
    stores.set(db, store);
  }
  if (store.version !== version) {
    store.version = version;
    store.entries.clear();
  }
  return store;
}

// Memoize `fn` until something commits, keyed by `name` plus the caller's own key
// function. Outside a request the wrapper calls straight through, so behavior in a
// test, a script and the notify sidecar is byte-identical to the unwrapped gather.
//
// `keyOf` must project EVERY argument that can change the answer — the same discipline
// `cache()` imposes by identity and `tickCached` states in the same words. It must also
// project anything OUTSIDE the arguments that the version pair does not cover: the
// clock is the one that matters here, so a gather that reads `today(profileId)` for
// itself puts that day in its key, or it answers yesterday's question after a quiet
// midnight.
export function commitCached<A extends unknown[], R>(
  name: string,
  keyOf: (...args: A) => string,
  fn: (...args: A) => R
): (...args: A) => R {
  return (...args: A): R => {
    if (!inRequest()) return fn(...args);
    const store = storeAt(requestVersion());
    const key = `${name}:${keyOf(...args)}`;
    if (store.entries.has(key)) return store.entries.get(key) as R;
    const value = fn(...args);
    store.entries.set(key, value);
    return value;
  };
}
