// IMPURE (DB-touching) half of the re-import tombstone (issues #507/#508/#509). Wires
// the pure key math (tombstone-keys.ts) to SQLite: the per-batch tombstone-set load
// the keyed upserts consult, the write on a merge/delete, the remove on undo, and the
// live-row occupancy probe restore uses to avoid the UNIQUE collision (#509).
//
// A tombstone is a profile-owned row keyed on (profile_id, target_table, natural_key).
// The natural_key mirrors the table's upsert dedup key exactly (see tombstone-keys.ts),
// so an upsert's would-be re-insert can be recognized and skipped.

import { db } from "@/lib/db";
import { type TombstoneTable, importTombstoneForRow } from "./tombstone-keys";

// The set of tombstoned natural keys for one (profile, table). Loaded ONCE at the top
// of each keyed upsert (usually empty — merges/deletes of source-owned rows are rare),
// then checked in-memory per row, so a large hr_minutes/metric_samples batch pays a
// single indexed query rather than one probe per row. Profile-scoped.
export function loadImportTombstones(
  profileId: number,
  targetTable: TombstoneTable
): Set<string> {
  const rows = db
    .prepare(
      `SELECT natural_key FROM import_tombstones WHERE profile_id = ? AND target_table = ?`
    )
    .all(profileId, targetTable) as { natural_key: string }[];
  return new Set(rows.map((r) => r.natural_key));
}

// Record a tombstone (idempotent on the natural key). Called when a merge absorbs, or
// a delete removes, a source-owned row — so the next resync won't resurrect it.
export function writeImportTombstone(
  profileId: number,
  targetTable: TombstoneTable,
  naturalKey: string
): void {
  db.prepare(
    `INSERT INTO import_tombstones (profile_id, target_table, natural_key)
       VALUES (?, ?, ?)
     ON CONFLICT(profile_id, target_table, natural_key) DO NOTHING`
  ).run(profileId, targetTable, naturalKey);
}

// Remove a tombstone. Called when UNDOING the merge/delete that wrote it (#200 side-
// effect inversion) so future syncs resume normal ingest of that natural key.
export function removeImportTombstone(
  profileId: number,
  targetTable: TombstoneTable,
  naturalKey: string
): void {
  db.prepare(
    `DELETE FROM import_tombstones WHERE profile_id = ? AND target_table = ? AND natural_key = ?`
  ).run(profileId, targetTable, naturalKey);
}

// Convenience: derive the tombstone for a captured/deleted ROOT row and write it when
// the row is source-owned (no-op for a manual row). Used by captureDelete + the two
// Review-resolver merges.
export function writeImportTombstoneForRow(
  profileId: number,
  ownedTable: string,
  row: Record<string, unknown>
): void {
  const t = importTombstoneForRow(ownedTable, row);
  if (t) writeImportTombstone(profileId, t.table, t.key);
}

// Convenience: derive + remove the tombstone for a captured ROOT row on undo/restore.
export function removeImportTombstoneForRow(
  profileId: number,
  ownedTable: string,
  row: Record<string, unknown>
): void {
  const t = importTombstoneForRow(ownedTable, row);
  if (t) removeImportTombstone(profileId, t.table, t.key);
}

// Live-row occupancy probe for a captured source-owned root row's natural key (#509).
// Between the delete/merge and the undo, a resync may have re-created a row under the
// same natural key (when no tombstone held — e.g. a delete captured before this
// mechanism shipped). Restoring the captured row verbatim would then throw on
// UNIQUE(profile_id, external_id) / (date, source). This returns the id of the live
// row already occupying the key, or null when the key is free (the normal, tombstone-
// protected case). Only meaningful for source-owned rows; a manual root returns null.
export function liveRowIdForCapturedRoot(
  profileId: number,
  ownedTable: string,
  row: Record<string, unknown>
): number | null {
  const t = importTombstoneForRow(ownedTable, row);
  if (!t) return null;
  let found: { id: number } | undefined;
  if (ownedTable === "activities") {
    found = db
      .prepare(
        `SELECT id FROM activities WHERE profile_id = ? AND external_id = ?`
      )
      .get(profileId, row.external_id) as { id: number } | undefined;
  } else if (ownedTable === "medical_records") {
    found = db
      .prepare(
        `SELECT id FROM medical_records WHERE profile_id = ? AND external_id = ?`
      )
      .get(profileId, row.external_id) as { id: number } | undefined;
  } else if (ownedTable === "body_metrics") {
    found = db
      .prepare(
        `SELECT id FROM body_metrics WHERE profile_id = ? AND date = ? AND source IS ?`
      )
      .get(profileId, row.date, row.source) as { id: number } | undefined;
  }
  return found ? found.id : null;
}
