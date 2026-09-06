// Pure domain logic for WELLNESS PRACTICES (issue #1259): a `practice` frequency-target
// scope (red light, sauna, cold plunge, meditation, …) whose adherence is a min–max
// RANGE, logged one-tap into practice_logs. No DB/network — unit-tested in
// lib/__tests__/practice.test.ts. The DB seam (the write core + week counting) lives in
// lib/practice-log.ts; the range/pace/nudge DECISIONS live here so every surface (the
// protocol adherence card, the goal/habit atoms, Upcoming, and the Telegram nudge)
// keys on the SAME computation (the "one question, one computation" rule, #221).

import { WEEKDAYS_SHORT, zonedDateParts } from "./date";
import { frequencyPace, type FrequencyPace } from "./frequency-targets";
import { inWakingWindow } from "./notifications/schedule";
import type { PracticeLiveEndOutcome, PracticeLogOutcome } from "./types";
import { rhythmMomentOpen } from "./weekly-rhythm";
import { usual, USUAL_KINDS } from "./usual";
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
//   1. the practice's USUAL recorded duration — the most common positive duration,
//      with a tie resolved by the newest session. Duration-less rows do not vote.
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
  // ALL THREE LEGS ARE `usual`'s NOW (#5143) — this header stated the order every
  // other derivation should have followed, and it is the shared function's contract.
  // The mode and the newest-wins tie-break are `USUAL_KINDS.practiceDuration`'s, and
  // the declared leg's positive-only guard moved with it: a zero or negative
  // declaration degrades to blank rather than seeding an impossible session.
  const answer = usual(
    sessions.flatMap((session) => {
      const value = session.duration_min;
      return value != null && Number.isFinite(value) && value > 0
        ? [Math.round(value)]
        : [];
    }),
    declaredDefaultMin,
    USUAL_KINDS.practiceDuration
  );
  return answer == null ? null : Math.round(answer);
}

// ── HOW LONG A LIVE SESSION ALREADY KNOWS IT IS (#5091) ──────────────────────
//
// A Start now stamps the practice's usual duration on the row with `derived_window = 1`
// (#4897), and until now nothing read it as an END: the only automatic close was the
// six-hour abandonment sweep, which gives up without an end. So a 15-minute red-light
// session started at 06:28 was still "running" at 10:52 and drew four hours wide,
// growing on every page load.
//
// A row that knows its own length does not need a second tap. This is the ONE reading
// of that length, and both halves take it: the sweep completes the row at start plus
// this, and the day chart's running branch refuses to draw past it — because the sweep
// runs on page loads, and a chart rendered before one would otherwise keep growing a
// block past an end the row already knew.
//
// Null for a row with no usual duration, which stays live until End or the six-hour
// bound exactly as before: a practice with no history has no length to complete at, and
// inventing one is what the derived window exists to avoid.
export function derivedSessionMinutes(session: {
  durationMin: number | null;
  derivedWindow: boolean;
}): number | null {
  if (!session.derivedWindow) return null;
  const minutes = session.durationMin;
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.max(1, Math.round(minutes));
}

// The INSTANT a live row completes itself, and the profile-local clock it lands on
// (#5091). One derivation, taken by every reader that hands a live session to a client:
// the quick sheet's row times a re-read to `at`, and prints `hhmm`. Null when the row
// stamped no usual duration — those stay live until End or the abandonment bound.
export function liveSessionExpectedEnd(
  startedAt: number | null,
  session: { durationMin: number | null; derivedWindow: boolean },
  tz: string
): { at: string; hhmm: string } | null {
  const derived = derivedSessionMinutes(session);
  if (derived == null || startedAt == null) return null;
  const at = new Date(startedAt + derived * 60_000);
  return { at: at.toISOString(), hhmm: zonedDateParts(tz, at).hhmm };
}

// ── WHICH PRACTICE A WINDOW ON THE DAY CHART LOOKS LIKE (#4950 item 4) ───────
//
// HABIT MATCHING, NEVER PHYSIOLOGY. Heart rate cannot tell a run from a sauna, and this
// function never sees any: it reads the same weekly rhythm the Wellness card's "usually
// a session day" note reads, asked of the window's own weekday and minute. The person
// pointed at the trace; the app only offers the practice they usually do then.
//
// IT IS A PREFILL A TAP CONFIRMS, and nothing is stored, sent or worded as what
// happened. Returning the wrong practice costs one tap on a picker that is open anyway;
// returning null costs nothing, which is why every uncertainty resolves to null.
//
// THE HONESTY GATE IS `rhythmMomentOpen`'s FIRST LINE. A practice with no pattern
// (`hasPattern` false, the every-day fallback) is UNKNOWN, not "every day" — so it can
// never fit, and a profile whose practices have no rhythm gets the picker it has today.
export interface PracticeWindowCandidate {
  /** The name the door's picker holds, so what comes back is always one of its options. */
  name: string;
  rhythm: WeeklyRhythm;
  /** `practiceDurationPrefill`'s answer for this practice, or null with no history. */
  usualDurationMin: number | null;
}

