// DB INTEGRATION TIER — the tier-wide clock freeze itself (#4509).
//
// This file asserts the property every other spec in these two tiers now leans on
// without saying so, which is exactly why it needs saying somewhere. The positive
// control for the freeze living in ./frozen-clock.ts is lib/__db_tests__/boot-lock-race.test.ts:
// it measures REAL elapsed wall time, it is the one file that opts out, and it fails
// ("expected 0 to be greater than or equal to 333.3") the moment the opt-out is removed.

import { describe, it, expect, vi } from "vitest";
import { now, sqlNow } from "@/lib/clock";
import { STATED_FUTURE_SKEW_MS } from "@/lib/stated-time";
import { db, today } from "@/lib/db";
import {
  FROZEN_WALL_TIME_UTC,
  frozenInstantForDay,
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

// WHERE THE WALL TIME IS ALLOWED TO SIT (#4837), and why it is not a free choice.
// The fake Date does not advance and SQLite's `datetime('now')` does, so the freeze
// leads SQL by L = W - r for a wall time W and a real time-of-day r, both as ms after
// midnight. Two assertions in auth.test.ts pin L from opposite sides, and because L is
// largest at midnight and smallest at the end of the day, the headroom above and the
// red window below are THE SAME NUMBER, 86_400_000 - W. These fail when a change to
// the constant crosses either edge, and say which edge and what the interval is —
// crossing one is the thing the next person needs to meet, not a symptom to chase.
const LEAD_CAP_MS = 24 * 60 * 60 * 1000;
// The band the one quantity may sit in. Its FLOOR is the stated-time skew plus room to
// express a statement past it: a spec exercising a REFUSED future time must be able to
// name one later than the frozen now, past the skew, and still on the frozen day
// (bristol-stool-write.test.ts). Below this the "future" verdict is unreachable and
// that fixture goes quietly green on the wrong thing — which is why an endpoint like
// 23:59:59.999 is refused rather than admired, before its 1 ms of cap headroom is even
// argued about. Its CEILING is nightly red: 23:45 spent 900_000 ms here, the defect.
const MIN_HEADROOM_MS = STATED_FUTURE_SKEW_MS + 60_000;
const MAX_RESIDUAL_MS = 720_000;
const WALL_MS = Date.parse(`1970-01-01T${FROZEN_WALL_TIME_UTC}`);

const INTERVAL =
  `FROZEN_WALL_TIME_UTC = ${FROZEN_WALL_TIME_UTC} is ${WALL_MS} ms after midnight. ` +
  `The cap is ${LEAD_CAP_MS} ms: auth.test.ts:326 allows 29 of a 30-day TTL while ` +
  `reading Date.now() off this clock, and a run starting at midnight leads SQLite by ` +
  `the whole wall time. auth.test.ts:346 needs that lead POSITIVE, so the day's last ` +
  `${LEAD_CAP_MS} - W ms are red. Headroom under the cap and nightly red are the SAME ` +
  `number, so moving this constant spends one to buy the other; it must land between ` +
  `${MIN_HEADROOM_MS} and ${MAX_RESIDUAL_MS} ms of the cap. See the interval ` +
  `arithmetic in frozen-clock.ts.`;

describe("the wall time sits inside the interval auth.test.ts leaves it (#4837)", () => {
  it("clears the lead cap by enough to survive an edit near it", () => {
    expect(LEAD_CAP_MS - WALL_MS, INTERVAL).toBeGreaterThanOrEqual(
      MIN_HEADROOM_MS
    );
  });

  it("spends no more than the budget on nightly red", () => {
    expect(LEAD_CAP_MS - WALL_MS, INTERVAL).toBeLessThanOrEqual(
      MAX_RESIDUAL_MS
    );
  });

  // And the instant THIS run froze at is inside both bounds, against the clock it
  // actually has to beat. Measured with SQLite rather than `Date.now()`, which this
  // tier fakes to the frozen instant itself and would compare it to itself:
  // `datetime('now')` is the unreachable real clock the whole invariant is about.
  it("holds for the instant this run actually froze at", () => {
    const sqlRealNow = Date.parse(
      (
        db.prepare("SELECT datetime('now') AS t").get() as { t: string }
      ).t.replace(" ", "T") + "Z"
    );
    const lead = TIER_FROZEN_INSTANT.getTime() - sqlRealNow;
    expect(
      lead,
      `The freeze is BEHIND SQLite by ${-lead} ms, so every JS-seeded expiry judged ` +
        `against a SQL timestamp in this tier is wrong by that much. This is the ` +
        `accepted residual — the last ${LEAD_CAP_MS - WALL_MS} ms of the UTC day, ` +
        `plus however long this run took to get here. ${INTERVAL}`
    ).toBeGreaterThan(0);
    expect(lead, INTERVAL).toBeLessThan(LEAD_CAP_MS);
  });
});
