// Repeat dismissal read as an ANSWER (issue #2386) — the first concrete application
// of the declared-falsification half of the attention doctrine (issue #2385).
//
// PURE — no DB/network. The store is unchanged: `upcoming_dismissals` already holds a
// `signal_key` + `dismissed_at` per suppression, and `getFindingSuppressions` already
// reads the whole profile's rows into the map every findings surface consults. This
// module only DERIVES a second question from that same map:
//
//   the bus asks  "is this finding hidden right now?"      (lib/lifecycle.ts)
//   this asks     "how many separate raisings of this
//                  topic has the user already declined?"
//
// and turns the answer into a PROMINENCE, never into a silence.
//
// ── Counting: distinct RAISINGS, not rows ────────────────────────────────────
// `upcoming_dismissals` carries a UNIQUE (profile_id, signal_key), so dismissing one
// key twice UPDATES one row — several dismissals inside one appearance are already one
// row by construction, exactly as #2386 requires. What distinguishes separate raisings
// is the EPISODE ANCHOR the behavioural engines grew in #436: a finding's dedupeKey is
// `<topic stem>:<episode anchor>` and it DECLARES the stem — as `supersedes` for an
// engine that had a pre-anchor key, or as `episodeFamily` for one whose key was born
// anchored (#2543). So one stored row under `training-obs:stale:bench:2026-01` and
// another under `training-obs:stale:bench:2026-05` are two separate raisings of one
// topic, both declined — which is the signal. That makes the family a DECLARED fact of
// the finding (the engine chose the anchor), not a rule this module invents per
// namespace.
//
// A finding that declares NO episode anchor has no family, and therefore no fatigue: at
// most one row can exist for it, so it can never reach a threshold. That is the right
// answer and not a gap — those keys carry their evidence IN the identity (`digest:ldl:up`
// vs `digest:ldl:down`, `biomarker-flag:<family>`), which is the #203/#482 re-keying
// discipline #2386 cites: a moved reading is a DIFFERENT signal, it lands under a
// different key, its count starts at zero, and a newly flagged value speaks at full
// prominence however often its predecessor was declined.
//
// ── Where the answer is APPLIED ──────────────────────────────────────────────
// The dashboard reranks (`routineOrder`, #2538). The morning DIGEST drops (#2543): a
// line whose topic has been declined across separate raisings leaves the message and
// stays on the surface the user opens. Both are §2 reductions in contact, which the
// system may make unilaterally; neither writes anything, and neither can reach a signal
// whose dismissals the bus already refuses to honour — see the safety floor below.
//
// ── The safety floor ─────────────────────────────────────────────────────────
// Quieting is STRICTLY WEAKER than the dismissal that produced it: it may only reduce
// the prominence of findings the bus would already hide outright for a plain dismiss.
// `mayQuietOnDismissal` therefore does not carry a list of exempt findings — it ASKS
// `isHiddenUnderPolicy` (lib/lifecycle.ts), the one place the #449/#716/#942 safety
// carve-out is written, whether a dismiss is honoured at all. A dose reminder, a
// missed-dose escalation and the mental-health crisis finding declare "safety-ungated",
// so the bus ignores their dismissals entirely and this predicate answers false for them
// before any count is looked at; an overdue safety follow-up declares "snooze-only",
// which RESISTS a dismiss, so it answers false too. A finding cannot be quieted by
// having been dismissed unless being dismissed could silence it in the first place —
// which is the "impossible to violate by construction rather than by review" the issue
// asks for. lib/__tests__/dismissal-fatigue.test.ts enumerates
// LIFECYCLE_SUPPRESSION_POLICIES so a NEW policy must be classified before it ships.

import type { Finding } from "./findings";
import {
  isHiddenUnderPolicy,
  type LifecycleSuppressionPolicy,
} from "./lifecycle";
import type { SuppressionRecord } from "./upcoming-suppress";

// How loudly a finding may still be raised, most-to-least prominent. This is an
// ORDERING + REACH decision, never a silence: even "on-demand" keeps the finding
// rendered where the user goes looking for it.
export const FINDING_PROMINENCE = ["routine", "quiet", "on-demand"] as const;

export type FindingProminence = (typeof FINDING_PROMINENCE)[number];

