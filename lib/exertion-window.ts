// THE EXERTION WINDOW (issue #5113) — what the heart rate says a session was.
//
// A live workout ends only by hand today. The app notices a forgotten one by CLOCK and
// late (`lib/workout-presence.ts`'s 45-minute stale suggest), and its Finish stamps the
// end at the TAP — so a session that ended at 11:35 is offered a finish at 12:30 with
// 12:30 as its end, and the recovery, the zone split and the recap it feeds are all
// measured over an hour of sitting down.
//
// The store already holds the answer. This is the reading of it, pure: the stretches a
// trace spends above the profile's own resting ceiling, bounded on both sides by the
// time that person usually takes to get back inside it.
//
// ── EVERYTHING IS COMPARED TO THE PERSON ─────────────────────────────────────
// The ceiling is `restingCeilingBpm` — that profile's baseline plus its own spread —
// and the bound is `usualRecoveryMin` over their own recent sessions. There is no
// published band for "how hard a workout should be", and inventing one would be the
// clinical-cutoff language #4775 and AGENTS.md both refuse.
//
// So the constants below are DEFAULTS, not minimums, and the `??` that reads them is
// the whole of that claim. `lib/usual.ts` hands back null for exactly one person —
// the one with no recorded usual and nothing declared, whose habit the app refuses to
// invent — and that null is what these stand in for. A number that is NOT null is
// that profile's own measured usual, and it wins even when it is SMALLER than the
// default: clamping it upward would be the invented band, applied to precisely the
// people this module exists to answer for. Someone who comes back down in six minutes
// gets six.
//
// ── COVERAGE IS NOT RECOVERY ─────────────────────────────────────────────────
// A wrist that comes off mid-session reads as ABSENCE. The honest answer to "did they
// come back down" over minutes nobody measured is "unknown", never "yes" — so a gap
// inside a candidate span, or inside the quiet stretch that would close it, yields no
// window at all. Same discipline as `lib/event-physiology.ts`'s `covered` gate, which
// stays false until the stream's frontier passes the window end.
//
// ── BOTH EDGES, INCLUDING THE FIRST ──────────────────────────────────────────
// A span still elevated at the frontier is not a finished session, which is the rule
// the issue states. A span elevated at the trace's FIRST minute is the same thing
// backwards: nothing says the effort began there rather than before the trace did. So
// a window needs quiet on both sides — and because quiet must be MEASURED, neither
// edge of the trace can supply it. The two rules are one rule.

/** One measured minute. `at` is a UTC instant in ms; the surfaces own the clock. */
export interface ExertionSample {
  at: number;
  bpm: number;
}

/** A stretch of elevated minutes. Half-open: `from` is measured, `to` is not. */
export interface ExertionSpan {
  from: number;
  to: number;
}

const MINUTE_MS = 60_000;

/**
 * The quiet stretch that closes a span, for a profile with no measured recovery of
 * their own. Ten minutes is the issue's own figure and it is a DEFAULT, not a rule: a
 * profile with priors uses `usualRecoveryMin` whether that is longer or shorter, which
 * is the whole point.
 */
export const EXERTION_RECOVERY_DEFAULT_MIN = 10;

/**
 * The shortest stretch that counts as a session, for a profile with nothing logged to
 * compare against. "A brisk walk to the car is under it for anyone who has logged a
 * session" — and for anyone who has not, ten minutes is the honest guess and it is
 * stated as one. Anyone who HAS logged sessions is measured against those instead,
 * including the person whose own shortest sessions run seven minutes.
 */
export const EXERTION_MIN_WINDOW_DEFAULT_MIN = 10;

/**
 * The longest run of unmeasured minutes a span may contain and still be read.
 *
 * Five minutes is a wrist off, a watch charging, or a pipeline that dropped a batch —
 * none of which is evidence about a heart rate. It is deliberately SHORT: the failure
 * this prevents is a confident window over minutes nobody recorded, which looks
 * exactly like a real one.
 */
export const EXERTION_MAX_GAP_MIN = 5;

