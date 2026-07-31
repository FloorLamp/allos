// Pure domain logic for WELLNESS PRACTICES (issue #1259): a `practice` frequency-target
// scope (red light, sauna, cold plunge, meditation, …) whose adherence is a min–max
// RANGE, logged one-tap into practice_logs. No DB/network — unit-tested in
// lib/__tests__/practice.test.ts. The DB seam (the write core + week counting) lives in
// lib/practice-log.ts; the range/pace/nudge DECISIONS live here so every surface (the
// protocol adherence card, the Active-protocols widget, Upcoming, the Telegram nudge)
// keys on the SAME computation (the "one question, one computation" rule, #221).

import { frequencyPace, type FrequencyPace } from "./goals";
import type { PracticeLogOutcome } from "./types";

// The stable suppression/identity key namespace for a wellness-practice weekly target:
// `practice:<targetId>`. The SINGLE source of truth for the key — the Upcoming practice
// item (lib/queries/upcoming) AND the Telegram nudge derive from it, so a page dismissal
// and its push cousin line up on the same string (the #227 workout-nudge pattern). This
// is a signal key over the frequency_target ID; it is a DIFFERENT namespace from the
// protocol-form select value (also `practice:`, but a practice NAME) — the two never
// meet in the same code path.
export const PRACTICE_SIGNAL_PREFIX = "practice:";

export function practiceSignalKey(targetId: number): string {
  return `${PRACTICE_SIGNAL_PREFIX}${targetId}`;
}

// The curated starter list of wellness practices offered in the protocol picker (plus
// free text). Deliberately steers AWAY from PT / region-targeted work (#1259 boundary:
// the mobility_region scope + recovery activities model that better). Circadian and
// dose-limited modalities are the sweet spot (the floor+ceiling range + optional
// duration earn their keep there).
export const PRACTICE_STARTER_LIST: readonly string[] = [
  "Red light therapy",
  "Sauna",
  "Cold plunge",
  "Meditation",
  "Breathwork",
  "Journaling",
  "Morning light exposure",
  "Wind-down routine",
];

