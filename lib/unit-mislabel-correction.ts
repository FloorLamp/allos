// Write cores for the unit-mislabel correction (issue #761). profileId-first, and the id
// must be the one a write gate returned: the parameter is lib/auth's
// WriteAuthorizedProfileId, which only the three gates mint, so an action that never gated
// has no value to pass and `tsc` refuses the call (#5348). The DELIBERATE forgery is refused
// too, now that eslint.config.mjs's WRITE_BRAND_CAST bans the cast in production — including
// through a type alias or a renaming re-export (#5852). It has TWO limits, and the second is
// why it is not the whole barrier: it matches the brand BY NAME rather than chasing what a name
// resolves to, and it does not reach every production file. lib/revalidate.ts is named in the
// `ignores` of all three blocks carrying the ban, and the repo-root modules (middleware.ts,
// instrumentation-client.ts) sit outside PRODUCTION_TREES, so those three keep only the ten
// temporal selectors and a cast there is unrefused — filed as #5856, open. lib/, app/,
// components/ and scripts/ ARE covered, and `tsc` refuses the accidental ungated call
// everywhere regardless of any of this. lib/auth.ts, which mints the brand, is exempted by
// the config's own `without()` block rather than a disable comment, and a TEST TIER MAY
// STILL CAST — the same allowance RPE_BRAND_CAST makes.
// The import is type-only — erased at build, so these cores still run auth-blind and the
// Data → Review Server Actions still own the requireWriteAccess() gate. Every statement is
// profile-scoped, so a foreign id changes nothing.

import type { WriteAuthorizedProfileId } from "./auth";
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
  profileId: WriteAuthorizedProfileId,
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
  profileId: WriteAuthorizedProfileId,
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
export function dismissUnitMislabel(
  profileId: WriteAuthorizedProfileId,
  recordId: number
): void {
  db.prepare(
    `INSERT INTO upcoming_dismissals (profile_id, signal_key, dismissed_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(profile_id, signal_key)
     DO UPDATE SET dismissed_at = excluded.dismissed_at, snooze_until = NULL`
  ).run(profileId, unitMislabelSignalKey(recordId));
}