export function practiceFittingWindow(
  candidates: readonly PracticeWindowCandidate[],
  date: string,
  window: { from: number; to: number | null }
): string | null {
  const fitting = candidates.filter((candidate) =>
    rhythmMomentOpen(candidate.rhythm, date, window.from)
  );
  if (fitting.length === 0) return null;
  // A start alone says nothing about length, so there is nothing to break a tie WITH;
  // the profile's own order decides, which is the order the picker already lists.
  if (window.to === null) return fitting[0].name;
  const length = window.to - window.from;
  // Nearest usual duration. A practice with no usual duration says nothing about
  // length either, so one that DOES speak is preferred over one that cannot — and when
  // none of them can, the first fitting practice stands.
  const distance = (candidate: PracticeWindowCandidate): number =>
    candidate.usualDurationMin === null
      ? Number.POSITIVE_INFINITY
      : Math.abs(candidate.usualDurationMin - length);
  let best = fitting[0];
  for (const candidate of fitting.slice(1)) {
    if (distance(candidate) < distance(best)) best = candidate;
  }
  return best.name;
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
// drives adherence + pacing (frequencyPace, the same pace every target uses);
// `ceiling` (nullable) is the "don't overdo it" cap: once count reaches it the target is
// calmly DONE for the week ("that's plenty"), never a red state.
export interface FrequencyRangeState {
  met: boolean; // count >= floor
  atCeiling: boolean; // ceiling != null && count >= ceiling
  pace: FrequencyPace; // floor-based pacing (frequencyPace)
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
  return `${practiceTargetRangeText(floor, ceiling)}×/week`;
}

// Display: the bare weekly target — "3–5" for a range, "3" for a floor. The half of
// the cadence text that reads as a QUANTITY rather than a rate, which is what the row
// grammar's facts column says ("1 of 3–5 this week"). One spelling of the range, so
// the two phrasings cannot drift apart.
export function practiceTargetRangeText(
  floor: number,
  ceiling: number | null
): string {
  return ceiling != null && ceiling > floor
    ? `${floor}–${ceiling}`
    : `${floor}`;
}

// ── THE PRACTICE ROW'S FACTS COLUMN (#5431) ─────────────────────────────
//
// The middle of `label · facts · trailing slot`, in the two states that state a
// STANDING rather than a session: idle and finished-today. TODAY'S COUNT IS A FACT ONLY
// WHEN IT IS NOT ZERO — "No sessions yet" was the sheet printing the absence of one,
// beside a control that already says what a tap would do.
//
// NO VERDICT HERE, EVER. The badge this replaced printed a pace over an empty week
// (#5395); the row states the quantity and lets the person read it.
export function practiceRowFacts(standing: {
  todayCount: number;
  countThisWeek: number;
  perWeek: number;
  perWeekMax: number | null;
  atCeiling: boolean;
}): string {
  const week = `${standing.countThisWeek} of ${practiceTargetRangeText(
    standing.perWeek,
    standing.perWeekMax
  )} this week`;
  return [
    standing.todayCount > 0 ? `${standing.todayCount} today` : null,
    week,
    // The ceiling is the one week fact the count alone cannot carry, and the line
    // above this row used to state it. It comes across as prose, not as a badge.
    standing.atCeiling ? PRACTICE_PLENTY_TEXT : null,
  ]
    .filter((part) => part != null)
    .join(" · ");
}

// The RUNNING state's facts, from the server's own row: the start it stamped, and the
// end it already knows (#5091) when it stamped one. A row with no usual duration has no
// end to name, and inventing one is exactly what the derived window exists to avoid.
export function practiceRunningFacts(
  startTime: string,
  expectedEndHhmm: string | null
): string {
  const since = `Running since ${startTime}`;
  return expectedEndHhmm ? `${since} · ends ~${expectedEndHhmm}` : since;
}

// Display: the calm at-ceiling reassurance, shared by the surfaces (#1259: never a red
// state above the ceiling).
export const PRACTICE_PLENTY_TEXT = "Weekly maximum reached";

// The ONE sentence a surface says after a one-tap practice log, derived from the typed
// write outcome. A session log is NOT idempotent, so this is never an unconditional
// confirm (the markDoseTaken contract): a fresh row reports the day's running count, and
// anything else says plainly that nothing was written. Shared by every tap surface —
// the Wellness card's button, the quick-entry overlay's practice row, the command
// palette's inline quick log, and the Telegram "Done ✅" answer — so four surfaces over
// one write core cannot drift into four wordings (#1633).
export function practiceLogOutcomeText(
  outcome: PracticeLogOutcome,
  profileToday: string
): string {
  if (outcome.kind === "logged") {
    if (outcome.date !== profileToday) return "Logged past session";
    return outcome.count === 1
      ? "Logged today's session"
      : `Logged — ${outcome.count} sessions today`;
  }
  return "Couldn't log that session.";
}

// The same discipline for ENDING a live session (#5142 AC 3). The Wellness card's End
// button said "Session finished" in a component and the Telegram "Still going?" nudge
// was about to need the same sentence; one write core with one typed outcome gets one
// wording. Never an unconditional confirm: a row the sweep already closed says so.
export function practiceLiveEndText(outcome: PracticeLiveEndOutcome): string {
  return outcome.kind === "ended"
    ? "Session finished"
    : "That session is no longer running.";
}
