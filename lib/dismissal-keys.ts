// Pure key helpers for the name-keyed suppression stores (upcoming_dismissals)
// and the starred-biomarker pin, plus the set logic that decides which of those
// name/code-keyed rows have lost their subject (issue #203).
//
// Why this exists: `upcoming_dismissals.signal_key` and
// `starred_biomarkers.canonical_name` are keyed by REUSABLE strings (a canonical
// biomarker name, a vaccine code) — not an AUTOINCREMENT id — so when the subject
// they point at is deleted or renamed, the row can silently re-attach to a
// DIFFERENT later subject that reuses the same string (AGENTS.md #224: "names and
// codes DO recycle"). The write paths (Server Actions) call the DB helpers in
// lib/queries; the reusable key derivation + "which codes lost their backing"
// arithmetic lives here so it's unit-testable without a DB.

import { expandToComponents } from "./immunization-catalog";
import { biomarkerFamily } from "./canonical-name";

// The Upcoming retest nudge keys a biomarker on `biomarker:<family identity>`
// (lib/queries/upcoming). The identity is the reading's #482 biomarker FAMILY
// (biomarkerFamily over the canonical name, falling back to the raw name), so a
// dismiss/snooze on ANY family member silences the whole family's retest nudge —
// and the key is stable no matter which member happens to be the newest reading
// (before #482 it keyed the bare representative name, which drifted as readings
// were added). A non-family analyte's family key is just its own lowercased name,
// so its dismissal key is unchanged. Centralized so the dismissal cleanup / re-key
// derive the exact same key the nudge does.
export function biomarkerDismissalKey(name: string): string {
  return `biomarker:${biomarkerFamily(name).toLowerCase()}`;
}

// The dashboard hero keys a newly-flagged biomarker on
// `biomarker-flag:<lowercased name>` (lib/attention.ts), on the SAME
// canonical-preferred name identity the retest nudge uses — so the flag
// dismissal follows the analyte, and the #203 cleanup/re-key seams below the
// retest key cover this key too (issue #283).
export function biomarkerFlagDismissalKey(name: string): string {
  return `biomarker-flag:${name.trim().toLowerCase()}`;
}

// The Upcoming immunization nudge keys on `immunization:<catalog code>`
// (lib/queries/upcoming.ts). The code is an assessment component code, not the
// raw stored vaccine string (a combo dose credits several component codes).
export function immunizationDismissalKey(code: string): string {
  return `immunization:${code}`;
}

// Given the vaccine code of a dose that was just deleted and the vaccine codes of
// the doses that REMAIN for the profile, the component catalog codes whose last
// backing dose is now gone — i.e. whose `immunization:<code>` dismissal is now
// stale and should be cleared so a later re-add re-surfaces the nudge.
//
// Scoped to the deleted dose's components on purpose: a vaccine the profile has
// NEVER recorded (no backing dose ever) can still carry a legitimate, lasting
// dismissal of its "overdue" nudge, so we must not sweep every unbacked code —
// only the ones this deletion actually un-backed.
export function immunizationCodesLosingBacking(
  deletedVaccine: string,
  remainingVaccines: string[]
): string[] {
  const stillCovered = new Set<string>();
  for (const v of remainingVaccines)
    for (const c of expandToComponents(v)) stillCovered.add(c);
  const lost: string[] = [];
  for (const c of expandToComponents(deletedVaccine))
    if (!stillCovered.has(c)) lost.push(c);
  return lost;
}