// Distinct declined raisings at which a finding stops LEADING: it drops behind every
// unfatigued finding on its surface and leaves the routine push/digest set. Two is the
// first count that can be a pattern rather than an instance — one dismissal is the
// per-appearance mute the bus already implements, and reading it as an answer about the
// topic would make a single tap permanent.
export const QUIET_AFTER_DISMISSED_RAISINGS = 2;

// …and the count at which the ESCALATION completes: the finding leaves the routine
// surface altogether and is reachable only where the user goes looking (its own tab,
// and Upcoming's "Snoozed & dismissed" section for the rows that are stored there).
// Four separate declines of one topic is a sustained pattern by any reading; the
// mechanism still never deletes, never writes a user-owned field, and never stops the
// finding from being found.
export const RETIRE_AFTER_DISMISSED_RAISINGS = 4;

// A probe dismissal used to ask the ONE suppression decision whether a policy honours a
// dismiss at all. The date is irrelevant to the answer (a dismiss hides indefinitely
// under every policy that honours it), so any pair of well-formed values does; these are
// obviously-synthetic constants, never stored and never compared against real rows.
const DISMISS_PROBE: SuppressionRecord = {
  snooze_until: null,
  dismissed_at: "2000-01-01 00:00:00",
};
const PROBE_TODAY = "2000-01-02";

// Whether repeat dismissal may quiet a finding travelling under `policy` — the safety
// floor, DERIVED rather than declared. True only when the shared bus would hide the
// finding for a single plain dismiss, so this can never reach a signal whose dismissals
// the bus already refuses to honour ("safety-ungated", "snooze-only").
export function mayQuietOnDismissal(
  policy: LifecycleSuppressionPolicy
): boolean {
  return isHiddenUnderPolicy(policy, DISMISS_PROBE, PROBE_TODAY);
}

// The suppression policy a Finding travels under. Findings adapted from an UpcomingItem
// carry the item's declared policy across the bus (upcomingToFinding); everything else
// is an ordinary dismissible finding. Defaulting to "normal" is safe here BECAUSE
// quieting is strictly weaker than dismissal: a finding with no declared policy is one
// the bus already hides outright on a single dismiss, so nothing can be quieted that
// could not already be silenced. A signal that must resist the bus declares its policy —
// the same declaration that already stops a plain dismiss from silencing it.
export function findingSuppressionPolicy(
  finding: Pick<Finding, "suppressionPolicy">
): LifecycleSuppressionPolicy {
  return finding.suppressionPolicy ?? "normal";
}

// The TOPIC a finding's raisings belong to, or null when it declares no episode anchor.
//
// TWO WAYS TO DECLARE ONE, and the SAME validation for both: the stem must be a strict
// PREFIX of the dedupeKey with a separator between them.
//
//   1. `episodeFamily` — stated outright (#2543). The engines whose keys were BORN
//      anchored use this: `portal-sync:<portal>/<account>:<day>`,
//      `records-recency:<source>:<frontier>`, `digest-time:<configured>:<proposed>`.
//      They have no pre-anchor key to carry in `supersedes` and so had no way to say
//      what their stem was, which is why the digest half of #2386 found nothing to
//      count despite the anchors already being there.
//   2. `supersedes` — the #436 dual-read stem, which the behavioural engines already
//      carry for suppression compatibility and which doubles as their declaration.
//
// The prefix test is what keeps BOTH honest. `supersedes` is also used for a
// cross-finding acknowledgment that is NOT a stem (the biomarker trajectory carries
// `biomarker-flag:<family>` so a flag dismiss silences it, #564), and such a key is not
// a prefix of the finding's own, so it yields no family and no fatigue — correctly,
// since those two keys are one topic seen twice, not one topic raised twice. And it is
// what stops the explicit field from being a widening lever: a producer can only name a
// stem its own key already grew out of, never a broader namespace it does not sit under.
//
// WIDENING IS THE FAILURE MODE THIS MECHANISM INVITES (#2538's own metrics analysis, and
// #2543 restates it): any "declines avoided" measure rewards over-broad stems, because a
// broader family accumulates faster and quiets more. Nothing here widens a family, and
// nothing here invents one per namespace — the declaration is the producing engine's,
// made where its key is minted, from the same components.
export function findingEpisodeFamily(
  finding: Pick<Finding, "dedupeKey" | "supersedes" | "episodeFamily">
): string | null {
  const stem = finding.episodeFamily ?? finding.supersedes;
  if (!stem) return null;
  if (!finding.dedupeKey.startsWith(`${stem}:`)) return null;
  return stem;
}

