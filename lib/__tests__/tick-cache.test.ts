// PURE TIER — the tick-scoped memo's own contract (#2118, #2111). No DB, no network.
//
// The gathers that use this are covered end-to-end in the DB tier
// (lib/__db_tests__/tick-scoped-gathers.test.ts, which counts their statements). What
// is pinned here is the mechanism the safety argument rests on: outside a scope this
// is a passthrough, inside one it memoizes by declared key, and a scope's entries
// never survive it — not across a sibling scope, and not across a throw.

import { describe, it, expect } from "vitest";
import { inTickScope, runInTickScope, tickCached } from "@/lib/tick-cache";

// A gather stand-in that counts its own evaluations.
function counted() {
  let calls = 0;
  const fn = tickCached(
    "gather",
    (profileId: number, date: string) => `${profileId}:${date}`,
    (profileId: number, date: string) => {
      calls++;
      return `${profileId}@${date}#${calls}`;
    }
  );
  return { fn, calls: () => calls };
}

describe("tickCached — outside a scope", () => {
  it("calls straight through, every time", () => {
    const { fn, calls } = counted();
    expect(fn(1, "2026-08-05")).toBe("1@2026-08-05#1");
    expect(fn(1, "2026-08-05")).toBe("1@2026-08-05#2");
    expect(calls()).toBe(2);
  });

  it("reports no open scope", () => {
    expect(inTickScope()).toBe(false);
  });
});

describe("tickCached — inside a scope", () => {
  it("evaluates once per key and returns the SAME value", async () => {
    const { fn, calls } = counted();
    await runInTickScope(async () => {
      const first = fn(1, "2026-08-05");
      const second = fn(1, "2026-08-05");
      expect(second).toBe(first);
      expect(calls()).toBe(1);
    });
  });

  it("keys on every argument the caller declared", async () => {
    const { fn, calls } = counted();
    await runInTickScope(async () => {
      fn(1, "2026-08-05");
      fn(2, "2026-08-05"); // another profile
      fn(1, "2026-08-06"); // another day
      fn(1, "2026-08-05"); // the first question again
      expect(calls()).toBe(3);
    });
  });

  it("does not collide with another gather's identical key", async () => {
    let a = 0;
    let b = 0;
    const key = (profileId: number) => String(profileId);
    const first = tickCached("first", key, (profileId: number) => {
      a++;
      return `a${profileId}`;
    });
    const second = tickCached("second", key, (profileId: number) => {
      b++;
      return `b${profileId}`;
    });
    await runInTickScope(async () => {
      expect(first(7)).toBe("a7");
      expect(second(7)).toBe("b7");
      expect(a).toBe(1);
      expect(b).toBe(1);
    });
  });

  it("memoizes a falsy or undefined answer instead of recomputing it", async () => {
    let calls = 0;
    const fn = tickCached(
      "empty",
      () => "k",
      () => {
        calls++;
        return undefined;
      }
    );
    await runInTickScope(async () => {
      expect(fn()).toBeUndefined();
      expect(fn()).toBeUndefined();
      expect(calls).toBe(1);
    });
  });
});

describe("a scope's entries never outlive it", () => {
  it("a sibling scope starts empty", async () => {
    const { fn, calls } = counted();
    await runInTickScope(async () => {
      fn(1, "2026-08-05");
      fn(1, "2026-08-05");
    });
    expect(calls()).toBe(1);
    await runInTickScope(async () => {
      fn(1, "2026-08-05");
    });
    expect(calls()).toBe(2);
  });

  it("a throw closes the scope", async () => {
    await expect(
      runInTickScope(async () => {
        expect(inTickScope()).toBe(true);
        throw new Error("profile tick failed");
      })
    ).rejects.toThrow("profile tick failed");
    expect(inTickScope()).toBe(false);
  });

  it("a nested scope restores the OUTER one rather than clearing to none", async () => {
    const { fn, calls } = counted();
    await runInTickScope(async () => {
      fn(1, "2026-08-05");
      await runInTickScope(async () => {
        // Its own scope: the outer memo is not visible here.
        fn(1, "2026-08-05");
        expect(calls()).toBe(2);
      });
      // Back in the outer scope, whose entry survived the inner one.
      fn(1, "2026-08-05");
      expect(calls()).toBe(2);
      expect(inTickScope()).toBe(true);
    });
    expect(inTickScope()).toBe(false);
  });
});
