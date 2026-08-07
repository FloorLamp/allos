// Pure domain logic for WELLNESS PRACTICES (issue #1259): a `practice` frequency-target
// scope (red light, sauna, cold plunge, meditation, …) whose adherence is a min–max
// RANGE, logged one-tap into practice_logs. No DB/network — unit-tested in
// lib/__tests__/practice.test.ts. The DB seam (the write core + week counting) lives in
// lib/practice-log.ts; the range/pace/nudge DECISIONS live here so every surface (the
// protocol adherence card, the Active-protocols widget, Upcoming, the Telegram nudge)
// keys on the SAME computation (the "one question, one computation" rule, #221).

import { WEEKDAYS_SHORT } from "./date";
import { frequencyPace, type FrequencyPace } from "./goals";
import { inWakingWindow } from "./notifications/schedule";
import type { PracticeLogOutcome } from "./types";
import type { WeeklyRhythm } from "./weekly-rhythm";

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

// ---- Duration prefill (#2204) ---------------------------------------------
//
// THE ONE answer to "what does this practice's duration control start at?", shared by
// the quick sheet's inline stepper and the Wellness card's expanded form. Two surfaces
// showing the same default is exactly the "one question, one computation" case, and
// they had already begun to diverge: the quick path showed nothing and wrote null.
//
// The order is stated in full, including the leg nothing supplies yet:
//
//   1. the practice's own LAST LOGGED session — its `duration_min`, whatever it is.
//      Note "whatever it is": a last session that carried NO duration prefills BLANK.
//      That is deliberate and it is what makes constraint 4 of #2204 hold — the
//      prefill teaches from what was WRITTEN, never from what was merely shown, so
//      clearing the stepper once sticks instead of being re-suggested forever.
//   2. a DECLARED default for the practice — a protocol/target-level "a sauna session
//      is 20 minutes". No store declares one today; the parameter exists so the order
//      is written down rather than guessed at by the first caller that needs it (the
//      METRIC_KNOWLEDGE posture: an explicit absence, named).
//   3. blank. The app does not invent a duration for a practice with no history and
//      no declared default (#2204 constraint 2).
//
// `sessions` is newest-first, the order every practice reader already gathers in.
export function practiceDurationPrefill(
  sessions: readonly { duration_min: number | null }[],
  declaredDefaultMin: number | null = null
): number | null {
  // Leg 1 — a session exists, so ITS duration is the answer even when that is null.
  if (sessions.length > 0) return sessions[0].duration_min ?? null;
  // Leg 2 — no history at all; a declared default may speak. Guarded so a zero or a
  // negative declaration degrades to blank rather than seeding an impossible session.
  if (declaredDefaultMin != null && declaredDefaultMin > 0)
    return Math.round(declaredDefaultMin);
  // Leg 3.
  return null;
}

// One tap of the inline stepper's − / +. Pure so the sheet, and anything that later
// mounts the same control, step identically.
//
// Two edges worth stating: stepping UP from blank starts at one step (the control is
// how you say "about 20 minutes", so it must be reachable without typing), and
// stepping DOWN past the first step CLEARS rather than clamping at 1 — "no duration"
// is a legitimate destination and a stepper that can only be escaped by selecting the
// text and deleting it is not a one-tap surface.
export const PRACTICE_DURATION_STEP_MIN = 5;

export function stepPracticeDuration(
  current: number | null,
  delta: number
): number | null {
  const next = (current ?? 0) + delta;
  return next >= 1 ? next : null;
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

// ---- The rhythm-retimed nudge moment (#2188) --------------------------------
//
// When a behind practice HAS an inferred weekly rhythm (lib/weekly-rhythm.ts),
// the pace nudge WAITS for the practice's next predicted day and fires at its
// typical hour instead of the first waking tick of the flip day — the message
// lands when the user can actually act on it. The decision is pure and lives
// here with the other nudge decisions; the tick supplies the moment.
//
// The contact-consent constraints (#2188 item 3) are structural in this function:
//
//   • NO PATTERN → released unconditionally, so the caller's existing gates
//     (behind + waking + per-day marker + bus) produce today's behavior
//     byte-for-byte.
//   • Within a week the retimed send is only ever LATER than the flip-day rule:
//     a hold day is strictly later, and on a predicted day the release minute is
//     clamped INTO the waking window, so it is never before the first waking tick.
//   • Never more often: every released day is a day today's daily-while-behind
//     rule would also have fired on.
//   • If the week's LAST predicted day passes while still behind, release —
//     falling back to the flip-day rule so the week's nudge is never silently
//     lost. Rolling week mode has `daysLeftInWindow` 0 (every day is the last
//     day), so it can defer within a day but never across days.
//
// Predicted ≠ due (#1505): this only DELAYS a send the pace ledger already
// justified; frequencyPace remains the one dueness authority.
export interface PracticeNudgeMoment {
  weekday: number; // profile-local today, 0=Sun … 6=Sat
  minuteOfDay: number; // profile-local minute of day (0–1439)
  wakingStartHour: number; // the profile's waking window (#450), hour-typed
  wakingEndHour: number;
  // On-days remaining AFTER today in the target's week window, from
  // FrequencyTargetProgress.daysLeftInWindow (0 in rolling mode).
  daysLeftInWindow: number;
}

export function practiceNudgeReleased(
  rhythm: WeeklyRhythm,
  moment: PracticeNudgeMoment
): boolean {
  if (!rhythm.hasPattern) return true;

  if (rhythm.weekdays.includes(moment.weekday)) {
    // Today is a predicted day: release at the typical hour, clamped into the
    // waking window. A wrapped (night-shift) window has no meaningful nearest
    // bound for an out-of-window hour, so it clamps to the window start.
    let releaseHour = rhythm.hour;
    if (
      !inWakingWindow(
        releaseHour * 60,
        moment.wakingStartHour,
        moment.wakingEndHour
      )
    ) {
      releaseHour =
        moment.wakingStartHour <= moment.wakingEndHour
          ? Math.min(
              Math.max(releaseHour, moment.wakingStartHour),
              moment.wakingEndHour
            )
          : moment.wakingStartHour;
    }
    // "At or after the release minute", ordered from the waking-window start so a
    // wrapped window's post-midnight tail still counts as after its evening head.
    const start = moment.wakingStartHour * 60;
    const offset = (m: number) => (m - start + 1440) % 1440;
    return offset(moment.minuteOfDay) >= offset(releaseHour * 60);
  }

  // Not a predicted day: hold while a predicted day is still ahead in THIS week;
  // once the last one has passed, fall back to the flip-day rule.
  for (let i = 1; i <= Math.min(6, moment.daysLeftInWindow); i++) {
    if (rhythm.weekdays.includes((moment.weekday + i) % 7)) return false;
  }
  return true;
}

// Display: the inferred rhythm named as DATA, not advice (#2188 item 3 of the
// surfaces list) — "usually Mon/Wed/Fri". Callers only render it for a real
// pattern; there is deliberately no phrasing for the no-pattern fallback (#558:
// no pattern renders nothing).
export function practiceRhythmDaysText(weekdays: readonly number[]): string {
  return `usually ${weekdays.map((wd) => WEEKDAYS_SHORT[wd]).join("/")}`;
}

// Display: the calm rhythm note the practice cards show on a predicted day with
// no session logged yet (#2188). One string, shared by the wellness card and the
// protocol surfaces, so the copy cannot drift.
export const PRACTICE_USUAL_DAY_TEXT = "usually a session day";

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
