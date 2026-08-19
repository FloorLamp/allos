// PURE TIER — the shared whole-dispatch deadline (#3057), on a fake clock (no
// two-real-minute waits). What is pinned:
//
//   1. an attempt that never settles cannot hold the fan-out past the deadline —
//      and the others keep the results they earned;
//   2. the still-pending attempt resolves as ok:false with the TYPED timeout
//      (never success, never an empty "nothing configured" result set);
//   3. a late settlement after the deadline is observed for logging only — it
//      cannot mutate the results the caller already acted on, and a late
//      REJECTION never surfaces as an unhandled rejection;
//   4. the deadline is a last resort: a fan-out that settles in time resolves
//      with its ordinary results and never waits for the clock.
//
// The end-to-end half — dispatch() feeding these results into the delivery-health
// marker over a live schema — lives in lib/__db_tests__/dispatch-deadline.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DispatchTimeoutError,
  NOTIFICATION_DISPATCH_TIMEOUT_MS,
  settleWithinDeadline,
  type DispatchResult,
} from "../notifications/dispatch-deadline";

const DEADLINE = NOTIFICATION_DISPATCH_TIMEOUT_MS;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("settleWithinDeadline (#3057)", () => {
  it("resolves with the ordinary results when every attempt settles in time", async () => {
    const onLate = vi.fn();
    const results = await settleWithinDeadline(
      [
        { id: "telegram", promise: Promise.resolve({ id: "telegram", ok: true }) },
        {
          id: "push",
          promise: Promise.resolve({
            id: "push",
            ok: false,
            error: "endpoint gone",
          }),
        },
      ],
      DEADLINE,
      onLate
    );
    // No clock advance was needed: the deadline is a ceiling, not a wait.
    expect(results).toEqual([
      { id: "telegram", ok: true },
      { id: "push", ok: false, error: "endpoint gone" },
    ]);
    expect(onLate).not.toHaveBeenCalled();
  });

  it("a never-settling attempt cannot hold the fan-out past the deadline", async () => {
    const stuck = deferred<DispatchResult>();
    let results: DispatchResult[] | null = null;
    void settleWithinDeadline(
      [
        { id: "telegram", promise: Promise.resolve({ id: "telegram", ok: true }) },
        { id: "push", promise: stuck.promise },
      ],
      DEADLINE,
      () => {}
    ).then((r) => {
      results = r;
    });

    // One tick shy of the deadline the stuck channel is still owed its chance.
    await vi.advanceTimersByTimeAsync(DEADLINE - 1);
    expect(results).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(results).not.toBeNull();
    // The settled channel keeps the result it earned…
    expect(results![0]).toEqual({ id: "telegram", ok: true });
    // …and the pending one is a TYPED timeout failure: ok:false, never success,
    // never a shrunken result set.
    expect(results![1].id).toBe("push");
    expect(results![1].ok).toBe(false);
    expect(results![1].timedOut).toBe(true);
    expect(results![1].error).toBe(
      new DispatchTimeoutError("push", DEADLINE).message
    );
  });

  it("a late settlement is observed for logging and mutates nothing", async () => {
    const stuck = deferred<DispatchResult>();
    const onLate = vi.fn();
    const pending = settleWithinDeadline(
      [{ id: "push", promise: stuck.promise }],
      DEADLINE,
      onLate
    );
    await vi.advanceTimersByTimeAsync(DEADLINE);
    const results = await pending;
    expect(results[0].timedOut).toBe(true);
    expect(onLate).not.toHaveBeenCalled();

    // The send finally answers, long after anyone could act on it.
    stuck.resolve({ id: "push", ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(onLate).toHaveBeenCalledExactlyOnceWith("push", {
      id: "push",
      ok: true,
    });
    // The results the caller already holds are frozen — still the timeout.
    expect(results[0]).toMatchObject({ id: "push", ok: false, timedOut: true });
  });

  it("a late REJECTION is folded into a failure result, never an unhandled rejection", async () => {
    const stuck = deferred<DispatchResult>();
    const onLate = vi.fn();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const pending = settleWithinDeadline(
        [{ id: "email", promise: stuck.promise }],
        DEADLINE,
        onLate
      );
      await vi.advanceTimersByTimeAsync(DEADLINE);
      const results = await pending;
      expect(results[0].timedOut).toBe(true);

      stuck.reject(new Error("relay closed the socket"));
      await vi.advanceTimersByTimeAsync(0);
      // Node reports unhandled rejections on a macrotask; give it one.
      vi.useRealTimers();
      await new Promise((res) => setTimeout(res, 0));

      expect(onLate).toHaveBeenCalledExactlyOnceWith("email", {
        id: "email",
        ok: false,
        error: "relay closed the socket",
      });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("a rejection BEFORE the deadline is an ordinary failure result", async () => {
    // dispatch() wraps every send in its own catch, so this should be
    // unreachable — but the helper's totality is what the no-unhandled-rejection
    // guarantee rests on, so it is pinned rather than assumed.
    const results = await settleWithinDeadline(
      [
        {
          id: "home-assistant",
          promise: Promise.reject(new Error("boom before the deadline")),
        },
      ],
      DEADLINE,
      () => {}
    );
    expect(results).toEqual([
      { id: "home-assistant", ok: false, error: "boom before the deadline" },
    ]);
  });

  it("the shared deadline is the documented 120 seconds", () => {
    expect(NOTIFICATION_DISPATCH_TIMEOUT_MS).toBe(120_000);
  });
});
