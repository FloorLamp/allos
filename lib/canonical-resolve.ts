// The ONE runtime chokepoint that snaps a stored/raw biomarker name onto its
// canonical dataset spelling. Every JS READ path that keys on a biomarker's
// canonical identity — the flag reconcile (lib/queries/medical), the derived-index
// series gathering (lib/queries/derived) — routes a stored `canonical_name` through
// here first, so a legacy spelling or a bare abbreviation that predates a rename
// (e.g. "RDW" before migration 103) still resolves to "Red Cell Distribution Width
// (RDW)" and finds its band / feeds its derived index. Without it, those paths did
// an EXACT-name lookup and silently dropped the reading's identity — the coupling
// that made a canonical rename require a stored-data migration at all.
//
// It is NOT the family/grouping identity (biomarkerFamily) — that has a SQL twin
// (familyKeyOfExpr, the #394 finite-preimage) that can't call a JS snapper, so
// pushing alias-resolution into it would break the JS↔SQL agreement. This resolves
// the NAME; the family layer keys on the resolved name as before.
//
// The alias index is derived from the canonical_biomarkers vocabulary, which is
// static within a process (seeded once at boot). It's cached per-DB-handle (a
// WeakMap, so a test that swaps the db singleton gets its own entry and nothing
// leaks) and invalidated when the row COUNT changes (a boot re-seed that adds/removes
// entries), so the ~300-entry index is built at most once per vocabulary rather than
// once per reconcile call.

import type Database from "better-sqlite3";
import { db as defaultDb } from "./db";
import { buildCanonicalIndex, snapCanonicalName } from "./canonical-name";

const cache = new WeakMap<
  Database.Database,
  { count: number; index: Map<string, string> }
>();

function indexFor(handle: Database.Database): Map<string, string> {
  const count = (
    handle.prepare("SELECT COUNT(*) AS c FROM canonical_biomarkers").get() as {
      c: number;
    }
  ).c;
  const hit = cache.get(handle);
  if (hit && hit.count === count) return hit.index;
  const names = (
    handle.prepare("SELECT name FROM canonical_biomarkers").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  const index = buildCanonicalIndex(names);
  cache.set(handle, { count, index });
  return index;
}

// A resolve function bound to the current canonical vocabulary. Call once per
// operation and reuse across its rows: `const resolve = canonicalResolver()`.
export function canonicalResolver(
  handle: Database.Database = defaultDb
): (name: string) => string {
  const index = indexFor(handle);
  return (name: string) => snapCanonicalName(name, index);
}
