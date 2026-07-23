import type Database from "better-sqlite3";

// The hand-edited (edit-locked) imported body-metric row (#133 user-edit lock, #659
// badge) that Trends → Body renders the "Sync locked" badge + "Resume sync updates"
// affordance for. seed-events.ts plants it once (a synthetic Withings weigh-in of
// 77.7 kg with edited=1, on a computed conflict-free day); its exact weight + source
// is the row's stable signature.
export const EDIT_LOCK_SIGNATURE = { source: "withings", weightKg: 77.7 };

// Restore the edit lock on `profileId`'s fixture row to its UNMERGED (edited=1) state.
// edit-lock-badge.spec CONSUMES the lock — its "Resume updates" click runs clearEditLock,
// which flips edited→0 (keeping the row) — so a --repeat-each iteration would otherwise
// find the badge already gone. This is the exact inverse: flip the seeded row back to
// edited=1 so every run starts locked (#868 fixture ownership; the dup-review precedent).
// Short-lived caller connection + busy timeout so it never contends with the running
// server on the WAL DB. Synthetic data only.
export function restoreEditLockRow(
  db: Database.Database,
  profileId: number
): void {
  db.prepare(
    `UPDATE body_metrics SET edited = 1
       WHERE profile_id = ? AND source = ? AND weight_kg = ?`
  ).run(profileId, EDIT_LOCK_SIGNATURE.source, EDIT_LOCK_SIGNATURE.weightKg);
}
