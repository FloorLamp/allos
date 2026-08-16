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
  serializedPostWorkoutProfiles,
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

// ── Two rows from ONE push cannot run concurrently (#3021) ───────────────────
//
// The dispatch's twin guard is read-then-act, and its marker is stamped only after a
// successful delivery. A Health Connect push landing two rows of one bike ride armed
// two timers microseconds apart; both expired in the same tick, both read the marker
// before either had delivered, and one ride produced two recaps. The queue already
// serializes on the tick's flush path; the raw-timer path had nothing.
//
// A deferred runner is the whole point of these: a runner that resolves immediately
// serializes by accident, and would pass against the racing code.
describe("two dispatches armed together (#3021)", () => {
  function deferredRunner() {
    const started: number[] = [];
    const releases: (() => void)[] = [];
    const run = vi.fn(async (_profileId: number, activityId: number) => {
      started.push(activityId);
      await new Promise<void>((resolve) => releases.push(resolve));
    });
    return { run, started, releases };
  }

  it("runs the SECOND only after the first has finished — never both in flight", async () => {
    const { run, started, releases } = deferredRunner();
    // One ingest, two fresh rows of the same session.
    queuePostWorkoutDispatch(1, 47, 60_000, run);
    queuePostWorkoutDispatch(1, 48, 60_000, run);
    expect(pendingPostWorkoutDispatchKeys().sort()).toEqual(["1:47", "1:48"]);

    // Both timers expire in the same tick, exactly as they do in production.
    await vi.advanceTimersByTimeAsync(60_000);

    // THE ASSERTION. Row 47's dispatch is mid-flight — it has not delivered, so it
    // has not stamped — and row 48's must not have read the marker yet.
    expect(started).toEqual([47]);
    expect(run).toHaveBeenCalledTimes(1);

    // Nothing about the delay was widened: the second run is waiting on the FIRST,
    // not on the clock. Time passing does not start it.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(started).toEqual([47]);

    // The first delivers and stamps; only now does the second run — and reads it.
    releases[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([47, 48]);
    releases[1]();
    await vi.advanceTimersByTimeAsync(0);
    expect(serializedPostWorkoutProfiles()).toEqual([]);
  });

  it("does NOT serialize across profiles — two people's sessions never wait on each other", async () => {
    // The bound on the fix. The marker is profile-scoped, so two profiles share
    // nothing; making one household member's ride block another's would be a new bug.
    const { run, started, releases } = deferredRunner();
    queuePostWorkoutDispatch(1, 47, 60_000, run);
    queuePostWorkoutDispatch(2, 48, 60_000, run);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(started).toEqual([47, 48]);
    releases.forEach((release) => release());
    await vi.advanceTimersByTimeAsync(0);
  });

  it("a THROWING first run still lets the second through", async () => {
    // The chain must not be a single point of failure: a dispatch that blows up is
    // contained (logged), and the next queued run still happens.
    const seen: number[] = [];
    const run = vi.fn(async (_profileId: number, activityId: number) => {
      seen.push(activityId);
      if (activityId === 47) throw new Error("forced dispatch failure");
    });
    queuePostWorkoutDispatch(1, 47, 60_000, run);
    queuePostWorkoutDispatch(1, 48, 60_000, run);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen).toEqual([47, 48]);
  });

  it("the tick's flush waits for a run the WEB process already had in flight", async () => {
    // flushPostWorkoutDispatches() exists so the tick doesn't exit with a dispatch
    // behind it. A run already on the chain has left `pending`, so the flush has to
    // await the chain as well as its own entries.
    const { run, releases } = deferredRunner();
    queuePostWorkoutDispatch(1, 47, 60_000, run);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(pendingPostWorkoutDispatchKeys()).toEqual([]);

    let flushed = false;
    const flush = flushPostWorkoutDispatches().then(() => {
      flushed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(flushed).toBe(false);
    releases[0]();
    await flush;
    expect(flushed).toBe(true);
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
