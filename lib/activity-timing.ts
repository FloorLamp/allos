// The canonical ACTIVE-vs-ELAPSED activity-time model (issue #1202). One pure
// computation over the stored fields that EVERY surface reads (pace, records,
// timeline duration, training load, volume, recaps, coaching), so the two times
// can never disagree the way the old unnamed split did (#221). No React, no DB.
//
// The two quantities and their invariant:
//   • ACTIVE (moving/effort) time  = `activities.duration_min` = Σ(component active).
//     The pace/effort/volume/LOAD source — training minutes exclude rests, so this
//     is the number zones.ts sums. It is NOT the clock span.
//   • ELAPSED (wall-clock) time     = `end_time − start_time`, PREFERRING a stored
//     `elapsed_min` when present (the no-full-clock case). Genuinely its own
//     quantity: `elapsed − active` = the time that belongs to no component
//     (in-leg pauses/rests + between-leg brick transitions), so elapsed is never
//     derived from Σ(component) — that sum IS active.
//   • INVARIANT: `elapsed ≥ active`. A stored elapsed below active is a data error
//     (overlapping/duplicated legs) rejected at the write boundary (#132); the read
//     model treats an implausible elapsed as unknown rather than showing a negative
//     "rest".

import { minutesBetween } from "./activity-meta";

export interface ActivityTimingInput {
  // The stored active/effort minutes (`activities.duration_min`, or Σ component).
  durationMin: number | null;
  // A stored wall-clock span, when a source/entry gave elapsed without full
  // timestamps. Preferred over the derived `end−start` span.
  elapsedMin?: number | null;
  // Day-local "HH:MM" clock fields — their span is the elapsed fallback.
  startTime?: string | null;
  endTime?: string | null;
}

export interface ActivityTiming {
  // The headline "how much you did" — pace/records/volume/load all read this.
  activeMin: number | null;
  // The labeled secondary wall-clock span, when known and plausible (≥ active).
  elapsedMin: number | null;
  // The rest gap (`elapsed − active`): in-leg pauses + brick transitions. Null
  // when either time is unknown, or elapsed is implausible.
  restMin: number | null;
}

// The `elapsed ≥ active` invariant as a predicate. True (vacuously) when either is
// unknown. The write boundary rejects a submitted elapsed that fails this; the read
// model uses it to decide whether an elapsed value is trustworthy.
export function isElapsedPlausible(
  activeMin: number | null,
  elapsedMin: number | null
): boolean {
  if (activeMin == null || elapsedMin == null) return true;
  return elapsedMin >= activeMin;
}

// Resolve the wall-clock elapsed span: a stored `elapsed_min` PREFERRED, else the
// `end − start` span (Strava stores `end = start + elapsed_time`, so its elapsed is
// free here). Null when neither is available.
export function resolveElapsedMin(input: ActivityTimingInput): number | null {
  if (input.elapsedMin != null) return input.elapsedMin;
  if (input.startTime && input.endTime)
    return minutesBetween(input.startTime, input.endTime);
  return null;
}

// THE canonical model (see file header). Every surface formats over this result.
export function activityTiming(input: ActivityTimingInput): ActivityTiming {
  const activeMin = input.durationMin ?? null;
  const rawElapsed = resolveElapsedMin(input);
  // Only surface an elapsed that honors the invariant — a bad row shows no rest,
  // never a negative one.
  const elapsedMin = isElapsedPlausible(activeMin, rawElapsed)
    ? rawElapsed
    : null;
  const restMin =
    activeMin != null && elapsedMin != null && elapsedMin >= activeMin
      ? elapsedMin - activeMin
      : null;
  return { activeMin, elapsedMin, restMin };
}
