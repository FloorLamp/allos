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
// `biomarker_panel(name)` is the same move one level up, for the PANEL taxonomy
// (#1629). It is the SQL half of lib/biomarker-panels.panelForCanonicalName().
// It replaces the generated `CASE WHEN lower(name) IN (<member spellings>)` preimage
// panelKeyOfExpr built, which realized panel membership from each panel's ENUMERATED
// member lists (plus the enumerated members of the families those names belong to)
// and had the identical structural blind spot: a stored display name caught only by a
// family's freeform `match` matcher was a full family member to the family key — which
// post-#1627 calls the real matcher — but panel `other` to the panel facet, while its
// canonical siblings carried the real panel. The Biomarkers panel filter and the
// Timeline panel titles could then file one reading of a family under its clinical
// panel and another reading of the SAME family under "Other". Calling the real
// resolver removes the preimage, and with it the drift.
//
// The families' `members` lists stay declared — they remain the corpus the JS↔SQL
// parity tests pin (lib/biomarker-panels.panelMemberSpellings) — they are simply no
// longer any key's runtime realization.
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
import { panelForCanonicalName } from "./biomarker-panels";

// The SQL name of the biomarker-family function. Callers build expressions from
// this constant so the registration and the SQL can't disagree on the spelling.
export const BIOMARKER_FAMILY_FN = "biomarker_family";

// The SQL name of the biomarker-panel function, same discipline.
export const BIOMARKER_PANEL_FN = "biomarker_panel";

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
  const familyMemo = new Map<string, string>();
  handle.function(
    BIOMARKER_FAMILY_FN,
    { deterministic: true },
    (name: unknown) => {
      // NULL in, NULL out. The CASE this replaces fell through to the raw name
      // expression, so a NULL display name partitioned as NULL; preserve that
      // rather than folding NULLs onto the "" identity.
      if (name == null) return null;
      const s = String(name);
      const hit = familyMemo.get(s);
      if (hit !== undefined) return hit;
      const key = biomarkerFamily(s);
      if (familyMemo.size < MEMO_LIMIT) familyMemo.set(s, key);
      return key;
    }
  );
  const panelMemo = new Map<string, string>();
  handle.function(BIOMARKER_PANEL_FN, { deterministic: true }, (name) => {
    // NULL in, `other` out — NOT NULL. The CASE this replaces evaluated
    // `lower(NULL) IN (…)` to NULL and fell through to its ELSE, so a NULL display
    // name already resolved to the reserved fallback slug; the panel facet's
    // `= 'other'` comparisons depend on that (a NULL would match no filter at all).
    // panelForCanonicalName agrees — it maps null/blank to OTHER_PANEL.
    const s = name == null ? "" : String(name);
    const hit = panelMemo.get(s);
    if (hit !== undefined) return hit;
    const key = panelForCanonicalName(s) as string;
    if (panelMemo.size < MEMO_LIMIT) panelMemo.set(s, key);
    return key;
  });
  registered.add(handle);
}
