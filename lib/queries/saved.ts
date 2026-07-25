import { db, writeTx } from "../db";
import {
  orderSavedRefs,
  moveInOrder,
  type SavedKind,
  type SavedRef,
} from "../saved-items";

// The unified save store's SQL layer (issue #1456) over `saved_items` (migration
// 113) — the ONE table behind the ★ star gesture, folding the retired
// `starred_biomarkers` table and `trend_pins` settings KV.
//
// Everything here is profileId-first and auth-blind (the lib write-core convention):
// the Server Actions in app/(app)/saved/actions.ts are the auth boundary.
//
// BIOMARKER SAVES ARE FAMILY-KEYED (#482) AND LIVE IN lib/queries/medical.ts —
// isBiomarkerSaved / saveBiomarker / unsaveBiomarkerFamily / getSavedBiomarkers /
// cleanupOrphanSavedBiomarkers all need the biomarker family identity SQL that lives
// there. This module holds the KIND-GENERIC store operations; a caller that needs
// biomarker semantics goes through those.

export interface SavedItemRow extends SavedRef {
  id: number;
  position: number | null;
  created_at: string;
}

// Every saved item for a profile, in canonical saved order (positioned first, then
// unpositioned newest-first). Optionally narrowed to one kind.
//
// The SQL hands rows over `id DESC` so orderSavedRefs — a STABLE sort — breaks a
// created_at tie newest-first: two stars in the same second are otherwise ordered by
// whatever order SQLite returns, which would make the grid shuffle unpredictably.
export function getSavedItems(
  profileId: number,
  kind?: SavedKind
): SavedItemRow[] {
  const rows = (
    kind
      ? (db
          .prepare(
            `SELECT id, kind, key, position, created_at FROM saved_items
              WHERE profile_id = ? AND kind = ?
              ORDER BY id DESC`
          )
          .all(profileId, kind) as SavedItemRow[])
      : (db
          .prepare(
            `SELECT id, kind, key, position, created_at FROM saved_items
              WHERE profile_id = ?
              ORDER BY id DESC`
          )
          .all(profileId) as SavedItemRow[])
  ).map((r) => ({ ...r, kind: r.kind as SavedKind }));
  return orderSavedRefs(rows);
}

// Whether an exact (kind, key) is saved. Biomarker callers should prefer
// isBiomarkerSaved (family-aware, #482); this is the kind-generic check the
// trend-metric toggle uses.
export function isItemSaved(
  profileId: number,
  kind: SavedKind,
  key: string
): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM saved_items WHERE profile_id = ? AND kind = ? AND key = ?`
      )
      .get(profileId, kind, key) != null
  );
}

// Save an item (idempotent — the NOCASE UNIQUE makes a re-save a no-op). New saves
// land unpositioned, which orders them at the FRONT of the unpositioned group
// (newest-first) and after every explicitly positioned row.
export function saveItem(
  profileId: number,
  kind: SavedKind,
  key: string
): void {
  db.prepare(
    `INSERT OR IGNORE INTO saved_items (profile_id, kind, key) VALUES (?, ?, ?)`
  ).run(profileId, kind, key);
}

// Unsave an exact (kind, key). Returns rows removed. Biomarker callers use
// unsaveBiomarkerFamily instead, so a save on any family member clears the family.
export function unsaveItem(
  profileId: number,
  kind: SavedKind,
  key: string
): number {
  return db
    .prepare(
      `DELETE FROM saved_items WHERE profile_id = ? AND kind = ? AND key = ?`
    )
    .run(profileId, kind, key).changes;
}

// Toggle an exact (kind, key), returning the resulting state. Check-then-act inside
// ONE write transaction so two concurrent toggles can't both read the same state and
// race into a double insert or an insert lost to a delete (the same discipline the
// star toggle has always had).
export function toggleItemSaved(
  profileId: number,
  kind: SavedKind,
  key: string
): boolean {
  return writeTx(() => {
    if (isItemSaved(profileId, kind, key)) {
      unsaveItem(profileId, kind, key);
      return false;
    }
    saveItem(profileId, kind, key);
    return true;
  });
}

// Move one saved item up/down within the profile's saved order — the reorder
// affordance that replaced the retired pin toggle on Trends Overview.
//
// Ordering is ONE list across kinds (the Overview grid interleaves saved biomarker
// and metric tiles), and the rewrite normalizes EVERY row to a dense 0..n-1 position,
// so a set that was half-unpositioned (a fresh star) becomes fully ordered on the
// first move instead of drifting. No-ops at the ends and for an unknown ref.
export function moveSavedItem(
  profileId: number,
  ref: SavedRef,
  direction: "up" | "down"
): void {
  writeTx(() => {
    const rows = getSavedItems(profileId);
    const index = rows.findIndex(
      (r) =>
        r.kind === ref.kind && r.key.toLowerCase() === ref.key.toLowerCase()
    );
    if (index < 0) return;
    const reordered = moveInOrder(rows, index, direction);
    const setPosition = db.prepare(
      `UPDATE saved_items SET position = ? WHERE id = ? AND profile_id = ?`
    );
    reordered.forEach((row, i) => setPosition.run(i, row.id, profileId));
  });
}
