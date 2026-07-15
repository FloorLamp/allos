// Write cores for the unit-mislabel correction (issue #761). Auth-BLIND — the Data
// → Review Server Actions own the requireWriteAccess() gate; these take profileId
// first (the profileId-first convention) and never import lib/auth. Every statement
// is profile-scoped, so a foreign id changes nothing.

import { db, writeTx } from "./db";
import {
  detectRecordUnitMislabel,
  reconcileFlags,
  unitMislabelSignalKey,
} from "./queries/medical";

// Captured prior state for the reversible Apply (row-ops side-state, #199/#202): a
// correction is a row op, so undo must restore the prior unit AND the prior derived
// flag AND the prior edit-lock — not just the unit.
export interface UnitMislabelUndo {
  id: number;
  unit: string | null;
  flag: string | null;
  edited: number;
}

export type ApplyUnitMislabelResult =
  { ok: true; undo: UnitMislabelUndo } | { ok: false; error: string };

// Apply the proposed unit correction. Re-detects server-side (never trusts a client-
// supplied unit — the corrected unit is re-derived from the stored row), corrects the
// stored `unit`, sets the `edited` edit-lock (#133) so a later re-extraction/sync
// can't silently revert the approved fix, and re-derives the flag (now that the unit
// is right, the #761 suppression lifts and the true — typically Normal — flag is
// computed). Returns the captured prior state for undo.
export function applyUnitMislabelCorrection(
  profileId: number,
  recordId: number
): ApplyUnitMislabelResult {
  const hit = detectRecordUnitMislabel(profileId, recordId);
  if (!hit)
    return {
      ok: false,
      error: "No unit correction is available for this record.",
    };

  const prior = db
    .prepare(
      "SELECT unit, flag, edited FROM medical_records WHERE id = ? AND profile_id = ?"
    )
    .get(recordId, profileId) as
    | { unit: string | null; flag: string | null; edited: number | null }
    | undefined;
  if (!prior) return { ok: false, error: "Record not found." };

  writeTx(() => {
    db.prepare(
      "UPDATE medical_records SET unit = ?, edited = 1 WHERE id = ? AND profile_id = ?"
    ).run(hit.correctedUnit, recordId, profileId);
  });
  // Re-derive the flag now that the unit is corrected (own IMMEDIATE tx inside).
  reconcileFlags(profileId, [recordId]);

  return {
    ok: true,
    undo: {
      id: recordId,
      unit: prior.unit,
      flag: prior.flag,
      edited: prior.edited ?? 0,
    },
  };
}

// Reverse an applied correction (row-ops side-state, #202): restore the prior unit,
// the prior derived flag, AND the prior edit-lock in one write. Profile-scoped, so a
// replayed token from another profile is a no-op. Returns whether a row changed.
export function undoUnitMislabelCorrection(
  profileId: number,
  undo: UnitMislabelUndo
): boolean {
  const info = db
    .prepare(
      "UPDATE medical_records SET unit = ?, flag = ?, edited = ? WHERE id = ? AND profile_id = ?"
    )
    .run(undo.unit, undo.flag, undo.edited ? 1 : 0, undo.id, profileId);
  return info.changes > 0;
}

// Record a mislabel detection as a false positive so it never re-surfaces. Uses the
// shared findings-suppression bus (upcoming_dismissals) — the same store the
// Upcoming/coaching dismissals use — keyed by the record id. Profile-scoped.
export function dismissUnitMislabel(profileId: number, recordId: number): void {
  db.prepare(
    `INSERT INTO upcoming_dismissals (profile_id, signal_key, dismissed_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(profile_id, signal_key)
     DO UPDATE SET dismissed_at = excluded.dismissed_at, snooze_until = NULL`
  ).run(profileId, unitMislabelSignalKey(recordId));
}
