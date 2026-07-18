// Auth-blind write core for the protein-grams quick-add log (issue #824). Takes
// profileId first and never imports lib/auth — the profileId-first + lib-write-core
// convention (like lib/food-log-write.ts): the addProteinGrams / undoProteinGrams
// Server Actions own the auth gate and call these, so the ingestion path is one
// computation. Protein powder / shakes have no food-group catalog home (a
// `protein_shake` group would double-count the milk/eggs someone also logs), so this
// is the shake path: a single running gram total per (profile, date) that SUMS with the
// food-group estimated floor and is overridden by an integration's tracked protein_g
// (see lib/protein.ts proteinIntake()).
//
// One row per (profile, date) whose `grams` an add increments and an undo decrements;
// the keyed upsert is idempotent-friendly and the row is dropped once it returns to
// zero (no stray zero rows — the food_log discipline). Every add also records the
// amount as the per-profile "last used" preset (scoop sizes repeat), so the quick-add
// can re-offer it next time.

import { db, writeTx } from "./db";
import { setProfileSetting } from "./settings";

// The per-profile settings key holding the most recent add amount, so the quick-add
// pre-fills the last scoop size. A settings-tier value (not profile-owned data), so
// it isn't covered by the owned-table scoping test.
export const PROTEIN_QUICKADD_LAST_KEY = "protein_quickadd_last";

// The sane bounds for one quick-add entry: positive, and capped so a fat-fingered
// "3000" can't dominate the day's estimate. A scoop is ~20–30 g; a very high single
// entry (a big shake) is still well under 300.
const MAX_GRAMS_PER_ADD = 300;

// The typed result of an add, so a caller answers from what ACTUALLY happened rather
// than unconditionally confirming (the markDoseTaken/food-log contract):
//   logged   — grams were added; `grams` is the day's new manual-protein total.
//   invalid  — the amount was non-positive or over the per-add cap; nothing written.
export type ProteinAddOutcome =
  { kind: "logged"; grams: number } | { kind: "invalid" };

// The typed result of an undo: grams were removed and `grams` is the day's REMAINING
// manual-protein total (0 once the row is dropped), or the amount was invalid. Undo is
// idempotent — undoing a day with nothing logged is a no-op that reports 0.
export type ProteinUndoOutcome =
  { kind: "undone"; grams: number } | { kind: "invalid" };

// True for a finite, positive amount within the per-add cap.
function validGrams(grams: number): boolean {
  return Number.isFinite(grams) && grams > 0 && grams <= MAX_GRAMS_PER_ADD;
}

// Add N grams of protein on a day. Upserts the day's row, incrementing its grams, and
// records the amount as the last-used preset. Returns the day's resulting total. Single
// IMMEDIATE transaction (#468) so the upsert + the total read see one consistent state
// under a concurrent web/notify write.
export function addProteinGramsCore(
  profileId: number,
  date: string,
  grams: number
): ProteinAddOutcome {
  if (!validGrams(grams)) return { kind: "invalid" };
  return writeTx(() => {
    db.prepare(
      `INSERT INTO protein_log (profile_id, date, grams)
       VALUES (?, ?, ?)
       ON CONFLICT (profile_id, date)
       DO UPDATE SET grams = grams + excluded.grams`
    ).run(profileId, date, grams);
    // Remember this scoop size as the profile's last-used preset.
    setProfileSetting(profileId, PROTEIN_QUICKADD_LAST_KEY, String(grams));
    const row = db
      .prepare(
        `SELECT grams FROM protein_log WHERE profile_id = ? AND date = ?`
      )
      .get(profileId, date) as { grams: number } | undefined;
    return { kind: "logged", grams: row?.grams ?? grams };
  });
}

// Undo N grams on a day: decrement the day's row, clamp at zero (an undo can never
// drive it negative — the CHECK would throw), and drop the row when it hits zero so a
// fully-undone day leaves no stray row. Single IMMEDIATE transaction (#468) — the
// clamped decrement, the zero-cleanup DELETE, and the remaining read see one consistent
// state. Does NOT touch the last-used preset (an undo shouldn't rewrite the scoop size).
export function undoProteinGramsCore(
  profileId: number,
  date: string,
  grams: number
): ProteinUndoOutcome {
  if (!validGrams(grams)) return { kind: "invalid" };
  return writeTx(() => {
    db.prepare(
      `UPDATE protein_log
          SET grams = MAX(0, grams - ?)
        WHERE profile_id = ? AND date = ?`
    ).run(grams, profileId, date);
    db.prepare(
      `DELETE FROM protein_log
        WHERE profile_id = ? AND date = ? AND grams <= 0`
    ).run(profileId, date);
    const row = db
      .prepare(
        `SELECT grams FROM protein_log WHERE profile_id = ? AND date = ?`
      )
      .get(profileId, date) as { grams: number } | undefined;
    return { kind: "undone", grams: row?.grams ?? 0 };
  });
}
