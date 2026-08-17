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
  POST_WORKOUT_DISPATCH_TIMEOUT_MS,
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
    // not on the clock. Time passing does not start it — up to the deadline the
    // wait is bounded by (see "a dispatch that never settles" below), which is two
    // orders of magnitude past a healthy send.
    await vi.advanceTimersByTimeAsync(POST_WORKOUT_DISPATCH_TIMEOUT_MS - 1);
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

  it("a run rejecting with an UNSTRINGIFIABLE value still drains the tick's exit", async () => {
    // `String(v)` is not total: a null-prototype value raises "Cannot convert object
    // to primitive value". Thrown from a queued run, that throw lands INSIDE the
    // catch that is supposed to contain it — so the chain entry rejects, the flush's
    // Promise.all short-circuits, and every other profile behind it is dropped
    // un-awaited. No production path produces such a value; the containment claim in
    // this module's header is what has to hold anyway.
    const unstringifiable = Object.create(null) as Record<string, never>;
    const second = vi.fn(async () => {});
    queuePostWorkoutDispatch(1, 47, 60_000, async () => {
      throw unstringifiable;
    });
    queuePostWorkoutDispatch(2, 48, 60_000, second);

    await expect(flushPostWorkoutDispatches()).resolves.toBeUndefined();
    expect(second).toHaveBeenCalledTimes(1);
    expect(serializedPostWorkoutProfiles()).toEqual([]);
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

// ── A run that never settles cannot hold the queue open ──────────────────────
//
// The serialization above makes one run's latency the next run's delay, and a
// dispatch has no natural ceiling of its own: the channels fan out under
// Promise.all, so one push endpoint that accepts the connection and never answers
// is the whole run's latency. Unbounded, a genuinely SEPARATE session would never
// be announced at all, and the tick's exit drain would never return — silence,
// which is the harm this tier exists to prevent, traded for avoiding a duplicate.
describe("a dispatch that never settles", () => {
  function hangingRunner(hangOn: number) {
    const started: number[] = [];
    const run = vi.fn(async (_profileId: number, activityId: number) => {
      started.push(activityId);
      // No resolve, ever: the shape of a send that got a connection and no answer.
      if (activityId === hangOn) await new Promise<void>(() => {});
    });
    return { run, started };
  }

  it("does not stop the NEXT activity from ever dispatching", async () => {
    const { run, started } = hangingRunner(47);
    // Two genuinely separate sessions — not two rows of one ride. The second one
    // is owed its own message.
    queuePostWorkoutDispatch(1, 47, 60_000, run);
    queuePostWorkoutDispatch(1, 99, 60_000, run);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(started).toEqual([47]);

    // Six hours of clock. Unbounded, row 99 is still waiting on a run that will
    // never finish, and no amount of time releases it.
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);

    // THE ASSERTION. The stuck run's hold was given up, and 99 spoke.
    expect(started).toEqual([47, 99]);
    expect(serializedPostWorkoutProfiles()).toEqual([]);
  });

  it("gives the stuck run its full deadline first — the window is not shortened", async () => {
    // The bound is a deadline, not a shorter serialization window: a slow-but-
    // working dispatch is never cut off early, and the twin behind it still waits.
    const { run, started } = hangingRunner(47);
    queuePostWorkoutDispatch(1, 47, 60_000, run);
    queuePostWorkoutDispatch(1, 48, 60_000, run);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(POST_WORKOUT_DISPATCH_TIMEOUT_MS - 1);
    expect(started).toEqual([47]);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual([47, 48]);
  });

  it("the tick's exit drain still returns", async () => {
    // flushPostWorkoutDispatches() runs before the notify process exits. If it can
    // hang, the tick hangs — and the hourly backstop, the thing that makes a
    // dropped dispatch survivable, stops running at all.
    const { run } = hangingRunner(47);
    queuePostWorkoutDispatch(1, 47, 60_000, run);

    let flushed = false;
    const flush = flushPostWorkoutDispatches().then(() => {
      flushed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(flushed).toBe(false); // it is genuinely waiting on the hung run

    // An hour of clock. Unbounded, this is still false and the tick never exits.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(flushed).toBe(true);
    await flush;
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
