// The findings-suppression store (issue #39/#227): the one snooze/dismiss ledger
// (upcoming_dismissals) behind BOTH the Upcoming filter and the generalized
// findings bus, plus the name-keyed suppression lifecycle helpers (#203/#283)
// that clear/re-key rows at delete/rename seams. Every read/write is
// profile-scoped (enforced by lib/__tests__/profile-scoping.test.ts and the
// dynamic no-bleed guard in lib/__db_tests__/upcoming.scoping.test.ts).

import { db } from "../../db";
import { type SuppressionRecord } from "../../upcoming-suppress";
import {
  biomarkerDismissalKey,
  biomarkerFlagDismissalKey,
  immunizationDismissalKey,
  immunizationCodesLosingBacking,
} from "../../dismissal-keys";
import { cleanupOrphanStars, biomarkerFamilyKey } from "../medical";

// The profile's snooze/dismiss rows, keyed by signal_key (a Finding's dedupeKey)
// for O(1) lookup during filtering. This is the shared read behind BOTH the
// Upcoming filter and the generalized findings bus (coaching/digest, issue #39):
// every engine's suppression lives in the one upcoming_dismissals store, so a
// single map answers "is this key suppressed?" for all of them. Profile-scoped
// (the WHERE filters profile_id — enforced by lib/__tests__/profile-scoping.test.ts
// and lib/__db_tests__/upcoming.scoping).
export function getFindingSuppressions(
  profileId: number
): Map<string, SuppressionRecord> {
  const rows = db
    .prepare(
      `SELECT signal_key, snooze_until, dismissed_at
         FROM upcoming_dismissals WHERE profile_id = ?`
    )
    .all(profileId) as {
    signal_key: string;
    snooze_until: string | null;
    dismissed_at: string | null;
  }[];
  const m = new Map<string, SuppressionRecord>();
  for (const r of rows)
    m.set(r.signal_key, {
      snooze_until: r.snooze_until,
      dismissed_at: r.dismissed_at,
    });
  return m;
}

// ---- Generalized suppression writers (issue #39) ----
// The table-usage side of the findings bus: the Upcoming actions AND the coaching/
// digest dismiss affordances all funnel through these, so there's one upsert/delete
// on upcoming_dismissals rather than a copy per surface. Each is profile-scoped and
// keyed by an arbitrary Finding dedupeKey (existing Upcoming keys unchanged).

// Snooze a finding until `until` (YYYY-MM-DD), clearing any dismiss — upserts on
// the (profile_id, signal_key) unique index so re-snoozing just moves the date.
export function snoozeFinding(
  profileId: number,
  dedupeKey: string,
  until: string
): void {
  db.prepare(
    `INSERT INTO upcoming_dismissals (profile_id, signal_key, snooze_until, dismissed_at)
       VALUES (?, ?, ?, NULL)
     ON CONFLICT(profile_id, signal_key)
       DO UPDATE SET snooze_until = excluded.snooze_until, dismissed_at = NULL`
  ).run(profileId, dedupeKey, until);
}

// Dismiss a finding indefinitely (until restored), clearing any snooze so a
// dismiss always wins.
export function dismissFinding(profileId: number, dedupeKey: string): void {
  db.prepare(
    `INSERT INTO upcoming_dismissals (profile_id, signal_key, snooze_until, dismissed_at)
       VALUES (?, ?, NULL, datetime('now'))
     ON CONFLICT(profile_id, signal_key)
       DO UPDATE SET dismissed_at = datetime('now'), snooze_until = NULL`
  ).run(profileId, dedupeKey);
}

// Restore a finding: drop its suppression row so it reappears immediately.
export function restoreFinding(profileId: number, dedupeKey: string): void {
  db.prepare(
    "DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key = ?"
  ).run(profileId, dedupeKey);
}

// ---- Name-keyed suppression lifecycle (issue #203) ----
// upcoming_dismissals is keyed by a REUSABLE string (a biomarker's canonical name,
// a vaccine code), so a dismissal left behind after its subject is deleted/renamed
// silently re-attaches to a later subject that reuses the same key (AGENTS.md #224:
// "names and codes DO recycle"). These helpers clear/re-key those rows at the
// delete/rename seams, mirroring cleanupOrphanStars on the star store. Each is
// profile-scoped.

// Drop biomarker retest dismissals (`biomarker:<family>`) AND flagged-result
// dismissals (`biomarker-flag:<family>`, issues #283/#564) whose backing readings
// are all gone, so dismissing a nudge → deleting every reading → re-adding the
// marker later re-surfaces the nudge instead of it being suppressed by the stale
// row. BOTH keys are now the #482 FAMILY identity (biomarkerFamilyKey) — the flag
// key moved to the family in #564 to share the trajectory acknowledgment — so each
// is de-orphaned only when NO family member has a reading left, and a stale
// legacy per-name flag row (from before #564) is de-orphaned here too (its suffix
// isn't in the family-key set). A dismissal with no matching reading can never fire
// again, so removing it is a pure de-orphan (mirrors cleanupOrphanStars).
// 11 = length('biomarker:') + 1; 16 = length('biomarker-flag:') + 1.
export function cleanupOrphanBiomarkerDismissals(profileId: number): void {
  db.prepare(
    `DELETE FROM upcoming_dismissals
       WHERE profile_id = ?
         AND signal_key LIKE 'biomarker:%'
         AND substr(signal_key, 11) NOT IN (
           SELECT DISTINCT lower(${biomarkerFamilyKey()})
             FROM medical_records WHERE profile_id = ?
         )`
  ).run(profileId, profileId);
  db.prepare(
    `DELETE FROM upcoming_dismissals
       WHERE profile_id = ?
         AND signal_key LIKE 'biomarker-flag:%'
         AND substr(signal_key, 16) NOT IN (
           SELECT DISTINCT lower(${biomarkerFamilyKey()})
             FROM medical_records WHERE profile_id = ?
         )`
  ).run(profileId, profileId);
}

