// DB INTEGRATION TIER — the tier-wide clock freeze itself (#4509).
//
// This file asserts the property every other spec in these two tiers now leans on
// without saying so, which is exactly why it needs saying somewhere. The positive
// control for the freeze living in ./frozen-clock.ts is lib/__db_tests__/boot-lock-race.test.ts:
// it measures REAL elapsed wall time, it is the one file that opts out, and it fails
// ("expected 0 to be greater than or equal to 333.3") the moment the opt-out is removed.

import { describe, it, expect, vi } from "vitest";
import { now, sqlNow } from "@/lib/clock";
import { db, today } from "@/lib/db";
import {
  FROZEN_WALL_TIME_UTC,
  frozenInstantForDay,
  frozenInstantFrom,
  MIN_LEAD_OVER_REAL_CLOCK_MS,
  TIER_FROZEN_INSTANT,
} from "./frozen-clock";

const FROZEN = TIER_FROZEN_INSTANT;

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
    // The seam's write shape agrees with it, and a profile's day — read through the
    // app's own reader, on the instance-default UTC timezone — is the frozen day.
    expect(sqlNow()).toBe(now().toISOString().slice(0, 19).replace("T", " "));
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('Frozen Clock')").run()
        .lastInsertRowid
    );
    expect(today(profileId)).toBe(now().toISOString().slice(0, 10));
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

// THE FROZEN INSTANT MUST LEAD SQLITE'S CLOCK (#4837). The fake Date does not
// advance and `datetime('now')` does, so a JS-seeded expiry judged against a SQL
// timestamp is only correct while the frozen instant is AHEAD. Before this, the day
// came from the real clock unconditionally, which put the instant up to 15 minutes
// BEHIND it every night after 23:45 — `auth.test.ts:346` tolerates 1000 ms and went
// red on four PRs at once. These drive the choice with an injected real clock, so
// the window is reachable at any hour rather than only between 23:45 and midnight.
describe("the frozen instant leads the real clock (#4837)", () => {
  it.each([
    [
      "mid-morning, nowhere near the wall time",
      "2026-09-02T09:00:00.000Z",
      "2026-09-02",
    ],
    ["an hour and a half before it", "2026-09-02T22:15:00.000Z", "2026-09-02"],
    [
      "inside the lead margin, before the wall time",
      "2026-09-02T23:00:00.000Z",
      "2026-09-03",
    ],
    [
      "one second past it — the first red minute",
      "2026-09-02T23:45:01.000Z",
      "2026-09-03",
    ],
    [
      "the 23:49 the tier actually failed at",
      "2026-09-02T23:49:27.000Z",
      "2026-09-03",
    ],
    [
      "the last millisecond of the day",
      "2026-09-02T23:59:59.999Z",
      "2026-09-03",
    ],
    ["month end rolls the month", "2026-09-30T23:50:00.000Z", "2026-10-01"],
    ["year end rolls the year", "2026-12-31T23:50:00.000Z", "2027-01-01"],
  ])("%s freezes on %s", (_label, realNow, day) => {
    expect(frozenInstantFrom(new Date(realNow)).toISOString()).toBe(
      `${day}T${FROZEN_WALL_TIME_UTC}`
    );
  });

  // The property the table's rows are examples of, over a whole UTC day at the
  // resolution the defect appears at. The minimum is asserted rather than each
  // reading, so a failure prints the worst lead — which is the number that says how
  // long SQLite's clock had to overtake the freeze.
  it("never freezes at an instant SQLite's clock can reach mid-run", () => {
    const leads = Array.from({ length: 24 * 60 }, (_, minute) => {
      const realNow = new Date(Date.UTC(2026, 8, 2, 0, minute));
      return frozenInstantFrom(realNow).getTime() - realNow.getTime();
    });
    expect(Math.min(...leads)).toBeGreaterThanOrEqual(
      MIN_LEAD_OVER_REAL_CLOCK_MS
    );
  });

  // The margin is only worth stating if it is bigger than the run it has to survive:
  // 862 s is the tier's worst measured wall time (vitest.timeouts.ts).
  it("keeps a margin larger than the tier's own worst measured wall time", () => {
    expect(MIN_LEAD_OVER_REAL_CLOCK_MS).toBeGreaterThan(862_000);
  });

  // And the instant THIS run froze at leads the clock it actually has to beat.
  // Measured against SQLite rather than against `Date.now()`, which this tier fakes
  // to the frozen instant itself and which would therefore compare it to itself:
  // `datetime('now')` is the unreachable real clock the whole invariant is about.
  it("holds for the instant this run actually froze at", () => {
    const sqlRealNow = Date.parse(
      (
        db.prepare("SELECT datetime('now') AS t").get() as { t: string }
      ).t.replace(" ", "T") + "Z"
    );
    expect(TIER_FROZEN_INSTANT.getTime() - sqlRealNow).toBeGreaterThanOrEqual(
      MIN_LEAD_OVER_REAL_CLOCK_MS
    );
  });
});
