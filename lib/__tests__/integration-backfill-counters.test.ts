import { describe, expect, it } from "vitest";
import {
  queuedBackfillCounters,
  runningBackfillCompleted,
  type BackfillCounterState,
} from "@/lib/integrations/backfill-counters";

// A tiny model of one backfill run, so the tests can state a scenario the way the job
// experiences it: how many candidates the query returns, how many of them this run
// imports, and how many it gets a final "no" for. Everything else is the arithmetic
// under test.
function runJob(
  prior: BackfillCounterState | null,
  candidates: number,
  { backfilled = 0, unavailable = 0 } = {}
): { queued: BackfillCounterState; ended: BackfillCounterState } {
  const start = queuedBackfillCounters(prior, candidates);
  const queued = {
    total_items: start.total,
    completed_items: start.completed,
  };
  // The runner's own contract: successfully imported items leave the candidate query,
  // unavailable ones stay in it but are subtracted from `remaining`.
  const remaining = Math.max(candidates - backfilled - unavailable, 0);
  return {
    queued,
    ended: {
      total_items: queued.total_items,
      completed_items: runningBackfillCompleted(queued.total_items, remaining),
    },
  };
}

describe("queuedBackfillCounters", () => {
  it("starts a fresh batch at 0 of N", () => {
    expect(queuedBackfillCounters(null, 40)).toEqual({
      total: 40,
      completed: 0,
    });
    expect(queuedBackfillCounters(null, 0)).toEqual({ total: 0, completed: 0 });
  });

  it("resumes a part-finished job at its prior figures (#2195)", () => {
    // 100 candidates, 60 imported, then a network error. 40 still in the query.
    expect(
      queuedBackfillCounters({ total_items: 100, completed_items: 60 }, 40)
    ).toEqual({ total: 100, completed: 60 });
  });

  it("holds the denominator across retries that resolve nothing (#2672)", () => {
    // Two candidates: one permanently unavailable, one failing retryably. The
    // unavailable one is credited into `completed_items` AND still returned by the
    // candidate query, so `completed_items + candidates` counted it twice and the
    // denominator climbed 2 → 3 → 4 → 5 on successive retries.
    let state: BackfillCounterState | null = null;
    const seen: string[] = [];
    for (let retry = 0; retry < 4; retry++) {
      const { queued, ended } = runJob(state, 2, { unavailable: 1 });
      seen.push(`${queued.completed_items} of ${queued.total_items}`);
      state = ended;
    }
    expect(seen).toEqual(["0 of 2", "0 of 2", "0 of 2", "0 of 2"]);
    expect(state).toEqual({ total_items: 2, completed_items: 1 });
  });

  it("credits only the items the next run will not ask about again", () => {
    // Same shape, but the retryable candidate imports on the second attempt. What is
    // carried across the re-queue is the imported ride, never the unavailable one.
    const first = runJob(null, 2, { unavailable: 1 });
    expect(first.ended).toEqual({ total_items: 2, completed_items: 1 });

    const second = runJob(first.ended, 2, { backfilled: 1, unavailable: 1 });
    expect(second.queued).toEqual({ total_items: 2, completed_items: 0 });
    expect(second.ended).toEqual({ total_items: 2, completed_items: 2 });

    // One ride left the query for good; a further retry re-asks only the unavailable
    // one and carries the imported one.
    const third = runJob(second.ended, 1, { unavailable: 1 });
    expect(third.queued).toEqual({ total_items: 2, completed_items: 1 });
  });

  it("never lets the credited count exceed the total", () => {
    for (const candidates of [0, 1, 5, 40]) {
      for (const prior of [
        null,
        { total_items: 0, completed_items: 0 },
        { total_items: 3, completed_items: 3 },
        { total_items: 100, completed_items: 60 },
      ]) {
        const { total, completed } = queuedBackfillCounters(prior, candidates);
        expect(completed).toBeGreaterThanOrEqual(0);
        expect(completed).toBeLessThanOrEqual(total);
        // The claim the bar makes: what is left is what the query still returns.
        expect(total - completed).toBe(Math.min(candidates, total));
      }
    }
  });

  it("keeps the bar still when the candidate set shrinks under it", () => {
    // Rides deleted between the failure and the retry. The floor is deliberate: a
    // shrinking candidate set must not walk the bar backwards.
    expect(
      queuedBackfillCounters({ total_items: 100, completed_items: 60 }, 10)
    ).toEqual({ total: 100, completed: 90 });
  });

  it("grows the denominator once new candidates outrun the prior total", () => {
    // The conservative direction. New candidates hide under the floor while it still
    // covers them (the split is understated, the work left is not), and the total
    // grows as soon as they do not.
    expect(
      queuedBackfillCounters({ total_items: 100, completed_items: 60 }, 45)
    ).toEqual({ total: 100, completed: 55 });
    expect(
      queuedBackfillCounters({ total_items: 100, completed_items: 60 }, 140)
    ).toEqual({ total: 140, completed: 0 });
  });
});

describe("runningBackfillCompleted", () => {
  it("credits everything the run no longer needs to ask about", () => {
    expect(runningBackfillCompleted(10, 4)).toBe(6);
    expect(runningBackfillCompleted(10, 0)).toBe(10);
  });

  it("never reports negative progress or moves under its floor", () => {
    expect(runningBackfillCompleted(2, 5)).toBe(0);
    expect(runningBackfillCompleted(10, 8, 6)).toBe(6);
  });
});
