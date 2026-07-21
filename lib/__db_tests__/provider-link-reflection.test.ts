// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Providers are the app's ONLY global mutable entity referenced by profile-owned
// rows, which makes their lifecycle operations (merge / delete / undo-restore)
// uniquely easy to under-scope — both recent provider bugs were exactly this shape:
//   - mergeProviders re-pointed only LIVE rows, so a captured-deleted record kept
//     the absorbed provider's id and undo re-inserted a dead FK (#375, fixed);
//   - a captured intake_items row had the same unhandled dangling provider_id
//     (#455, fixed here alongside this test).
//
// This test REFLECTS over the LIVE schema — `PRAGMA foreign_key_list` per table
// (every FK whose parent is `providers`) UNIONed with a name match on columns
// called `provider_id` / `location_provider_id` — to enumerate EVERY provider link
// the schema actually declares, then asserts each enumerated column is handled by
// BOTH provider lifecycle sets:
//   1. mergeProviders' re-point set (`PROVIDER_LINK_COLUMNS`), which doubles as the
//      provider-DELETE guard: a provider row is only ever deleted inside
//      mergeProviders (the absorb DELETE), and that runs AFTER re-pointing every
//      link in this list — so no LIVE row is ever stranded on a deleted provider.
//   2. the captured-row store (`deleted_rows` undo payloads): for every provider
//      link on a table an undo KIND captures, the undo registry must declare an
//      externalRef (column → providers) that NULLs the now-dead ref on restore
//      (the #375 fix) — because mergeProviders re-points only LIVE rows, NOT the
//      frozen captures, so the undo path is the only thing that can honestly
//      reconcile a captured link whose provider was merged/deleted since capture.
//
// It converts the "keep all provider side-effect logic centralized" prose rule into
// CI: a NEW provider_id-bearing column that merge/delete/undo doesn't know about
// fails here (issue #455). Deliberate exceptions live in the allowlists below, each
// with a justification.
//
// Runs via `npm run test:db`; the `db` singleton is a throwaway per-file temp DB
// with the full migrated schema (lib/__db_tests__/setup.ts).

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { PROVIDER_LINK_COLUMNS } from "@/lib/provider-merge";
import { UNDO_KINDS } from "@/lib/undo-delete";

const key = (table: string, column: string) => `${table}.${column}`;

// ── Live-schema reflection ────────────────────────────────────────────────────
// Every (table, column) provider link the schema declares, from two independent
// signals UNIONed so neither an unnamed FK nor a bare-INTEGER-named column can hide:
//   • PRAGMA foreign_key_list(<table>): any FK whose parent table is `providers`.
//   • PRAGMA table_info(<table>): any column NAMED provider_id / location_provider_id
//     (belt-and-suspenders for a link that predates its enforced REFERENCES).
const LINK_COLUMN_NAMES = new Set(["provider_id", "location_provider_id"]);

function reflectProviderLinks(): Set<string> {
  const out = new Set<string>();
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    )
    .all() as { name: string }[];
  for (const { name } of tables) {
    // FK-target signal.
    const fks = db.pragma(`foreign_key_list(${name})`) as {
      table: string;
      from: string;
    }[];
    for (const fk of fks)
      if (fk.table === "providers") out.add(key(name, fk.from));
    // Column-name signal.
    const cols = db.pragma(`table_info(${name})`) as { name: string }[];
    for (const c of cols)
      if (LINK_COLUMN_NAMES.has(c.name)) out.add(key(name, c.name));
  }
  return out;
}

// ── Deliberate exceptions ─────────────────────────────────────────────────────
// A provider link the schema declares but that is INTENTIONALLY not in the
// merge/delete re-point set. Empty today (every link is centralized); each entry
// MUST carry a justification comment when added.
const MERGE_DELETE_EXCEPTIONS = new Set<string>([
  // provider_affiliations (issue #1055) is a provider↔provider JOIN table with a
  // UNIQUE(individual_id, organization_id) pair. mergeProviders re-keys BOTH columns
  // explicitly (UPDATE OR IGNORE + dedupe + drop self-edges) rather than through the
  // generic PROVIDER_LINK_COLUMNS re-point UPDATE — a plain `SET col = survivor` would
  // trip the UNIQUE pair or coin a survivor↔survivor self-edge. So the special-cased
  // re-key lives in mergeProviders and these two links are excused from the generic
  // set (covered instead by the affiliation re-key assertions in provider-merge.test).
  "provider_affiliations.individual_id",
  "provider_affiliations.organization_id",
]);

// A provider link on a captured table that INTENTIONALLY needs no undo externalRef
// (e.g. the column is not a real enforced FK, so a dangling capture can't throw).
// Empty today; each entry MUST carry a justification comment when added.
const CAPTURE_EXCEPTIONS = new Set<string>([
  // (none)
]);

// Provider links the undo registry declares it NULLs on restore: every entity's
// externalRef whose target table is `providers`, as `${entity.table}.${column}`.
function undoProviderNullSet(): Set<string> {
  const out = new Set<string>();
  for (const spec of Object.values(UNDO_KINDS))
    for (const entity of spec.entities)
      for (const ref of entity.externalRefs ?? [])
        if (ref.table === "providers") out.add(key(entity.table, ref.column));
  return out;
}

// Every table any undo KIND captures (so a captured payload can carry its columns).
function capturedTables(): Set<string> {
  const out = new Set<string>();
  for (const spec of Object.values(UNDO_KINDS))
    for (const entity of spec.entities) out.add(entity.table);
  return out;
}

describe("provider-link reflection: every schema link is handled by merge/delete + undo", () => {
  it("reflects a non-trivial set of provider links from the live schema", () => {
    // Guard against a broken reflection silently passing every assertion below.
    expect(reflectProviderLinks().size).toBeGreaterThan(5);
  });

  it("mergeProviders' re-point set (== the provider-delete guard) covers every schema link", () => {
    const reflected = reflectProviderLinks();
    const listed = new Set(
      PROVIDER_LINK_COLUMNS.map((l) => key(l.table, l.column))
    );
    // Every reflected link the merge/delete path must handle appears in the set.
    const missing = [...reflected]
      .filter((k) => !MERGE_DELETE_EXCEPTIONS.has(k))
      .filter((k) => !listed.has(k));
    expect(missing).toEqual([]);
    // ...and PROVIDER_LINK_COLUMNS carries no stale entry the schema no longer
    // declares (a dead re-point UPDATE), so the two stay exactly in lock-step.
    const stale = [...listed].filter((k) => !reflected.has(k));
    expect(stale).toEqual([]);
  });

  it("the captured-row store nulls every provider link on a table an undo kind captures (#375/#455)", () => {
    const reflected = reflectProviderLinks();
    const captured = capturedTables();
    const nulled = undoProviderNullSet();
    // A captured provider link that neither the undo registry nulls nor an explicit
    // exception excuses would let undo re-insert a dead FK — the exact #375/#455 bug.
    const unhandled = [...reflected]
      .filter((k) => captured.has(k.split(".")[0]))
      .filter((k) => !nulled.has(k))
      .filter((k) => !CAPTURE_EXCEPTIONS.has(k));
    expect(unhandled).toEqual([]);
    // Sanity: the two provider links this invariant actually covers today
    // (medical_records + intake_items, the only captured provider-linked tables)
    // are both declared — proving the assertion has teeth, not a vacuous pass.
    expect(nulled.has("medical_records.provider_id")).toBe(true);
    expect(nulled.has("intake_items.provider_id")).toBe(true);
  });
});
