// Pure domain logic for WELLNESS PRACTICES (issue #1259): a `practice` frequency-target
// scope (red light, sauna, cold plunge, meditation, …) whose adherence is a min–max
// RANGE, logged one-tap into practice_logs. No DB/network — unit-tested in
// lib/__tests__/practice.test.ts. The DB seam (the write core + week counting) lives in
// lib/practice-log.ts; the range/pace/nudge DECISIONS live here so every surface (the
// protocol adherence card, the Active-protocols widget, Upcoming, the Telegram nudge)
// keys on the SAME computation (the "one question, one computation" rule, #221).

import { frequencyPace, type FrequencyPace } from "./goals";

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

// Normalize a user-entered practice name: collapse surrounding whitespace. Names are
// stored verbatim (case preserved) but a blank name is not a practice.
export function normalizePracticeName(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
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
export const PRACTICE_PLENTY_TEXT = "That's plenty this week";
