// Write cores for the unit-mislabel correction (issue #761). profileId-first, and the id
// must be the one a write gate returned: the parameter is lib/auth's
// WriteAuthorizedProfileId, which only the three gates mint, so an action that never gated
// holds nothing these take — `tsc` refuses a call here that passes a plain `number` (#5348).
// The DELIBERATE forgery, a cast, is refused in EVERY production module: eslint.config.mjs's
// WRITE_BRAND_CAST (#5852) matches the brand by name, through a type alias or a renaming
// re-export, and since #5864 it reaches lib/revalidate.ts and the repo-root entrypoints too
// — which is what closed #5856. A coverage test in lib/__tests__ asserts that from ESLint's
// own resolved config rather than from a list, so a new root file or a new `ignores` entry
// reds the scan on the commit that adds it. lib/auth.ts, which mints the brand, is the one
// declared owner, exempted by the config's own `without()` block rather than a disable
// comment; and a TEST TIER MAY STILL CAST, the same allowance RPE_BRAND_CAST makes.
//
// THE RESIDUAL IS NOT A CAST, so no lint coverage closes it: `tsc` alone does not refuse an
// unbranded call written in METHOD position (an interface member declared `f(id: number)`
// accepts a branded-parameter function — method parameters stay bivariant even under
// `strict`, while the property spelling `f: (id: number) => …` is refused at TS2322), nor
// one whose argument is an implicit `any` from JSON.parse. So "calls a branded core" is
// EVIDENCE of a gate, not PROOF of one — recorded at
// lib/__tests__/actions-write-access.test.ts, whose step-aside formally rests on it.
//
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
