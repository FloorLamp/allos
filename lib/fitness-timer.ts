// Pure timer model for the Fitness-check large-format timed tests (#1275). The engine is
// a small set of pure functions over INJECTED epoch-ms timestamps — the React component is
// a thin formatter over these, so start/pause/resume/finish and the countdown end-state are
// unit-testable without a fake DOM clock. (The app's date-derivation clock seam in
// lib/clock.ts deliberately EXCLUDES timers — see its header — so the timer keeps real
// Date.now at runtime and the tests drive these functions with explicit `now` values.)
//
// Two modes, chosen by the test's dataset window (lib/fitness-battery `timerWindow`):
//   • count-UP (no window): plank, dead hang, balance, TUG, Rockport mile. Finish stamps
//     the elapsed whole seconds into the test's seconds input.
//   • countDOWN (a window): chair stand / arm curl (30s), 2-minute step (120s), the Cooper
//     (720s) / Queens step (180s) VO2 field tests. Counts down from the window and ends
//     itself at 0:00 with a cue; the result (reps / distance) is entered after.

// The mutable timer run: when running, `startedAt` is the epoch-ms the current run began and
// `accumulatedMs` is time banked from earlier runs (before a pause); when paused/idle,
// `startedAt` is null and `accumulatedMs` holds all elapsed time. This split lets pause/resume
// work off a single monotonic wall clock without storing a running total every tick.
export interface TimerRun {
  startedAt: number | null;
  accumulatedMs: number;
}

// A fresh, un-started timer.
export const IDLE_TIMER: TimerRun = { startedAt: null, accumulatedMs: 0 };

// How many trailing seconds count as the "final countdown" (haptic/aria warning window).
export const FINAL_COUNTDOWN_SECONDS = 10;

// Whether the run is actively counting.
export function isRunning(run: TimerRun): boolean {
  return run.startedAt != null;
}

// Total elapsed milliseconds at `now` — banked time plus the live segment if running.
// Never negative even if `now` precedes `startedAt` (a clock hiccup).
export function elapsedMs(run: TimerRun, now: number): number {
  const live = run.startedAt != null ? Math.max(0, now - run.startedAt) : 0;
  return run.accumulatedMs + live;
}

// Elapsed whole seconds (floored) — what Finish stamps into a count-up test's input.
export function elapsedSeconds(run: TimerRun, now: number): number {
  return Math.floor(elapsedMs(run, now) / 1000);
}

// Begin/resume the run at `now`. Idempotent while already running (keeps the existing
// start so the elapsed total doesn't jump).
export function startRun(run: TimerRun, now: number): TimerRun {
  if (run.startedAt != null) return run;
  return { startedAt: now, accumulatedMs: run.accumulatedMs };
}

// Pause the run at `now`, banking the live segment into `accumulatedMs`. No-op if already
// paused.
export function pauseRun(run: TimerRun, now: number): TimerRun {
  if (run.startedAt == null) return run;
  return { startedAt: null, accumulatedMs: elapsedMs(run, now) };
}

// The derived state of a countdown timer at `now`, given its window (seconds).
export interface CountdownState {
  // Whole seconds left on the clock, clamped at 0 (ceil so a window of 30 shows "30" for
  // its first live second and reaches "0" exactly at end).
  remainingSeconds: number;
  // The window has fully elapsed — the cue fires and the flow flips to the result input.
  ended: boolean;
  // Inside the final warning window and not yet ended — drives the last-10s aria/haptic
  // announcement without re-firing the end cue.
  finalCountdown: boolean;
}

// Derive a countdown timer's presentation state purely from its window + run + now.
export function countdownState(
  windowSeconds: number,
  run: TimerRun,
  now: number
): CountdownState {
  const elapsed = elapsedMs(run, now) / 1000;
  const remainingExact = windowSeconds - elapsed;
  const ended = remainingExact <= 0;
  const remainingSeconds = ended ? 0 : Math.ceil(remainingExact);
  return {
    ended,
    remainingSeconds,
    finalCountdown: !ended && remainingSeconds <= FINAL_COUNTDOWN_SECONDS,
  };
}

// The value Finish hands back to the form. A count-up test (no window) fills the elapsed
// whole seconds into its seconds input; a windowed (countdown) test fills nothing — Finish
// flips to the reps/distance result input instead — so this returns null there. (#794: the
// value only prefills; the user still submits explicitly.)
export function finishFill(
  windowSeconds: number | undefined,
  run: TimerRun,
  now: number
): number | null {
  if (windowSeconds != null) return null;
  return elapsedSeconds(run, now);
}