// Whether a stored suppression row counts as a DISMISSAL for this purpose. A row with a
// live-or-expired `snooze_until` and no `dismissed_at` is a snooze — a deliberate
// "later", never an answer — and must not count. Everything else does, INCLUDING a row
// whose `dismissed_at` is null (#2386's data note: at least one stored row carries one).
// Nothing here reads the timestamp: the count is over distinct keys, so a dismissal of
// unknown date is still one dismissal and is neither discarded nor given a made-up date.
export function countsAsDismissal(record: SuppressionRecord): boolean {
  if (record.dismissed_at !== null) return true;
  return record.snooze_until === null;
}

// The profile's dismissed signal keys, extracted once from the map every findings
// surface already holds. Sorted for determinism.
export function dismissedSignalKeys(
  map: ReadonlyMap<string, SuppressionRecord>
): string[] {
  const keys: string[] = [];
  for (const [key, record] of map)
    if (countsAsDismissal(record)) keys.push(key);
  return keys.sort();
}

// How many distinct raisings of `family` the user has declined: the number of dismissed
// keys that are the stem itself or one of its anchored episodes. Distinct KEYS, so
// repeated dismissals inside one raising — which the unique index already folds into one
// row — count once.
export function dismissedRaisings(
  family: string | null,
  dismissedKeys: readonly string[]
): number {
  if (family === null) return 0;
  const anchored = `${family}:`;
  let n = 0;
  for (const key of dismissedKeys)
    if (key === family || key.startsWith(anchored)) n += 1;
  return n;
}

// The prominence a policy + decline count earns. The safety floor is the first branch
// and consults no count at all.
export function dismissalProminence(
  policy: LifecycleSuppressionPolicy,
  raisings: number
): FindingProminence {
  if (!mayQuietOnDismissal(policy)) return "routine";
  if (raisings >= RETIRE_AFTER_DISMISSED_RAISINGS) return "on-demand";
  if (raisings >= QUIET_AFTER_DISMISSED_RAISINGS) return "quiet";
  return "routine";
}

// One finding's prominence against the profile's dismissal keys.
export function findingProminence(
  finding: Pick<
    Finding,
    "dedupeKey" | "supersedes" | "episodeFamily" | "suppressionPolicy"
  >,
  dismissedKeys: readonly string[]
): FindingProminence {
  return dismissalProminence(
    findingSuppressionPolicy(finding),
    dismissedRaisings(findingEpisodeFamily(finding), dismissedKeys)
  );
}

// A findings list split by prominence — `routine` and `quiet` are what a surface renders
// in that order (so a fatigued finding never leads), `onDemand` is what it leaves to the
// go-looking surfaces. Order within each band is preserved, so a caller's own ranking
// still decides among equals.
export interface RankedFindings<T> {
  routine: T[];
  quiet: T[];
  onDemand: T[];
}

// Rank an already-suppression-filtered findings list by dismissal fatigue. The map is the
// same `getFindingSuppressions` result the caller used for `activeFindings`, so this adds
// no read and no new profile-scoping surface.
export function rankByDismissalFatigue<
  T extends Pick<
    Finding,
    "dedupeKey" | "supersedes" | "episodeFamily" | "suppressionPolicy"
  >,
>(
  findings: readonly T[],
  map: ReadonlyMap<string, SuppressionRecord>
): RankedFindings<T> {
  const keys = dismissedSignalKeys(map);
  const ranked: RankedFindings<T> = { routine: [], quiet: [], onDemand: [] };
  for (const finding of findings) {
    const prominence = findingProminence(finding, keys);
    if (prominence === "on-demand") ranked.onDemand.push(finding);
    else if (prominence === "quiet") ranked.quiet.push(finding);
    else ranked.routine.push(finding);
  }
  return ranked;
}

// The routine-surface order: everything still raised routinely, then the de-prioritised
// findings behind them. The retired ones are dropped — a caller that wants them renders
// `onDemand` in its go-looking area.
export function routineOrder<
  T extends Pick<
    Finding,
    "dedupeKey" | "supersedes" | "episodeFamily" | "suppressionPolicy"
  >,
>(findings: readonly T[], map: ReadonlyMap<string, SuppressionRecord>): T[] {
  const ranked = rankByDismissalFatigue(findings, map);
  return [...ranked.routine, ...ranked.quiet];
}
