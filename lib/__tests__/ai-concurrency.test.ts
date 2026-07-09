import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXTRACTION_CONCURRENCY,
  Semaphore,
  extractionSemaphore,
} from "@/lib/ai-concurrency";

// Pure queue/permit logic (no DB, no network). Pins the semaphore invariants the
// extraction limiter relies on: never more than N in flight, FIFO queueing, and a
// permit that is always released — even when the wrapped task throws.

// A deferred promise whose resolution we control, to hold a task "in flight".
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("Semaphore", () => {
  it("rejects a non-positive or non-integer size", () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
    expect(new Semaphore(1).maxConcurrency).toBe(1);
  });

  it("acquire resolves immediately while permits are free, then parks callers", async () => {
    const s = new Semaphore(2);
    expect(s.available).toBe(2);
    await s.acquire();
    await s.acquire();
    expect(s.available).toBe(0);
    expect(s.inUse).toBe(2);

    let third = false;
    const p = s.acquire().then(() => {
      third = true;
    });
    await tick();
    expect(third).toBe(false); // parked — no free permit
    expect(s.waiting).toBe(1);

    s.release();
    await p;
    expect(third).toBe(true);
    expect(s.waiting).toBe(0);
  });

  it("never runs more than N tasks concurrently and queues the rest", async () => {
    const s = new Semaphore(3);
    const gates = Array.from({ length: 8 }, () => deferred());
    let active = 0;
    let peak = 0;
    let completed = 0;

    const runs = gates.map((g, i) =>
      s.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await g.promise;
        active--;
        completed++;
        return i;
      })
    );

    await tick();
    // At most 3 should have started; the remaining 5 wait for a permit.
    expect(active).toBe(3);
    expect(peak).toBe(3);

    // Release tasks one at a time; each completion admits exactly one waiter.
    for (let i = 0; i < gates.length; i++) {
      gates[i].resolve();
      await tick();
      expect(active).toBeLessThanOrEqual(3);
    }

    const results = await Promise.all(runs);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(3);
    expect(completed).toBe(8);
    // All permits returned to the pool once everything settles.
    expect(s.available).toBe(3);
    expect(s.inUse).toBe(0);
    expect(s.waiting).toBe(0);
  });

  it("releases the permit even when the task throws", async () => {
    const s = new Semaphore(1);
    await expect(
      s.run(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    // Permit was returned despite the throw — a fresh task can still run.
    const ok = await s.run(async () => "ok");
    expect(ok).toBe("ok");
    expect(s.available).toBe(1);
    expect(s.inUse).toBe(0);
  });

  it("preserves FIFO order among queued waiters", async () => {
    const s = new Semaphore(1);
    const order: number[] = [];
    const gate = deferred();

    // Occupy the single permit with a long-running task.
    const held = s.run(async () => {
      await gate.promise;
    });

    // Queue three waiters in order.
    const waiters = [1, 2, 3].map((n) =>
      s.run(async () => {
        order.push(n);
      })
    );

    await tick();
    expect(order).toEqual([]); // all still queued behind the held permit
    expect(s.waiting).toBe(3);

    gate.resolve();
    await held;
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
  });

  it("does not inflate capacity on a stray extra release", () => {
    const s = new Semaphore(2);
    s.release(); // nothing held — must not exceed max
    expect(s.available).toBe(2);
    s.release();
    expect(s.available).toBe(2);
  });
});

describe("extractionSemaphore singleton", () => {
  it("defaults to the code concurrency when AI_EXTRACTION_CONCURRENCY is unset", () => {
    // The module reads the env once at import; in the pure suite it's unset, so the
    // shared limiter uses the documented default.
    if (process.env.AI_EXTRACTION_CONCURRENCY === undefined) {
      expect(extractionSemaphore.maxConcurrency).toBe(
        DEFAULT_EXTRACTION_CONCURRENCY
      );
    } else {
      expect(extractionSemaphore.maxConcurrency).toBeGreaterThanOrEqual(1);
    }
  });
});
