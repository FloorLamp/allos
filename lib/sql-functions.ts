// SQLite user functions that let a SQL expression call the ONE canonical pure
// function for an identity, instead of re-realizing that identity as a
// hand-maintained finite preimage that can silently drift from it (AGENTS.md:
// "one question gets one computation").
//
// `biomarker_family(name)` is the SQL half of lib/canonical-name.biomarkerFamily().
// It replaces the inlined `CASE WHEN lower(name) IN (<members>) THEN 'family:…'`
// preimage (#394) the family key used to be built from. That preimage realized
// only each family's FINITE member list and structurally dropped the family's
// freeform `match` matcher — SQL had no way to call it — so a stored display name
// caught ONLY by the regex (an un-snapped, AI-coined A1c spelling, a freeform
// total-25-OH vitamin-D name) was a family member to every JS surface (the star
// store, the retest clock, the dismissal key) and its OWN singleton to the
// dedup / is_latest SQL. The same measurement then double-counted on one date and
// could be marked "current" twice, while the star and retest the family carried
// pointed at a different row (#1401). Calling the real matcher removes the
// preimage, and with it the drift: JS and SQL now agree by construction on EVERY
// name, not just the enumerated ones.
//
// The families' `members` lists stay declared — they are still the finite preimage
// the PANEL taxonomy realizes (lib/biomarker-panels.panelMemberSpellings) and the
// corpus the JS↔SQL parity tests pin — they are simply no longer the family key's
// only realization.
//
// Registered by lib/db.ts on the handle it opens, before any statement is
// prepared, so every query path (app, scripts, DB-tier tests) has it. The function
// is deterministic and side-effect free, so SQLite may use it in a window
// PARTITION BY / WHERE / GROUP BY. It is NOT `directOnly`-restricted usage: never
// put it in an index, a generated column, a view, or a trigger — the value it
// returns is application logic that changes when a family is added, and a stored
// realization would silently go stale.
//
// Cost: one JS call per row of the expression. Results are memoized per handle
// because a profile's readings repeat a few hundred distinct analyte names across
// thousands of rows, so after warmup each call is a Map hit (measured: ~13ms for
// 20k rows un-memoized, versus ~7ms for the CASE it replaces).

import type Database from "better-sqlite3";
import { biomarkerFamily } from "./canonical-name";

// The SQL name of the biomarker-family function. Callers build expressions from
// this constant so the registration and the SQL can't disagree on the spelling.
export const BIOMARKER_FAMILY_FN = "biomarker_family";

// Handles that already carry the functions — registering the same name twice on
// one handle throws, and a caller (a test re-running boot) may ask more than once.
const registered = new WeakSet<Database.Database>();

// Upper bound on the per-handle memo, so a pathological vocabulary (an import that
// coins thousands of distinct freeform names) can't grow it without bound. Past the
// cap the function still returns the right answer, just uncached.
const MEMO_LIMIT = 4096;

// Register the shared user functions on a database handle. Idempotent per handle.
export function registerSqlFunctions(handle: Database.Database): void {
  if (registered.has(handle)) return;
  const memo = new Map<string, string>();
  handle.function(
    BIOMARKER_FAMILY_FN,
    { deterministic: true },
    (name: unknown) => {
      // NULL in, NULL out. The CASE this replaces fell through to the raw name
      // expression, so a NULL display name partitioned as NULL; preserve that
      // rather than folding NULLs onto the "" identity.
      if (name == null) return null;
      const s = String(name);
      const hit = memo.get(s);
      if (hit !== undefined) return hit;
      const key = biomarkerFamily(s);
      if (memo.size < MEMO_LIMIT) memo.set(s, key);
      return key;
    }
  );
  registered.add(handle);
}
