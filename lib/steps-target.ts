// The daily step target and its calm presence (#1723 part 2) — PURE. No DB, no clock.
//
// WHY THIS IS NEW MACHINERY. Steps sync and chart (`metric_samples.steps`, the Body
// tab card, the #1221 dashboard widget) but nothing has ever counted a day's step SUM
// against an expectation: `frequency_targets` are weekly-SESSION shaped (count of days
// a thing happened), which cannot express "8,000 a day". So the target is a declared
// per-profile VALUE, stored beside the other profile health facts.
//
// NO SCHEMA WAS ADDED. The target is a single scalar the user declares about
// themselves — exactly what `profile_settings` is for — so it lands there rather than
// in a new table or a new `frequency_targets` scope kind (which would have needed a
// CHECK-enum rebuild to express a shape that table's weekly-session semantics cannot
// carry anyway). Least machinery wins.
//
// DOCTRINE. `should`-tier semantics: counted, never escalated. No streaks, no
// gamification — the #716/#992 sensitivity line applies to movement as it does to
// mood. The afternoon presence rides surfaces that already exist; it creates no send.

export type StepsVerdict = "met" | "under";

// "Notably behind" — the fraction of the target that must NOT have been reached by
// the evaluation hour for the afternoon presence to appear. Half a day's target with
// the afternoon gone is a real gap; anything tighter would fire on ordinary days.
export const STEPS_BEHIND_FRACTION = 0.5;

// The local hour the day is evaluated at (16 = 4pm). Late enough that a normal day
// has accumulated most of its steps, early enough that the observation is still about
// today rather than a post-mortem.
export const STEPS_AFTERNOON_HOUR = 16;

// How stale the step data may be before the evaluation goes SILENT. A Health Connect
// batch arriving late must never fire a false "behind": if the newest sample predates
// this cutoff, we do not know today's real count, and #1685's staleness signal — not a
// guessed verdict — is what owns that case.
export const STEPS_STALE_AFTER_MIN = 180;

// Thousands separators, matching how the Body card renders a step count.
export function fmtSteps(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

// The digest's Yesterday line (#1712's verdict pattern: state the comparison, don't
// leave the reader to do it). Null when there is no target or no reading — the digest
// never manufactures a line, and a bare step count with nothing to compare it against
// is already the dashboard card's job.
export function stepsVerdictLine(
  steps: number | null,
  target: number | null
): string | null {
  if (steps == null || target == null || target <= 0) return null;
  const met = steps >= target;
  return met
    ? `${fmtSteps(steps)} steps ▲ target met`
    : `${fmtSteps(steps)} of ${fmtSteps(target)} steps`;
}

export function stepsVerdict(steps: number, target: number): StepsVerdict {
  return steps >= target ? "met" : "under";
}

export interface StepsBehindInput {
  // The profile-local hour right now (0..23).
  hourLocal: number;
  // Today's steps so far, or null when nothing has arrived yet.
  stepsSoFar: number | null;
  // The declared daily target, or null when the profile hasn't set one.
  target: number | null;
  // Minutes since the newest step sample landed, or null when nothing is known.
  dataAgeMin: number | null;
}

// The afternoon presence gate. Every clause is a veto, and the stale-data clause is
// the load-bearing one: no target, too early, unknown or stale data ⇒ silence.
export function stepsBehindByAfternoon(input: StepsBehindInput): boolean {
  const { target, hourLocal, stepsSoFar, dataAgeMin } = input;
  if (target == null || target <= 0) return false;
  if (hourLocal < STEPS_AFTERNOON_HOUR) return false;
  // Sync lag tolerated: unknown or stale coverage means we cannot honestly say the
  // day is behind, so we say nothing at all.
  if (dataAgeMin == null || dataAgeMin > STEPS_STALE_AFTER_MIN) return false;
  if (stepsSoFar == null) return false;
  return stepsSoFar < target * STEPS_BEHIND_FRACTION;
}

// The afternoon item's copy. States the two numbers and nothing else: no verb, no
// deadline, no encouragement — the reader decides what, if anything, to do.
export function stepsBehindDetail(stepsSoFar: number, target: number): string {
  return `${fmtSteps(stepsSoFar)} of ${fmtSteps(target)} today`;
}

// The per-day dedupe key for the afternoon item. Dated, so a dismissal silences
// TODAY's observation and tomorrow starts clean — the same shape the UV-overexposure
// finding uses.
export const STEPS_PACE_PREFIX = "steps-pace:";
export function stepsPaceKey(date: string): string {
  return `${STEPS_PACE_PREFIX}${date}`;
}

export interface StepsTodayLineInput {
  target: number | null;
  // The trailing average the #1221 summary already computes — reused, never
  // re-derived (#221).
  average7: number | null;
}

// The digest's TODAY line, and the reason it usually isn't there. A target the reader
// already meets on an average day is not news at 7am, so the line appears only when
// the trailing average sits below the target — the one case where restating the
// target is genuinely informative. Null otherwise.
export function stepsTodayTargetLine(
  input: StepsTodayLineInput
): string | null {
  const { target, average7 } = input;
  if (target == null || target <= 0) return null;
  if (average7 == null || average7 >= target) return null;
  return `Step target ${fmtSteps(target)} — you've averaged ${fmtSteps(average7)} a day this past week.`;
}
