// DB INTEGRATION TIER — the tier-wide clock freeze itself (#4509).
//
// This file asserts the property every other spec in these two tiers now leans on
// without saying so, which is exactly why it needs saying somewhere. The positive
// control for the freeze living in ./frozen-clock.ts is lib/__db_tests__/boot-lock-race.test.ts:
// it measures REAL elapsed wall time, it is the one file that opts out, and it fails
// ("expected 0 to be greater than or equal to 333.3") the moment the opt-out is removed.

import { describe, it, expect, vi } from "vitest";
import { now, sqlNow } from "@/lib/clock";
import { today } from "@/lib/db";
import {
  FROZEN_WALL_TIME_UTC,
  frozenInstantForDay,
  tierFrozenInstant,
} from "./frozen-clock";

const FROZEN = tierFrozenInstant();

describe("the db/action tiers freeze the clock (#4509)", () => {
  // The seam and raw Date are the two conventions the tree had, and the whole point
  // of freezing with a fake Date rather than with ALLOS_TEST_NOW is that they now
  // give one answer instead of two.
  it.each([
    ["clock.now()", () => now().getTime()],
    ["new Date()", () => new Date().getTime()],
    ["Date.now()", () => Date.now()],
  ])("%s reads the tier's frozen instant", (_label, read) => {
    expect(read()).toBe(FROZEN.getTime());
  });

  it("does not advance while a test runs", async () => {
    const before = now().getTime();
    // Real timers, so this genuinely waits — the clock is what is fake, not setTimeout.
    const waited = await new Promise<number>((resolve) => {
      const t0 = performance.now();
      setTimeout(() => resolve(performance.now() - t0), 20);
    });
    expect(waited).toBeGreaterThan(0);
    expect(now().getTime()).toBe(before);
  });

  it("is late on its own UTC day, so a wall time stated for today has happened", () => {
    expect(now().toISOString()).toBe(
      `${now().toISOString().slice(0, 10)}T${FROZEN_WALL_TIME_UTC}`
    );
    // The seam's two write shapes agree with it, and a UTC profile's day is the
    // frozen day rather than whatever the real calendar has reached.
    expect(sqlNow()).toBe(now().toISOString().slice(0, 19).replace("T", " "));
    expect(today()).toBe(now().toISOString().slice(0, 10));
  });

  it("keeps a per-test setSystemTime working, and restores the tier instant after", () => {
    vi.setSystemTime(new Date("2026-06-17T08:00:00.000Z"));
    expect(now().toISOString()).toBe("2026-06-17T08:00:00.000Z");
    // No cleanup here on purpose: the tier's own beforeEach is what puts it back,
    // which is the property a spec that moves the clock in one test depends on.
  });

  it("put the tier instant back after the test above moved it", () => {
    expect(now().getTime()).toBe(FROZEN.getTime());
  });

  it("derives the default instant from a day rather than from a fixed date", () => {
    expect(frozenInstantForDay("2026-12-31").toISOString()).toBe(
      `2026-12-31T${FROZEN_WALL_TIME_UTC}`
    );
  });
});
