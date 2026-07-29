// Adherence-based priority DEMOTION SUGGESTIONS (issue #1505 part 2). Pure and
// client-safe — no DB, no network. The server builder
// (buildDemotionSuggestionFindings, lib/rule-findings.ts) assembles the item-level
// adherence strips from the already profile-scoped intake reads and hands them here.
//
// The contract, and the reason this file DETECTS but never writes:
//
//   Priority is the user's static, user-owned declaration (#559). Context gates
//   dueness; it never invents priority. So a high/mandatory supplement the user has
//   plainly stopped taking does not get quietly demoted — it gets a calm, dismissible
//   SUGGESTION, and the user's one tap is the priority write. Auto-apply was
//   considered and rejected (#1505, 2026-07-29); there is no code path here or
//   downstream that mutates `priority` without a user action.
//
// Scope boundaries, each of which is a deliberate exclusion rather than an oversight:
//
//   • MEDICATIONS are exempt entirely. Poor med adherence is a missed-dose escalation
//     concern (safety tier, #449/#942), never a priority question — the same "kind
//     decides, not priority" rule the push predicate uses (isPushedIntake).
//   • A `low` item is already where the suggestion would take it, so it is never a
//     candidate (which is also what makes the accept action idempotent).
//   • PRN (as_needed) items never count: a PRN item is never scheduled-due (#798), so
//     it has no missed occurrences to measure.
//   • PAUSED items are excluded — a deliberate pause is not a lapse.
//   • An item whose schedule STARTED INSIDE the window is excluded: a fixed lookback
//     over an item added last week is mostly pre-existence days, and scoring those is
//     the cold-start mislabeling class (#430/#1442/#1433).
//   • RECOVERY CLEARS IT. The detection is a pure function of the trailing window, so
//     the moment adherence climbs back over the threshold the candidate — and its
//     finding — simply stops being emitted. A stale suggestion cannot linger.

import type { AdherenceDot } from "./supplement-adherence";
import type { SupplementKind, SupplementPriority } from "./types";

// ---- Window + thresholds --------------------------------------------------

// How many trailing days the detector reads. Thirty days is long enough that a bad
// fortnight (a holiday, a flu) can't alone recommend a demotion, and short enough
// that a genuinely abandoned supplement is caught this month rather than next
// quarter. Deliberately WIDER than the delta classifier's window
// (INTAKE_DELTA_DAYS, lib/intake-deltas.ts): a single missed run is digest news,
// a sustained pattern is a priority question — the two must not fire off the same
// evidence, and the nesting is pinned by a test.
export const DEMOTION_WINDOW_DAYS = 30;

// Minimum SCHEDULED occurrences (days the item was actually due and not deliberately
// skipped) inside the window before any claim is made. A twice-weekly supplement
// reaches ten occurrences in about five weeks; below this a handful of days is noise.
export const DEMOTION_MIN_OCCURRENCES = 10;

// The item is a candidate at or below this follow-through rate — a quarter of its
// scheduled occurrences. Not zero: "I take it now and then" is exactly the state the
// `low` tag was designed for, and demanding a perfect zero would miss it.
export const DEMOTION_MAX_TAKEN_RATE = 0.25;

// ---- Signal key (single source of truth) ----------------------------------

// The dedupeKey namespace, registered in RULE_FINDING_REGISTRY as a COACHING-tier
// prefix: the suggestion is calm and hideable, it rides the shared findings
// suppression bus, and it never becomes a notification (the #449 reach policy).
// Keyed on the ITEM id (AUTOINCREMENT, never recycles — #203), because priority is
// an item-level tag; a re-timed or re-added dose must not re-attach a stale dismissal.
export const DEMOTION_PREFIX = "demote-priority:";

// Episode-anchored (#436): the builder appends a coarse period anchor (the current
// year, YYYY), so a lapse that recurs a year after being dismissed lands in a new
// period and re-surfaces instead of being silenced forever.
export function demotionSignalKey(
  itemId: number,
  periodAnchor: string
): string {
  return `${DEMOTION_PREFIX}${itemId}:${periodAnchor}`;
}

// The pre-anchor key shape, carried as Finding.supersedes so a dismissal stored
// before the anchor existed keeps suppressing (the documented dual-read, #436).
export function demotionLegacyKey(itemId: number): string {
  return `${DEMOTION_PREFIX}${itemId}`;
}