// One call that sweeps BOTH name-keyed biomarker side-stores — the star pins
// (starred_biomarkers) and the retest/flag dismissals (upcoming_dismissals) — of
// any row whose backing readings are all gone. Both stores key on a REUSABLE
// canonical name, so every operation that removes readings (a record delete, a
// document delete/reprocess/reassign) can orphan either one, and a name that later
// recycles silently re-attaches the stale pin/snooze (AGENTS.md row-ops: "names and
// codes DO recycle" — the #203/#283 class). The per-record edit/delete paths already
// swept both, but the document-level resets swept only stars (#327); bundling the
// two here means the next document-level operation can't clean one and forget the
// other (same disease as the import-footprint two-lists rule). Profile-scoped.
export function cleanupOrphanBiomarkerKeyedState(profileId: number): void {
  cleanupOrphanStars(profileId);
  cleanupOrphanBiomarkerDismissals(profileId);
}

// Re-key a biomarker's star + retest/flag dismissals when its canonical name is
// renamed: the user's pin/snooze intent follows the reading to its new name rather
// than orphaning under the old (manifestations 3 & 4). UPDATE OR IGNORE so a
// collision with an existing star/dismissal already under the new name is a no-op;
// the caller then runs the orphan sweeps to drop any leftover old row. The star
// store matches COLLATE NOCASE (as its writers do); the dismissal keys are already
// lowercased. The `biomarker-flag:` key (the hero's flagged-result dismissal,
// issue #283) rides the same lifecycle.
export function migrateRenamedBiomarker(
  profileId: number,
  oldName: string,
  newName: string
): void {
  db.prepare(
    `UPDATE OR IGNORE starred_biomarkers
        SET canonical_name = ?
      WHERE profile_id = ? AND canonical_name = ? COLLATE NOCASE`
  ).run(newName, profileId, oldName);
  // If the rename COLLIDED with an existing pin under the new name (UPDATE OR
  // IGNORE left the old row), drop the now-redundant old star. Before #482 the
  // family-blind orphan sweep dropped it (the old name lost its backing on rename);
  // the family-aware sweep keeps a same-family sibling backed, so the collapse has
  // to be explicit here — a rename must never leave two pins on one family.
  db.prepare(
    `DELETE FROM starred_biomarkers
      WHERE profile_id = ? AND canonical_name = ? COLLATE NOCASE`
  ).run(profileId, oldName);
  const rekey = db.prepare(
    `UPDATE OR IGNORE upcoming_dismissals
        SET signal_key = ?
      WHERE profile_id = ? AND signal_key = ?`
  );
  rekey.run(
    biomarkerDismissalKey(newName),
    profileId,
    biomarkerDismissalKey(oldName)
  );
  rekey.run(
    biomarkerFlagDismissalKey(newName),
    profileId,
    biomarkerFlagDismissalKey(oldName)
  );
}

// Clear the retest dismissals for the given immunization component codes (their
// last backing dose was just deleted — see immunizationCodesLosingBacking), so
// re-adding that immunization later re-surfaces the due nudge. A no-op for the
// empty set (the common case: the deleted dose still has a sibling crediting it).
export function clearImmunizationDismissals(
  profileId: number,
  codes: string[]
): void {
  if (codes.length === 0) return;
  const placeholders = codes.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM upcoming_dismissals
       WHERE profile_id = ? AND signal_key IN (${placeholders})`
  ).run(profileId, ...codes.map(immunizationDismissalKey));
}

// The ONE immunization dismissal sweep behind every path that un-backs a vaccine
// code — a per-dose delete, an edit that re-codes a dose, and a Data → Manage bulk
// delete (issue #376). Given the vaccine strings of the doses just removed (or
// re-coded away from), it reads the doses that REMAIN for the profile and clears
// the `immunization:<code>` dismissal of any component code whose last backing dose
// is now gone — so a later re-add re-surfaces the due nudge instead of hitting a
// stale suppression (issue #203). Scoped to the removed doses' component codes on
// purpose, so a vaccine the profile has never recorded keeps its lasting dismissal.
// Must be called AFTER the delete/update so "remaining" reflects the new state, and
// with the removed vaccines captured BEFORE it (their rows are gone afterward).
export function sweepImmunizationDismissals(
  profileId: number,
  removedVaccines: string[]
): void {
  if (removedVaccines.length === 0) return;
  const remaining = (
    db
      .prepare(
        "SELECT DISTINCT vaccine FROM immunizations WHERE profile_id = ?"
      )
      .all(profileId) as { vaccine: string }[]
  ).map((r) => r.vaccine);
  const lost = new Set<string>();
  for (const v of removedVaccines)
    for (const c of immunizationCodesLosingBacking(v, remaining)) lost.add(c);
  clearImmunizationDismissals(profileId, [...lost]);
}
