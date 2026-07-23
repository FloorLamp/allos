import { describe, expect, it } from "vitest";
import {
  IDLE_TIMER,
  FINAL_COUNTDOWN_SECONDS,
  isRunning,
  elapsedMs,
  elapsedSeconds,
  startRun,
  pauseRun,
  countdownState,
  finishFill,
} from "@/lib/fitness-timer";

// The fitness-check timer engine drives entirely off injected epoch-ms timestamps (#1275):
// no Date.now, no fake DOM clock. Every assertion feeds explicit `now` values so start /
// pause / resume / finish and the countdown end-state are deterministic.

const T0 = 1_700_000_000_000; // an arbitrary fixed epoch anchor

describe("count-up run (elapsed / start / pause / resume)", () => {
  it("idle is not running and has zero elapsed", () => {
    expect(isRunning(IDLE_TIMER)).toBe(false);
    expect(elapsedMs(IDLE_TIMER, T0)).toBe(0);
    expect(elapsedSeconds(IDLE_TIMER, T0)).toBe(0);
  });

  it("accrues live time while running", () => {
    const run = startRun(IDLE_TIMER, T0);
    expect(isRunning(run)).toBe(true);
    expect(elapsedMs(run, T0 + 5_500)).toBe(5_500);
    expect(elapsedSeconds(run, T0 + 5_500)).toBe(5); // floored whole seconds
  });

  it("start is idempotent — a second start doesn't reset the clock", () => {
    const run = startRun(IDLE_TIMER, T0);
    const again = startRun(run, T0 + 3_000);
    expect(again).toBe(run); // same object, original start kept
    expect(elapsedSeconds(again, T0 + 4_000)).toBe(4);
  });

  it("pause banks the live segment and freezes elapsed", () => {
    const running = startRun(IDLE_TIMER, T0);
    const paused = pauseRun(running, T0 + 7_000);
    expect(isRunning(paused)).toBe(false);
    expect(paused.accumulatedMs).toBe(7_000);
    // Elapsed no longer advances with `now` while paused.
    expect(elapsedSeconds(paused, T0 + 999_000)).toBe(7);
  });

  it("resume continues from the banked total across a pause gap", () => {
    const paused = pauseRun(startRun(IDLE_TIMER, T0), T0 + 7_000);
    // Resume 100s later (wall-clock gap doesn't count).
    const resumed = startRun(paused, T0 + 107_000);
    expect(elapsedSeconds(resumed, T0 + 110_000)).toBe(10); // 7 banked + 3 live
  });

  it("pause is a no-op when already paused, start a no-op edge is safe", () => {
    expect(pauseRun(IDLE_TIMER, T0)).toBe(IDLE_TIMER);
  });

  it("never returns negative elapsed on a backwards clock", () => {
    const run = startRun(IDLE_TIMER, T0);
    expect(elapsedMs(run, T0 - 5_000)).toBe(0);
  });
});

describe("countdown state derivation", () => {
  it("shows the full window for its first live second, then decrements", () => {
    const run = startRun(IDLE_TIMER, T0);
    expect(countdownState(30, run, T0).remainingSeconds).toBe(30);
    expect(countdownState(30, run, T0 + 500).remainingSeconds).toBe(30); // ceil
    expect(countdownState(30, run, T0 + 1_000).remainingSeconds).toBe(29);
    expect(countdownState(30, run, T0 + 1_001).remainingSeconds).toBe(29);
  });

  it("ends exactly at the window and clamps remaining at 0", () => {
    const run = startRun(IDLE_TIMER, T0);
    const before = countdownState(30, run, T0 + 29_999);
    expect(before.ended).toBe(false);
    expect(before.remainingSeconds).toBe(1);

    const at = countdownState(30, run, T0 + 30_000);
    expect(at.ended).toBe(true);
    expect(at.remainingSeconds).toBe(0);

    const after = countdownState(30, run, T0 + 45_000);
    expect(after.ended).toBe(true);
    expect(after.remainingSeconds).toBe(0);
  });

  it("flags the final warning window and clears it once ended", () => {
    const run = startRun(IDLE_TIMER, T0);
    // 11s remaining → not yet in the warning window.
    expect(countdownState(30, run, T0 + 19_000).finalCountdown).toBe(false);
    // Exactly FINAL_COUNTDOWN_SECONDS remaining → in the window.
    expect(
      countdownState(30, run, T0 + (30 - FINAL_COUNTDOWN_SECONDS) * 1_000)
        .finalCountdown
    ).toBe(true);
    // 1s remaining → still in the window.
    expect(countdownState(30, run, T0 + 29_000).finalCountdown).toBe(true);
    // Ended → warning window is off (the end cue takes over).
    expect(countdownState(30, run, T0 + 30_000).finalCountdown).toBe(false);
  });

  it("a paused countdown holds its remaining steady", () => {
    const paused = pauseRun(startRun(IDLE_TIMER, T0), T0 + 10_000);
    const s = countdownState(30, paused, T0 + 999_000);
    expect(s.remainingSeconds).toBe(20);
    expect(s.ended).toBe(false);
  });
});

describe("finishFill (what Finish hands the form)", () => {
  it("count-up (no window) fills the elapsed whole seconds", () => {
    const run = startRun(IDLE_TIMER, T0);
    expect(finishFill(undefined, run, T0 + 47_250)).toBe(47);
  });

  it("countdown (windowed) fills nothing — the result input is entered instead", () => {
    const run = startRun(IDLE_TIMER, T0);
    expect(finishFill(30, run, T0 + 12_000)).toBeNull();
  });
});
