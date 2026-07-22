// Issue #1154 §B: the delayed post-workout dispatch queue's timer semantics
// (arm → ~60s fire, re-arm coalescing, flush-on-tick-exit, error containment)
// with an injected runner (no DB/network — the heavy dispatch core is behind a
// dynamic import the injected runner replaces), plus the pure completed-session
// verification the fire-time guard uses.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  queuePostWorkoutDispatch,
  flushPostWorkoutDispatches,
  pendingPostWorkoutDispatchKeys,
  POST_WORKOUT_DISPATCH_DELAY_MS,
} from "../notifications/post-workout-queue";
import { isCompletedSessionRow } from "../workout-presence";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  // Drain anything a test left pending so cases can't leak into each other.
  await flushPostWorkoutDispatches();
  vi.useRealTimers();
});

describe("queuePostWorkoutDispatch", () => {
  it("fires the injected runner once after the delay (~60s), not immediately", async () => {
    const run = vi.fn(async () => {});
    queuePostWorkoutDispatch(1, 42, POST_WORKOUT_DISPATCH_DELAY_MS, run);
    expect(run).not.toHaveBeenCalled();
    expect(pendingPostWorkoutDispatchKeys()).toEqual(["1:42"]);

    await vi.advanceTimersByTimeAsync(POST_WORKOUT_DISPATCH_DELAY_MS);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(1, 42);
    expect(pendingPostWorkoutDispatchKeys()).toEqual([]);
  });

  it("re-arming the SAME activity coalesces to one send after it settles (finish→re-finish)", async () => {
    const run = vi.fn(async () => {});
    queuePostWorkoutDispatch(1, 42, 60_000, run);
    await vi.advanceTimersByTimeAsync(30_000);
    // The re-finish inside the window replaces the timer — never two sends.
    queuePostWorkoutDispatch(1, 42, 60_000, run);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).not.toHaveBeenCalled(); // old timer was cancelled
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("distinct activities keep their own timers", async () => {
    const run = vi.fn(async () => {});
    queuePostWorkoutDispatch(1, 42, 60_000, run);
    queuePostWorkoutDispatch(1, 43, 60_000, run);
    expect(pendingPostWorkoutDispatchKeys().sort()).toEqual(["1:42", "1:43"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("a throwing runner is contained (logged, never escapes the timer)", async () => {
    const run = vi.fn(async () => {
      throw new Error("forced dispatch failure");
    });
    queuePostWorkoutDispatch(1, 42, 60_000, run);
    await expect(vi.advanceTimersByTimeAsync(60_000)).resolves.not.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("flushPostWorkoutDispatches (the tick's exit drain)", () => {
  it("runs every pending dispatch NOW and clears the queue", async () => {
    const run = vi.fn(async () => {});
    queuePostWorkoutDispatch(1, 42, 60_000, run);
    queuePostWorkoutDispatch(2, 7, 60_000, run);
    await flushPostWorkoutDispatches();
    expect(run).toHaveBeenCalledTimes(2);
    expect(pendingPostWorkoutDispatchKeys()).toEqual([]);
    // The cancelled timers never double-fire later.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("isCompletedSessionRow (the fire-time verification)", () => {
  it("end_time set ⇒ completed (the live Finish)", () => {
    expect(
      isCompletedSessionRow({
        start_time: "18:00",
        end_time: "19:00",
        duration_min: null,
      })
    ).toBe(true);
  });
  it("start + positive duration ⇒ completed (a timed retro log)", () => {
    expect(
      isCompletedSessionRow({
        start_time: "07:00",
        end_time: null,
        duration_min: 45,
      })
    ).toBe(true);
  });
  it("no start_time at all ⇒ completed (an untimed retroactive log)", () => {
    expect(
      isCompletedSessionRow({
        start_time: null,
        end_time: null,
        duration_min: null,
      })
    ).toBe(true);
  });
  it("started-but-unended, duration-less ⇒ NOT completed (a live draft / undone finish)", () => {
    expect(
      isCompletedSessionRow({
        start_time: "18:00",
        end_time: null,
        duration_min: null,
      })
    ).toBe(false);
    expect(
      isCompletedSessionRow({
        start_time: "18:00",
        end_time: null,
        duration_min: 0,
      })
    ).toBe(false);
  });
});
