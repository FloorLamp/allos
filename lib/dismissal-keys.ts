// Pure key helpers for the name-keyed suppression stores (upcoming_dismissals)
// and the starred-biomarker pin, plus the set logic that decides which of those
// name/code-keyed rows have lost their subject (issue #203).
//
// Why this exists: `upcoming_dismissals.signal_key` and
// `saved_items.key` (kind='biomarker') are keyed by REUSABLE strings (a canonical
// biomarker name, a vaccine code) — not an AUTOINCREMENT id — so when the subject
// they point at is deleted or renamed, the row can silently re-attach to a
// DIFFERENT later subject that reuses the same string (AGENTS.md #224: "names and
// codes DO recycle"). The write paths (Server Actions) call the DB helpers in
// lib/queries; the reusable key derivation + "which codes lost their backing"
// arithmetic lives here so it's unit-testable without a DB.

import { expandToComponents } from "./immunization-catalog";
import { biomarkerFamily, biomarkerRetestIdentity } from "./canonical-name";
import { preventiveRuleByKey } from "./preventive-catalog";
import { preventiveSignalKey } from "./preventive-upcoming";
import { equipmentLoadLane, movementLoadKey } from "./lifts";
import { activityHistoryKey } from "./activities-catalog";

// The Upcoming retest nudge keys a biomarker on `biomarker:<retest identity>`
// (lib/queries/upcoming). The identity is the reading's RETEST-clock grouping
// (biomarkerRetestIdentity — the #482 biomarker FAMILY for every analyte, WIDENED
// to the broad total+D2+D3 vitamin-D key for the 25-OH storage form, #1193), so a
// dismiss/snooze on ANY family member silences the whole family's retest nudge — and
// the key is stable no matter which member happens to be the newest reading (before
// #482 it keyed the bare representative name, which drifted as readings were added).
// The vitamin-D fractions share the total's retest clock (a fresh total supersedes an
// old D2/D3 breakdown), so they MUST resolve to the same retest key even though they
// now flag independently — that's why this uses the RETEST identity, not the (now
// narrowed) plain biomarkerFamily. A non-family analyte's key is just its own
// lowercased name, unchanged. Centralized so the dismissal cleanup / re-key derive
// the exact same key the nudge does.
export function biomarkerDismissalKey(name: string): string {
  return `biomarker:${biomarkerRetestIdentity(name).toLowerCase()}`;
}

// The dashboard hero keys a newly-flagged biomarker on `biomarker-flag:<family>`,
// on the #482 biomarker FAMILY identity (biomarkerFamily over the canonical/raw
// name) — so a flag dismiss follows the analyte's IDENTITY family and the key doesn't
// drift as which member is the newest reading. This is the IDENTITY scope, NOT the
// retest scope: the vitamin-D D2/D3 fractions now flag INDEPENDENTLY (#1193), each on
// its OWN key, so dismissing a flagged D3 fraction does NOT silence a flagged total
// (they are distinct measurements). The A1c ↔ eAG family and the vitamin-D TOTAL
// spellings still share one flag key. This is ALSO the shared flag+trajectory
// acknowledgment key (#564): the trajectory finding carries it as `supersedes` and
// `dismissTrajectory` writes it, so dismissing EITHER the flag or the analyte's
// trajectory silences both ("dismiss once, silence everywhere"). A non-family
// analyte's family key is just its own lowercased name, so its flag key is
// byte-identical to the pre-#482/#564 form (no stored dismissal breaks). The #203
// cleanup/re-key seams (cleanupOrphanBiomarkerDismissals — family-aware for this key
// too) cover it (issue #283).
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

// ---- Personal-record celebrations (issue #1931) ----------------------------
//
// A PR finding (lib/findings.ts::prToFinding / cardioPrToFinding) rides the same
// suppression bus as everything else, so its dedupeKey is a persisted, recyclable
// string like every other row in `upcoming_dismissals`. Two things were wrong with the
// original shape, and they are the same #203/#482 disease one domain apart:
//
//   1. It keyed the RAW DISPLAY NAME (`pr:strength:${pr.exercise}@…`), not the identity
//      its own stats are grouped on. `getStrengthByExercise(profileId, true)` groups on
//      `movementLoadKey` — variant-collapsed movement + equipment lane — and ships the
//      group's FIRST-SEEN logged spelling as `exercise`. So "Barbell Curl" and "Curl"
//      are ONE record but produced two different keys, and deleting the oldest session
//      silently re-spelled the key of a record that had not changed. Same for cardio,
//      whose stats group case-insensitively while the key carried the raw casing. This
//      is exactly what #1399/#1610 fixed for the plateau/stale findings, which now key
//      on `movementLoadKey`/`exerciseHistoryKey`; the PR celebration was left behind.
//   2. Nothing swept it. A dismissal minted for a movement/activity whose sets are
//      later renamed, re-laned or deleted stays in the table forever, and a genuinely
//      NEW record earned under a recycled name arrives pre-silenced — the celebration
//      the user never sees. `cleanupOrphanPrDismissals` (lib/queries/upcoming) is the
//      sweep, run from every seam that can un-back a key.
//
// Both key builders below therefore resolve identity through the SAME canonical pure
// functions the aggregates group on. The `legacy*` twins reproduce the pre-#1931 shape
// and are carried as `Finding.supersedes` (the #436 dual-read) so a dismissal stored
// under the old string keeps suppressing rather than orphaning on deploy.