function sorted(samples: readonly ExertionSample[]): ExertionSample[] {
  return [...samples].sort((a, b) => a.at - b.at);
}

/** True when `[from, to)` holds no unmeasured run longer than the gap bound. */
function covered(
  samples: readonly ExertionSample[],
  from: number,
  to: number
): boolean {
  if (to <= from) return true;
  const bound = EXERTION_MAX_GAP_MIN * MINUTE_MS;
  let previous = from - MINUTE_MS;
  for (const sample of samples) {
    if (sample.at < from) continue;
    if (sample.at >= to) break;
    if (sample.at - previous > bound) return false;
    previous = sample.at;
  }
  return to - previous <= bound;
}

/** Every minute in `[from, to)` sits at or below the ceiling, and all of it is measured. */
function quiet(
  samples: readonly ExertionSample[],
  ceilingBpm: number,
  from: number,
  to: number
): boolean {
  if (!covered(samples, from, to)) return false;
  return !samples.some((s) => s.at >= from && s.at < to && s.bpm > ceilingBpm);
}

function overlaps(a: ExertionSpan, b: ExertionSpan): boolean {
  return a.from < b.to && b.from < a.to;
}

export interface ExertionWindowInput {
  /** The trace, in any order; minutes outside the day of interest are harmless. */
  samples: readonly ExertionSample[];
  /** `restingCeilingBpm` — the top of this profile's own resting range. */
  ceilingBpm: number;
  /** `usualRecoveryMin` over their own recent sessions, or null with no usual. */
  usualRecoveryMin: number | null;
  /** Their own shortest logged sessions, or null with nothing logged. */
  minWindowMin: number | null;
  /** Windows an activity or practice row already accounts for. */
  claimed: readonly ExertionSpan[];
}

/** How long a span must run to be a session, FOR THIS PROFILE — theirs, else the default. */
export function exertionFloorMin(minWindowMin: number | null): number {
  return Math.round(minWindowMin ?? EXERTION_MIN_WINDOW_DEFAULT_MIN);
}

/** How long the quiet either side of a span must run, FOR THIS PROFILE. */
export function exertionRecoveryMin(usualRecoveryMin: number | null): number {
  return Math.round(usualRecoveryMin ?? EXERTION_RECOVERY_DEFAULT_MIN);
}

/**
 * The finished efforts this trace holds that nothing has claimed yet.
 *
 * Ordered oldest first. A span overlapping ANY claimed window is dropped whole rather
 * than trimmed: a session logged over part of an effort is that effort, and offering
 * the remainder as a second one would invite two rows for one workout.
 */
export function exertionWindows(input: ExertionWindowInput): ExertionSpan[] {
  const samples = sorted(input.samples);
  if (samples.length === 0) return [];
  const recovery = exertionRecoveryMin(input.usualRecoveryMin) * MINUTE_MS;
  const floor = exertionFloorMin(input.minWindowMin) * MINUTE_MS;

  const spans: ExertionSpan[] = [];
  let run: ExertionSpan | null = null;
  for (const sample of samples) {
    if (sample.bpm > input.ceilingBpm) {
      run =
        run == null
          ? { from: sample.at, to: sample.at + MINUTE_MS }
          : { from: run.from, to: sample.at + MINUTE_MS };
      continue;
    }
    if (run) spans.push(run);
    run = null;
  }
  // A run still open at the last measured minute is deliberately NOT pushed: it is a
  // session in progress. Nothing enforces that here, because nothing needs to — the
  // trailing-quiet test below refuses it for the same reason, there being no measured
  // quiet after the frontier. Pushing it and letting that test speak was tried; the
  // suite could not tell the two apart, which is what says the rule lives there.

  return spans.filter((span) => {
    if (span.to - span.from < floor) return false;
    // QUIET ON BOTH SIDES, and the trace's own edges cannot supply it — which needs no
    // separate rule, because `quiet` requires the stretch to be MEASURED and a stretch
    // past either end of the trace is not. That is the same sentence as "coverage is
    // not recovery", read at the edges: a span still elevated at the frontier has no
    // measured quiet after it, and one already under way at the first minute has none
    // before it. A bound written here instead would be a second statement of a rule
    // `covered` already makes, and the two would drift.
    if (!quiet(samples, input.ceilingBpm, span.from - recovery, span.from))
      return false;
    if (!quiet(samples, input.ceilingBpm, span.to, span.to + recovery))
      return false;
    if (!covered(samples, span.from, span.to)) return false;
    return !input.claimed.some((claim) => overlaps(span, claim));
  });
}

