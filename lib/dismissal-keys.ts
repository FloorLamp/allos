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
import { preventiveRuleByKey } from "./preventive-catalog";
import { preventiveSignalKey } from "./preventive-upcoming";

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

// The dashboard hero keys a newly-flagged biomarker on `biomarker-flag:<family>`,
// on the SAME #482 biomarker FAMILY identity the retest key uses (biomarkerFamily
// over the canonical/raw name) — so a flag dismiss follows the whole analyte family
// (a dismiss on "Vitamin D3" covers "Vitamin D2 / Total 25-OH", the D2/D3/total the
// way retest already does) and the key doesn't drift as which member is the newest
// reading. This is ALSO the shared flag+trajectory acknowledgment key (#564): the
// trajectory finding carries it as `supersedes` and `dismissTrajectory` writes it,
// so dismissing EITHER the flag or the analyte's trajectory silences both ("dismiss
// once, silence everywhere"). A non-family analyte's family key is just its own
// lowercased name, so its flag key is byte-identical to the pre-#482/#564 form (no
// stored dismissal breaks); only family members (vitamin D, A1c) re-key, following
// the same resurface-then-re-key lifecycle #482 gave the retest key. The #203
// cleanup/re-key seams (cleanupOrphanBiomarkerDismissals — now family-aware for this
// key too) cover it (issue #283).
export function biomarkerFlagDismissalKey(name: string): string {
  return `biomarker-flag:${biomarkerFamily(name).toLowerCase()}`;
}

// The Upcoming preventive item + its push cousin key on `<kind>:<ruleKey>`
// (preventiveSignalKey — e.g. "screening:colorectal_cancer"). A dismissal is stored
// under that full key, but the episode-end sweep (recordPreventiveDone / the nudge's
// toClear) only knows the rule key — so resolve the rule's KIND from the catalog to
// reproduce the exact signal key the dismiss was stored under (issue #1024). Returns
// null for an unknown rule key (nothing to retire). Centralized here so the sweep
// derives the identical key the item/nudge does (the #227 alignment).
export function preventiveDismissalKey(ruleKey: string): string | null {
  const rule = preventiveRuleByKey(ruleKey);
  if (!rule) return null;
  return preventiveSignalKey(rule.kind, ruleKey);
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
