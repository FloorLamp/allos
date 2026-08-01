// Frequency-target RIGHT-SIZING suggestions (issue #1670). Pure and client-safe —
// no DB, no network. The server builder (buildTargetRightSizeFindings,
// lib/rule-findings.ts) assembles the per-target weekly history from the already
// profile-scoped `frequency_targets` reads and hands it here.
//
// This is the #1505 demotion engine's shape, generalized off intakes and onto the ONE
// substrate three commitment domains already share: wellness practices, training
// frequency goals, and food-group habits all declare their weekly floor as a
// `frequency_targets` row. So there is ONE detector with per-domain FORMATTING — not
// three engines that would drift apart on windows, thresholds, and copy.
//
// The four right-sizing-family properties (docs/internals/findings.md § the attention
// doctrine), each of which is load-bearing here:
//
//   1. REVEALED PREFERENCE. The evidence is the completion ledger — distinct logged
//      days (or servings) per week — never a self-report and never a guess.
//   2. SUGGEST, NEVER WRITE. Detection produces a candidate; the user's tap is the
//      only thing that lowers a floor or stops a target. There is no code path here
//      or downstream that edits `per_week` without a user action (#559).
//   3. RECOVERY CLEARS IT. Detection is a pure function of the trailing window, so a
//      single week back at the floor makes the candidate — and its finding — simply
//      stop being emitted. No dismissal bookkeeping keeps a stale suggestion away.
//   4. DOWNWARD ONLY. There is no "raise your floor" branch. Suggesting less
//      commitment is offering relief; suggesting more is manufacturing obligation.
//
// Deliberate exclusions, each a decision rather than an oversight:
//
//   • SUBSTANCE-USE targets are out ENTIRELY. Their `per_week` is a weekly CAP, the
//     inverse of every other scope's floor, so "chronically under it" is the SUCCESS
//     state and a right-sizing suggestion there would nudge toward more consumption.
//     The exclusion is at rightSizeDomainFor, the same boundary
//     getFrequencyTargetProgress already draws.
//   • A target CREATED INSIDE the window is excluded: most of its window is
//     pre-existence, and scoring that is the cold-start mislabeling class the
//     demotion engine excludes for the same reason.
//   • A PROTOCOL-OWNED target whose protocols have all ended never reaches this
//     module — getFrequencyTargets already drops it, which is the paused-equivalent
//     state for this substrate.
//   • ONE met week is enough to break the chronic condition. "Chronic" means every
//     completed week in the window, not most of them.

import type { FrequencyScopeKind } from "./types";

// ---- Window + thresholds --------------------------------------------------

// How many COMPLETED target weeks the detector reads. Four weeks is long enough that
// a holiday, an illness, or a busy fortnight cannot alone recommend shrinking a
// commitment, and short enough that a genuinely abandoned target is right-sized this
// month rather than next quarter. The current, in-progress week is deliberately NOT
// among them: a partial week is under its floor by construction, so counting it would
// make every target look chronic on any day but the last.
export const RIGHTSIZE_WEEKS = 4;

// The same window in days — the number the window-coherence convention is stated
// against. It must nest STRICTLY OUTSIDE the weekly pace window the nudges and the
// progress rollup read (one week), so "you're behind this week" and "you have been
// under this floor for a month" can never fire off the same evidence. Pinned by
// lib/__tests__/target-rightsize.test.ts.
export const RIGHTSIZE_WINDOW_DAYS = RIGHTSIZE_WEEKS * 7;

// The pace window every reporting surface over this same ledger uses (the weekly
// floor). Named here so the nesting assertion reads as one statement rather than a
// bare literal.
export const FREQUENCY_PACE_WINDOW_DAYS = 7;

// The candidate's BEST week must be at or below this share of the floor. Without it a
// 7-servings-a-week habit sitting at 6, 6, 5, 6 would be "chronically under floor" and
// get offered a fussy one-serving reduction, which is noise rather than relief.
//
// It is deliberately looser than the demotion engine's 0.25 follow-through rate, and
// the difference is a unit difference, not a taste difference: there, each of ~30
// scheduled days is an independent occasion, so a quarter is already a lot of them.
// Here the unit is a whole WEEK, and a single met week has already cleared the
// candidate before this line is reached — so half is where "I do this about half as
// often as I said" starts, which is the divergence the suggestion is about.
export const RIGHTSIZE_MAX_ATTAINMENT = 0.5;

// ---- Domains --------------------------------------------------------------

// The three commitment domains that declare a floor in `frequency_targets`. The
// detector is one computation; the domain decides only how the candidate is WORDED and
// which surface renders it.
export type RightSizeDomain = "practice" | "training" | "food";