/**
 * THE EFFORT THAT CONTAINS THE START, and nothing after it — or null when the start is
 * inside no effort at all.
 *
 * `samples` is the trace from `startedAt` onward, in instant order. Two bounds, and both
 * are `recoveryMs`, which is the number this module already uses to say an effort has
 * ended. Nothing new is invented in either direction.
 *
 * ── WHERE THE EFFORT ENDS ────────────────────────────────────────────────────
 * The cut is made where `detectedWorkoutEnd` would already have declared an end:
 * `recoveryMs` of quiet after an elevated minute. Same threshold, so this introduces no
 * second judgment and cannot move a candidate that would have been chosen — the samples
 * before the cut are unchanged. A trace holding one effort is returned whole.
 *
 * ── WHERE IT BEGINS, WHICH IS THE HALF THE FIRST DRAFT DID NOT HAVE ──────────
 * That draft walked forward to the FIRST elevated minute at or after the start and
 * called it this session's. So a row started at 08:00 whose wrist went on at 17:00, or
 * whose trace has nothing elevated until an evening run, was answered with the run's
 * end: 08:00–19:00, eleven hours of "strength training", written unattended. It closed
 * the case it was shown and left the neighbouring one open.
 *
 * "Contains the start" is a claim about the start, so it is asked about the start: the
 * elevated minutes must begin before `recoveryMs` of quiet has passed since it, and that
 * quiet must be MEASURED. Beyond that much quiet, the effort the start was in has ended
 * by this module's own rule — or never happened — and either way the trace does not say
 * when this session finished. Null, and the stale suggest stays the fallback, which is
 * "the trace decides, never the clock" read at the opening edge.
 *
 * The cost is a real case and it is small: a profile whose own `usualRecoveryMin` is six
 * minutes, warming up for seven below their own ceiling, gets no detected end. That is
 * the same trade the module makes everywhere — their own measured number wins even when
 * it is smaller than the default — and it fails toward the refusal.
 */
function effortFromStart(
  samples: readonly ExertionSample[],
  ceilingBpm: number,
  recoveryMs: number,
  startedAt: number
): ExertionSample[] | null {
  let first = -1;
  for (let i = 0; i < samples.length; i++)
    if (samples[i].bpm > ceilingBpm) {
      first = i;
      break;
    }
  if (first < 0) return null;
  const begins = samples[first].at;
  if (begins - startedAt >= recoveryMs) return null;
  // Unmeasured minutes between the start and the effort are not quiet either — the same
  // sentence `covered` makes everywhere else in this file. Without it a trace that
  // simply BEGINS elevated the next day reads as containing the start.
  if (!covered(samples, startedAt, begins)) return null;

  let quietFrom: number | null = null;
  for (let i = first; i < samples.length; i++) {
    const sample = samples[i];
    if (sample.bpm > ceilingBpm) {
      quietFrom = null;
      continue;
    }
    if (quietFrom == null) quietFrom = sample.at;
    else if (sample.at - quietFrom >= recoveryMs)
      return samples.slice(0, i + 1);
  }
  return [...samples];
}