export const PR_STRENGTH_PREFIX = "pr:strength:";
export const PR_CARDIO_PREFIX = "pr:cardio:";

// A strength record's suppression key: `pr:strength:<movementLoadKey>:<kind>`. The
// identity is the movement (variant-collapsed) plus the equipment lane, so two
// machines' records never silence each other and a variant spelling never mints a
// second key for one record.
export function prStrengthDismissalKey(
  exercise: string,
  equipmentId: number | null | undefined,
  kind: string
): string {
  return `${PR_STRENGTH_PREFIX}${movementLoadKey(exercise, equipmentId)}:${kind}`;
}

// The pre-#1931 raw-display-name shape, for dual-read only. Never written fresh.
export function legacyPrStrengthDismissalKey(
  exercise: string,
  equipmentId: number | null | undefined,
  kind: string
): string {
  return `${PR_STRENGTH_PREFIX}${exercise}@${equipmentLoadLane(equipmentId)}:${kind}`;
}

// A cardio record's suppression key: `pr:cardio:<activityHistoryKey>:<kind>` — the
// case/space-folded activity identity `getCardioByActivity` groups on.
export function prCardioDismissalKey(activity: string, kind: string): string {
  return `${PR_CARDIO_PREFIX}${activityHistoryKey(activity)}:${kind}`;
}

// The pre-#1931 raw-display-name shape, for dual-read only. Never written fresh.
export function legacyPrCardioDismissalKey(
  activity: string,
  kind: string
): string {
  return `${PR_CARDIO_PREFIX}${activity}:${kind}`;
}

// The identity segment of a stored `pr:` key — everything between the namespace and
// the trailing `:<kind>` — normalized to the canonical identity so a LEGACY row
// (raw display name, raw casing) is compared against live history on the same terms
// the current builders use. Returns null for a key outside the two PR namespaces or
// one with no kind segment (a malformed row is left alone, never swept).
export function prDismissalIdentity(
  key: string
): { domain: "strength" | "cardio"; identity: string } | null {
  const domain = key.startsWith(PR_STRENGTH_PREFIX)
    ? ("strength" as const)
    : key.startsWith(PR_CARDIO_PREFIX)
      ? ("cardio" as const)
      : null;
  if (!domain) return null;
  const prefix = domain === "strength" ? PR_STRENGTH_PREFIX : PR_CARDIO_PREFIX;
  const tail = key.slice(prefix.length);
  const cut = tail.lastIndexOf(":");
  if (cut <= 0) return null;
  const subject = tail.slice(0, cut);
  if (domain === "cardio")
    return { domain, identity: activityHistoryKey(subject) };
  // `<name>@<lane>`; the lane is the last '@'-segment (a movement name may not
  // contain '@', but taking the LAST one is the safe read either way).
  const at = subject.lastIndexOf("@");
  if (at < 0) return null;
  return {
    domain,
    identity: movementLoadKey(
      subject.slice(0, at),
      lanePart(subject.slice(at + 1))
    ),
  };
}

// The equipment id a stored lane segment denotes: a numeric lane is that equipment
// row, anything else (the "none" sentinel, a corrupt segment) is the unassigned lane.
function lanePart(lane: string): number | null {
  const n = Number(lane);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Which of the profile's stored `pr:` dismissal keys have lost their backing history
// — the ones whose movement/lane (or activity) no longer appears in the profile's
// sets/activities at all. A dismissal with no backing can never suppress anything it
// was made for, and if the name is later recycled it suppresses something it was NOT
// made for, so removing it is a pure de-orphan (the cleanupOrphanBiomarkerDismissals
// shape, one domain over).
//
// CONSERVATIVE BY CONSTRUCTION: a key is swept only when neither its verbatim
// identity NOR its canonical normalization is live, and a key this module can't parse
// is never swept. Over-sweeping would resurface a celebration the user silenced on
// purpose; under-sweeping leaves a dead row that the next seam re-examines.
export function prDismissalKeysLosingBacking(
  storedKeys: readonly string[],
  liveStrengthIdentities: readonly string[],
  liveCardioIdentities: readonly string[]
): string[] {
  const strength = new Set(liveStrengthIdentities);
  const cardio = new Set(liveCardioIdentities);
  const lost: string[] = [];
  for (const key of storedKeys) {
    const parsed = prDismissalIdentity(key);
    if (!parsed) continue;
    const live = parsed.domain === "strength" ? strength : cardio;
    if (!live.has(parsed.identity)) lost.push(key);
  }
  return lost;
}