// Normalize a user-entered practice name: collapse whitespace while preserving the
// user's display casing. A blank name is not a practice.
export function normalizePracticeName(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

// The ONE identity for a wellness practice (#1591). Practice names are user-owned,
// open vocabulary, so the safe equivalence set is deliberately narrow: case and
// whitespace variants only. We do NOT fold synonyms ("breath work" ≠ "breathwork"),
// modalities ("infrared sauna" ≠ "sauna"), or starter-list neighbors — doing so could
// silently merge two practices with different targets and histories. DB readers gather
// the finite set of stored spellings matching this key and bind those spellings into
// their SQL IN-list (SQL cannot call this JS normalizer).
export function practiceIdentity(raw: string | null | undefined): string {
  return normalizePracticeName(raw).toLocaleLowerCase("en-US");
}

export function samePractice(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const left = practiceIdentity(a);
  return left !== "" && left === practiceIdentity(b);
}

export const MAX_PRACTICE_SPELLINGS_PER_IDENTITY = 200;

// Group the finite set of stored spellings by the same identity used everywhere
// else. Exact spellings are preserved because SQL must bind the stored values.
export function groupPracticeSpellings(
  values: readonly string[],
  maxPerIdentity = MAX_PRACTICE_SPELLINGS_PER_IDENTITY
): Map<string, string[]> {
  const cap = Math.max(1, Math.min(Math.floor(maxPerIdentity), 500));
  const grouped = new Map<string, string[]>();
  const seen = new Map<string, Set<string>>();
  for (const value of values) {
    const identity = practiceIdentity(value);
    if (!identity) continue;
    let spellings = grouped.get(identity);
    if (!spellings) {
      spellings = [];
      grouped.set(identity, spellings);
      seen.set(identity, new Set());
    }
    const identitySeen = seen.get(identity)!;
    if (identitySeen.has(value) || spellings.length >= cap) continue;
    identitySeen.add(value);
    spellings.push(value);
  }
  return grouped;
}

export function practiceSpellingsFor(
  spellingsByIdentity: ReadonlyMap<string, readonly string[]>,
  practice: string
): string[] {
  const identity = practiceIdentity(practice);
  if (!identity) return [];
  const normalized = normalizePracticeName(practice);
  const resolved = spellingsByIdentity.get(identity) ?? [];
  return [...new Set([normalized, ...resolved])]
    .filter(Boolean)
    .slice(0, MAX_PRACTICE_SPELLINGS_PER_IDENTITY);
}

// The ONE display name for a practice identity. Practice names are user-owned open
// vocabulary and the same identity can hold several stored spellings, so which one a
// surface shows is a decision, not a lookup: the TARGET's spelling wins (the user
// typed it when they set the cadence), else the most recent session's spelling, else
// the folded identity itself as a last resort. Shared by the Wellness page aggregate
// and the search fan-out (#1595) so a practice can never be named one thing on its
// card and another in the palette.
export function practiceDisplayName(input: {
  targetSpelling?: string | null;
  latestSpelling?: string | null;
  identity: string;
}): string {
  return (
    normalizePracticeName(input.targetSpelling) ||
    normalizePracticeName(input.latestSpelling) ||
    input.identity
  );
}

// The expanded log form defaults duration from the immediately previous session.
// A prior row with no recorded duration intentionally yields no default — old null
// rows are never treated as if a duration had been captured.
export function previousPracticeDuration(
  sessions: readonly { duration_min: number | null }[]
): number | null {
  return sessions[0]?.duration_min ?? null;
}

export type PracticeCadenceError =
  "minimum-range" | "maximum-range" | "maximum-order";

export type PracticeCadenceValidation =
  | { ok: true; floor: number; ceiling: number | null }
  | { ok: false; reason: PracticeCadenceError };

// Weekly cadence is user intent, not a hint to normalize. Reject invalid bounds
// rather than silently flooring, clamping, or discarding them.
export function validatePracticeCadence(
  floor: number,
  ceiling: number | null
): PracticeCadenceValidation {
  if (!Number.isInteger(floor) || floor < 1 || floor > 14) {
    return { ok: false, reason: "minimum-range" };
  }
  if (ceiling == null) return { ok: true, floor, ceiling: null };
  if (!Number.isInteger(ceiling) || ceiling < 1 || ceiling > 14) {
    return { ok: false, reason: "maximum-range" };
  }
  if (ceiling <= floor) {
    return { ok: false, reason: "maximum-order" };
  }
  return { ok: true, floor, ceiling };
}

// The range state of a practice (or any) frequency target this week — ONE computation
// the adherence card, the widget, Upcoming, and the nudge all format over. `floor`
// drives adherence + pacing (frequencyPace, the same 3-state pace every target uses);
// `ceiling` (nullable) is the "don't overdo it" cap: once count reaches it the target is
// calmly DONE for the week ("that's plenty"), never a red state.
export interface FrequencyRangeState {
  met: boolean; // count >= floor
  atCeiling: boolean; // ceiling != null && count >= ceiling
  pace: FrequencyPace; // floor-based pacing (met / on-pace / behind)
}

export function frequencyRangeState(
  count: number,
  floor: number,
  ceiling: number | null,
  elapsedDays: number
): FrequencyRangeState {
  return {
    met: count >= floor,
    atCeiling: ceiling != null && count >= ceiling,
    pace: frequencyPace(count, floor, elapsedDays),
  };
}

// Whether the pace-aware practice nudge should fire (the workout-nudge pattern, #221):
// nag ONLY when the floor isn't met AND the week's pace has fallen behind — quiet when
// on track, SILENT at/above the ceiling (a dose-limited practice must never be pushed
// toward MORE). Pure; the tick gathers count/elapsedDays and the bus-gating is decided
// separately (a dismissed Upcoming twin holds it). Returns false the moment the ceiling
// is reached even if elapsed pace math would otherwise flag it.
export function shouldNudgePractice(
  count: number,
  floor: number,
  ceiling: number | null,
  elapsedDays: number
): boolean {
  const state = frequencyRangeState(count, floor, ceiling, elapsedDays);
  if (state.met || state.atCeiling) return false;
  return state.pace === "behind";
}

// Display: the weekly cadence text for a practice target. "3×/week" for a bare floor,
// "3–5×/week" for a range. Shared by every surface so the phrasing never drifts.
export function practiceCadenceText(
  floor: number,
  ceiling: number | null
): string {
  return ceiling != null && ceiling > floor
    ? `${floor}–${ceiling}×/week`
    : `${floor}×/week`;
}

// Display: the calm at-ceiling reassurance, shared by the surfaces (#1259: never a red
// state above the ceiling).
export const PRACTICE_PLENTY_TEXT = "Weekly maximum reached";

// The ONE sentence a surface says after a one-tap practice log, derived from the typed
// write outcome. A session log is NOT idempotent, so this is never an unconditional
// confirm (the markDoseTaken contract): a fresh row reports the day's running count, and
// anything else says plainly that nothing was written. Shared by every tap surface —
// the Wellness card's button, the quick-entry overlay's practice row, the command
// palette's inline quick log, and the Telegram "Done ✓" answer — so four surfaces over
// one write core cannot drift into four wordings (#1633).
export function practiceLogOutcomeText(outcome: PracticeLogOutcome): string {
  if (outcome.kind === "logged") {
    return outcome.count === 1
      ? "Logged today's session"
      : `Logged — ${outcome.count} sessions today`;
  }
  return "Couldn't log that session.";
}