// The domain a scope kind belongs to, or null when the scope carries no floor to
// right-size. `substance` is the only null today, and it is the deliberate one: a cap
// is not a floor (see the header).
export function rightSizeDomainFor(
  kind: FrequencyScopeKind
): RightSizeDomain | null {
  if (kind === "practice") return "practice";
  if (kind === "food_group") return "food";
  if (kind === "region" || kind === "group" || kind === "type")
    return "training";
  if (kind === "mobility_region") return "training";
  return null;
}

// What a weekly count COUNTS in each domain, so the evidence line names the right
// unit. Practices and training scopes count distinct days; a food habit counts
// servings, which is why "3 of 7" means something different there.
const DOMAIN_UNIT: Record<RightSizeDomain, { one: string; many: string }> = {
  practice: { one: "session", many: "sessions" },
  training: { one: "day", many: "days" },
  food: { one: "serving", many: "servings" },
};

// The label of the domain's own no-expectation state — the place accepting "stop
// tracking" lands, named in the user's words on every surface that offers it.
export const RIGHTSIZE_STOP_LABEL: Record<RightSizeDomain, string> = {
  practice: "Keep logs only",
  training: "Stop tracking",
  food: "Stop tracking",
};

// One sentence per domain saying what SURVIVES the stop, because the whole
// affordance rests on the user believing that nothing is destroyed.
const DOMAIN_STOP_TEXT: Record<RightSizeDomain, string> = {
  practice:
    "Keeping logs only drops the weekly goal and its reminders; every logged session stays in your history.",
  training:
    "Stopping tracking removes the weekly routine; every logged session stays in your history.",
  food: "Stopping tracking removes the weekly habit; your food log stays exactly as it is.",
};

// ---- Signal key (single source of truth) ----------------------------------

// The dedupeKey namespace, registered in RULE_FINDING_REGISTRY as a COACHING-tier
// prefix: the suggestion is calm and hideable, it rides the shared findings
// suppression bus, and its ONLY push presence is decorating a nag that already fires
// for its own reasons (the ride-the-nag rule). Keyed on the TARGET id
// (AUTOINCREMENT, never recycles — #203), because the floor is a property of the
// target row; re-creating a target after untracking it is a new commitment and
// deserves a fresh window, not an inherited dismissal.
export const RIGHTSIZE_PREFIX = "right-size:";

// Episode-anchored (#436): the builder appends a coarse period anchor (the current
// year, YYYY), so a drift that recurs a year after being dismissed lands in a new
// period and re-surfaces instead of being silenced forever.
export function rightSizeSignalKey(
  targetId: number,
  periodAnchor: string
): string {
  return `${RIGHTSIZE_PREFIX}${targetId}:${periodAnchor}`;
}

// The pre-anchor key shape, carried as Finding.supersedes so a dismissal stored
// before the anchor existed keeps suppressing (the documented dual-read, #436).
export function rightSizeLegacyKey(targetId: number): string {
  return `${RIGHTSIZE_PREFIX}${targetId}`;
}