// The item a demotion key names, or null when the string isn't one. The accept action
// derives the item id from the key rather than trusting a second, separately-posted
// id field: one token means an accept can never target an item its own suggestion
// wasn't about (the markDoseTaken "never trust the callback's item id" precedent).
export function demotionItemIdFromKey(key: string): number | null {
  if (!key.startsWith(DEMOTION_PREFIX)) return null;
  const id = Number(key.slice(DEMOTION_PREFIX.length).split(":")[0]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ---- Types ----------------------------------------------------------------

// One item's slice of the evidence: its identity and tags, plus the ITEM-LEVEL
// adherence strip (oldest-first) that `supplementAdherenceStrip` produces — the
// same per-day aggregation the Supplements page renders, so the suggestion can
// never disagree with the strip the user is looking at.
export interface DemotionInput {
  itemId: number;
  name: string;
  kind: SupplementKind;
  priority: SupplementPriority;
  // PRN: never scheduled-due, so never a candidate.
  asNeeded: boolean;
  // Paused/stopped items are excluded.
  active: boolean;
  strip: AdherenceDot[];
  // Whether the item existed, with a schedule, for the WHOLE window. False for an
  // item added mid-window — its lapse-looking days are pre-existence days.
  existedWholeWindow: boolean;
  // The coarse episode anchor (the current year, YYYY) for the dedupeKey (#436).
  periodAnchor?: string;
}

export interface DemotionCandidate {
  itemId: number;
  name: string;
  // The finding's dedupeKey (episode-anchored) and its pre-anchor twin.
  key: string;
  legacyKey: string;
  title: string;
  detail: string;
  // The evidence, kept as DATA so a surface can render its own phrasing.
  occurrences: number;
  takenDays: number;
  takenRate: number;
}

// ---- Detection ------------------------------------------------------------

// A day counts only when the item was actually DUE and the day was not a deliberate
// skip: "na" (not due) and "skipped" (a decision, #232) are transparent here exactly
// as they are to the adherence percentage — one definition of "an occurrence".
function isOccurrence(dot: AdherenceDot): boolean {
  return dot.state !== "na" && dot.state !== "skipped";
}

// Any dose taken that day counts as follow-through ("partial" included) — the same
// rule aggregateDoseDay and the pattern detectors use.
function isTaken(dot: AdherenceDot): boolean {
  return dot.state === "taken" || dot.state === "partial";
}

// The demotion candidate for one item, or null. Null is the overwhelmingly common
// answer and is also how RECOVERY clears a live suggestion — see the header.
export function detectDemotionCandidate(
  input: DemotionInput
): DemotionCandidate | null {
  // Kind decides, not priority (the Part 1 rule, restated): a medication is never
  // a demotion subject regardless of how poorly it is taken.
  if (input.kind !== "supplement") return null;
  // Only the pushed priorities have anything to lose; `low` is already the target.
  if (input.priority !== "high" && input.priority !== "mandatory") return null;
  if (input.asNeeded || !input.active) return null;
  if (!input.existedWholeWindow) return null;

  const occurrences = input.strip.filter(isOccurrence);
  if (occurrences.length < DEMOTION_MIN_OCCURRENCES) return null;

  const takenDays = occurrences.filter(isTaken).length;
  const takenRate = takenDays / occurrences.length;
  if (takenRate > DEMOTION_MAX_TAKEN_RATE) return null;

  const pct = Math.round(takenRate * 100);
  const anchor = input.periodAnchor ?? "";
  return {
    itemId: input.itemId,
    name: input.name,
    key: demotionSignalKey(input.itemId, anchor),
    legacyKey: demotionLegacyKey(input.itemId),
    title: `${input.name}: mark it low priority?`,
    detail:
      `You've taken ${input.name} on ${takenDays} of its last ` +
      `${occurrences.length} scheduled days (${pct}%) — it's still tagged ` +
      `${input.priority}. Marking it low keeps the schedule and the tracking, ` +
      `and stops it competing for your attention on Upcoming and in reminders. ` +
      `Nothing changes unless you choose it.`,
    occurrences: occurrences.length,
    takenDays,
    takenRate,
  };
}

// Every demotion candidate across a profile's items, deterministic (by name, then
// item id). The caller applies the shared findings-bus suppression filter.
export function detectDemotionCandidates(
  inputs: readonly DemotionInput[]
): DemotionCandidate[] {
  return inputs
    .map(detectDemotionCandidate)
    .filter((c): c is DemotionCandidate => c != null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.itemId - b.itemId);
}

// ---- The accept outcome ---------------------------------------------------

// What accepting a suggestion actually did. The write may legitimately refuse — the
// item was paused, deleted, or already demoted from another device — so the caller
// renders the outcome instead of confirming success unconditionally (the AGENTS.md
// inline-action rule). "demoted" is the only success.
export type DemotionOutcome =
  "demoted" | "already-low" | "inactive" | "not-found";

// One-line copy per outcome, shared by every surface that runs the accept action so
// two callers can't describe the same result differently.
export const DEMOTION_OUTCOME_TEXT: Record<DemotionOutcome, string> = {
  demoted: "Marked low priority — still tracked, no longer pushed.",
  "already-low": "Already low priority — nothing to change.",
  inactive: "That item is paused, so its priority was left alone.",
  "not-found": "That item is no longer available.",
};
