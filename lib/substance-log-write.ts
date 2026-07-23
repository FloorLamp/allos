// Auth-blind write core for the non-food substance ledger (issue #1078) — the
// food-log-write pattern re-instantiated for `substance_log` (nicotine/cannabis;
// alcohol stays on food_log). Takes profileId first and never imports lib/auth
// (#319): the Server Actions in app/(app)/medical/substance-use/actions.ts are the
// only callers today, and any future surface (a Telegram button, a widget) reuses
// this same computation. The auth gate stays entirely in the action.
//
// One use = one row per (profile, date, substance) whose `units` count is
// incremented; the keyed upsert is idempotent-friendly. `substance` is validated
// against the substance catalog (only 'substance-log'-ledger substances land here)
// so a forged/stale key writes nothing and is answered honestly by the caller.
// NEVER GAMIFIED (#998/#1078 law): these writes never touch `activities`, so the
// milestone/streak machinery stays structurally blind to the domain.

import { db, writeTx } from "./db";
import { now as clockNow } from "./clock";
import { isSubstanceLogged, type Substance } from "./substance-use";

// The typed result of a unit write (the markDoseTaken contract, #232): the caller
// answers from what ACTUALLY happened, never unconditionally confirms.
//   logged            — a use was recorded; `units` is the substance's new daily total.
//   unknown-substance — not a substance_log-ledger substance; nothing written.
export type SubstanceLogOutcome =
  | { kind: "logged"; units: number; substance: Substance }
  | { kind: "unknown-substance" };

// The typed result of an undo: a use was removed and `units` is the REMAINING
// daily total (0 once the row is dropped). Undo is idempotent — undoing a day
// with nothing logged is a no-op that reports 0.
export type SubstanceUndoOutcome =
  | { kind: "undone"; units: number; substance: Substance }
  | { kind: "unknown-substance" };

// Log one use of a substance on a day. Upserts the day's row, incrementing its
// units, and returns the resulting daily total. Single IMMEDIATE transaction
// (#468) so the upsert + the count read see one consistent state under a
// concurrent tap. `loggedAt` records the LAST tap instant (injectable for tests;
// production always passes the default).
export function logSubstanceUnitCore(
  profileId: number,
  substance: string,
  date: string,
  loggedAt: string = clockNow().toISOString()
): SubstanceLogOutcome {
  if (!isSubstanceLogged(substance)) return { kind: "unknown-substance" };
  return writeTx(() => {
    db.prepare(
      `INSERT INTO substance_log (profile_id, date, substance, units, logged_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (profile_id, date, substance)
       DO UPDATE SET units = units + 1, logged_at = excluded.logged_at`
    ).run(profileId, date, substance, loggedAt);
    const row = db
      .prepare(
        `SELECT units FROM substance_log
          WHERE profile_id = ? AND date = ? AND substance = ?`
      )
      .get(profileId, date, substance) as { units: number } | undefined;
    return { kind: "logged", units: row?.units ?? 1, substance };
  });
}

// Undo one use of a substance on a day: decrement the day's row and drop it when
// it would hit zero, so a fully-undone day leaves no stray row (the
// undoFoodServingCore shape). Single IMMEDIATE transaction (#468).
export function undoSubstanceUnitCore(
  profileId: number,
  substance: string,
  date: string
): SubstanceUndoOutcome {
  if (!isSubstanceLogged(substance)) return { kind: "unknown-substance" };
  return writeTx(() => {
    db.prepare(
      `UPDATE substance_log SET units = units - 1
        WHERE profile_id = ? AND date = ? AND substance = ? AND units > 0`
    ).run(profileId, date, substance);
    db.prepare(
      `DELETE FROM substance_log
        WHERE profile_id = ? AND date = ? AND substance = ? AND units <= 0`
    ).run(profileId, date, substance);
    const row = db
      .prepare(
        `SELECT units FROM substance_log
          WHERE profile_id = ? AND date = ? AND substance = ?`
      )
      .get(profileId, date, substance) as { units: number } | undefined;
    return { kind: "undone", units: row?.units ?? 0, substance };
  });
}