// The target a right-size key names, or null when the string isn't one. Both accept
// actions derive the target id from the key rather than trusting a second,
// separately-posted id field: one token means an accept can never target a commitment
// its own suggestion wasn't about (the markDoseTaken precedent, reused by #1505).
export function rightSizeTargetIdFromKey(key: string): number | null {
  if (!key.startsWith(RIGHTSIZE_PREFIX)) return null;
  const id = Number(key.slice(RIGHTSIZE_PREFIX.length).split(":")[0]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ---- Types ----------------------------------------------------------------

// One target's slice of the evidence: its identity and declared floor, plus its
// COMPLETED weekly counts (oldest-first) from the shared frequency-target history
// gather — the same per-week aggregation the progress rollup computes for the current
// week, so a suggestion can never disagree with the card the user is looking at.
export interface RightSizeInput {
  targetId: number;
  scopeKind: FrequencyScopeKind;
  // The display label the domain's own surfaces use (frequencyScopeLabel / the
  // practice name), so the suggestion names the target the way the page does.
  label: string;
  // The declared weekly floor (`per_week`).
  floor: number;
  // Completed target weeks, oldest first. Shorter than RIGHTSIZE_WEEKS ⇒ not enough
  // elapsed weeks to claim anything.
  weeklyCounts: readonly number[];
  // Whether the target existed for the WHOLE window. False for one created
  // mid-window — its empty weeks are pre-existence weeks.
  existedWholeWindow: boolean;
  // The coarse episode anchor (the current year, YYYY) for the dedupeKey (#436).
  periodAnchor?: string;
}

export interface RightSizeCandidate {
  targetId: number;
  domain: RightSizeDomain;
  label: string;
  // The declared floor the suggestion is about.
  floor: number;
  // The floor that would make the observed window true: the BEST week in it. Null
  // when nothing at all was logged — there is no smaller positive floor to offer, so
  // only "stop tracking" is on the table.
  //
  // The best week (rather than a median or a mean) is what makes accepting SELF-
  // CLEARING: every week in the window is at or below it, so the chronic condition
  // breaks the moment it is applied. A median would leave half the window still
  // under the new floor and re-fire immediately at a lower number — a ratchet, which
  // is exactly the nag this engine exists to end.
  suggestedFloor: number | null;
  // The evidence, kept as DATA so a surface can render its own phrasing.
  weeks: number;
  best: number;
  total: number;
  // The finding's dedupeKey (episode-anchored) and its pre-anchor twin.
  key: string;
  legacyKey: string;
  title: string;
  detail: string;
  evidence: string;
}

// ---- Detection ------------------------------------------------------------

function plural(n: number, domain: RightSizeDomain): string {
  const unit = DOMAIN_UNIT[domain];
  return `${n} ${n === 1 ? unit.one : unit.many}`;
}

// The right-size candidate for one target, or null. Null is the overwhelmingly common
// answer and is also how RECOVERY clears a live suggestion — see the header.
export function detectRightSizeCandidate(
  input: RightSizeInput
): RightSizeCandidate | null {
  const domain = rightSizeDomainFor(input.scopeKind);
  if (domain == null) return null;
  if (!input.existedWholeWindow) return null;
  if (!Number.isFinite(input.floor) || input.floor < 1) return null;
  if (input.weeklyCounts.length < RIGHTSIZE_WEEKS) return null;

  const weeks = input.weeklyCounts.slice(-RIGHTSIZE_WEEKS);
  const best = Math.max(...weeks);
  // One met week is not a chronic shortfall.
  if (best >= input.floor) return null;
  // …and a near-miss is not one either.
  if (best > input.floor * RIGHTSIZE_MAX_ATTAINMENT) return null;

  const total = weeks.reduce((a, b) => a + b, 0);
  const suggestedFloor = best >= 1 ? best : null;
  const anchor = input.periodAnchor ?? "";
  const lower =
    suggestedFloor == null
      ? ""
      : `Lowering it to ${suggestedFloor}× a week makes it a goal you're already meeting. `;

  return {
    targetId: input.targetId,
    domain,
    label: input.label,
    floor: input.floor,
    suggestedFloor,
    weeks: weeks.length,
    best,
    total,
    key: rightSizeSignalKey(input.targetId, anchor),
    legacyKey: rightSizeLegacyKey(input.targetId),
    title: `${input.label}: right-size the weekly target?`,
    detail:
      `Your target is ${input.floor}× a week, and your best week in the last ` +
      `${weeks.length} was ${plural(best, domain)}. ` +
      lower +
      `${DOMAIN_STOP_TEXT[domain]} Nothing changes unless you choose it.`,
    evidence: `${plural(total, domain)} across the last ${weeks.length} weeks, against ${input.floor}× a week`,
  };
}

// Every right-size candidate across a profile's targets, deterministic (by label,
// then target id). The caller applies the shared findings-bus suppression filter.
export function detectRightSizeCandidates(
  inputs: readonly RightSizeInput[]
): RightSizeCandidate[] {
  return inputs
    .map(detectRightSizeCandidate)
    .filter((c): c is RightSizeCandidate => c != null)
    .sort((a, b) => a.label.localeCompare(b.label) || a.targetId - b.targetId);
}

// ---- The accept outcomes --------------------------------------------------

// What accepting a suggestion actually did. Either write may legitimately refuse —
// the target was untracked, re-tuned, or accepted from another device since the card
// rendered — so the caller renders the outcome instead of confirming success
// unconditionally (the AGENTS.md inline-action rule). "lowered" and "stopped" are the
// only successes.
export type RightSizeOutcome =
  | "lowered"
  | "stopped"
  | "already-lower"
  | "not-found";

// One-line copy per outcome, shared by every surface that runs an accept action so two
// callers can't describe the same result differently.
export const RIGHTSIZE_OUTCOME_TEXT: Record<RightSizeOutcome, string> = {
  lowered: "Weekly target lowered — your history is unchanged.",
  stopped: "Weekly target removed — everything you logged stays.",
  "already-lower": "That target is already at or below this — nothing to change.",
  "not-found": "That target is no longer available.",
};