/**
 * The END an open row should adopt, or null when the trace does not say.
 *
 * Reader 1 of the detector (#5113). "Open" is the ROW's shape rather than the editor's
 * mode: a row with a start and no end, live or left open in the plain form while sets
 * are added. The end is the last elevated minute of the effort that contains the
 * start, and it is only offered once the quiet after it has actually been measured.
 *
 * A SET LOGGED AFTER THE CANDIDATE MINUTE CANCELS IT. A long rest between sets does
 * not reach the resting range for most people, and when it does, the next set reopens
 * the session — so a set on the far side of the candidate is proof the session had not
 * ended there. That is the one rule keeping this from finishing somebody mid-workout.
 *
 * ── THE EFFORT THAT CONTAINS THE START, AND NOTHING AFTER IT ─────────────────
 * "The effort that contains the start" is the whole of the promise, and the loop below
 * used to take the last elevated minute of EVERYTHING it was handed. Handed a day, an
 * 08:00–08:40 session with an 18:00 run on it was answered 19:00: twelve hours of
 * "strength training", written unattended. A caller can bound its own gather, but the
 * segmenting is this function's contract rather than the caller's — so the cut is made
 * here, and a caller may hand over as many days as it likes.
 *
 * ── THE WHOLE TRACE MUST HAVE COME TO REST, NOT JUST THAT EFFORT ─────────────
 * Segmenting moved the frontier, and the frontier is what says "a span still elevated at
 * the end of the trace is a session in progress". Read on the CUT trace alone, a person
 * resting between heavy sets long enough to drop inside their own range — and elevated
 * again right now — had that refusal turned into an answer: the row flipped to finished
 * mid-workout, which reaches the safety-tier post-workout dispatch and takes away the
 * stale suggest's Finish button in the same move. The `updated_at` cancel does not catch
 * it, because a set logged while still elevated stamps BEFORE the candidate.
 *
 * So the frontier question is asked of the WHOLE trace and the candidate is taken from
 * the effort containing the start. Both rules survive segmentation, which is what the
 * cut owed them. The cost is a delay and never a wrong write: someone who leaves this
 * morning's session open and goes running at six has it finished after the run, at this
 * morning's minute.
 */
export function detectedWorkoutEnd(input: {
  samples: readonly ExertionSample[];
  ceilingBpm: number;
  usualRecoveryMin: number | null;
  /** The row's own start instant. */
  startedAt: number;
  /** The newest set's instant on this row, when there is one. */
  lastSetAt: number | null;
}): number | null {
  const recovery = exertionRecoveryMin(input.usualRecoveryMin) * MINUTE_MS;
  const trace = sorted(input.samples).filter((s) => s.at >= input.startedAt);
  if (trace.length === 0) return null;

  // NOBODY IS STILL GOING. Asked of the whole trace, before any segmenting — see the
  // header. The newest elevated minute anywhere past the start must have `recovery` of
  // measured quiet after it, or this person is exerting right now and no session of
  // theirs has ended.
  const frontier = trace[trace.length - 1].at + MINUTE_MS;
  let newest: number | null = null;
  for (const sample of trace)
    if (sample.bpm > input.ceilingBpm) newest = sample.at + MINUTE_MS;
  if (newest == null) return null;
  if (newest + recovery > frontier) return null;
  if (!quiet(trace, input.ceilingBpm, newest, newest + recovery)) return null;

  const samples = effortFromStart(
    trace,
    input.ceilingBpm,
    recovery,
    input.startedAt
  );
  if (samples == null) return null;

  // The newest elevated minute is where this session ended, if it ended at all — an
  // earlier one would be a rest the person came back from.
  let candidate: number | null = null;
  for (const sample of samples) {
    if (sample.bpm > input.ceilingBpm) candidate = sample.at + MINUTE_MS;
  }
  if (candidate == null) return null;
  // The candidate's own closing quiet, asked of the WHOLE trace. The two are equivalent
  // today and provably so — the cut always extends at least `recovery` past the
  // candidate, because that is the arithmetic it cuts on — which is exactly why it is
  // asked here: the answer then does not depend on that property continuing to hold.
  // No test separates them, and none can while it does.
  if (!quiet(trace, input.ceilingBpm, candidate, candidate + recovery))
    return null;
  if (input.lastSetAt != null && input.lastSetAt >= candidate) return null;
  return candidate;
}
