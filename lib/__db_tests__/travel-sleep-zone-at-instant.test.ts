// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #3428 — a night is rendered in the zone it was SLEPT IN, not the zone the
// profile is standing in now. The pure tier pins `zoneAtInstant` over literals
// (lib/__tests__/travel-timezone.test.ts); this pins the half only a real profile,
// a real settings store and the real sleep readers can show: after one travel
// switch, does the Sleep page still say what it said yesterday about last week?
//
// The prod measurement this reproduces (profile 1, 2026-08-21, New York →
// Los Angeles): the 08-20 night `03:24Z → 09:30Z` rendered bed 8:24 PM → wake
// 2:30 AM instead of 11:24 PM → 5:30 AM, and `typicalWakeTime` — the auto Morning
// intake slot and the sleep-waiting wake anchor — read ~2:40 AM.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone, switchProfileTimezone, getTimezone } from "@/lib/settings";
import {
  getLastNightSummary,
  getSleepConsistency,
  typicalBedTime,
  typicalWakeTime,
} from "@/lib/queries/sleep";
import { lastNightSummary } from "@/lib/sleep-summary";
import { getSleepSessions } from "@/lib/queries/metrics";

const NY = "America/New_York";
const LA = "America/Los_Angeles";

// The switch instant from the prod incident. Every seeded night ends before it.
const SWITCH_INSTANT = "2026-08-21T02:11:41Z";

// One New York night: asleep 23:24 the evening before, awake 05:30 — which in
// August (EDT, UTC−4) is exactly the 03:24Z → 09:30Z window prod recorded.
const NY_BED_MINUTES = 23 * 60 + 24; // 1404
const NY_WAKE_MINUTES = 5 * 60 + 30; // 330
// The same two instants read in Los Angeles (PDT, UTC−7) — three hours early.
const LA_SHIFTED_BED_MINUTES = 20 * 60 + 24; // 1224
const LA_SHIFTED_WAKE_MINUTES = 2 * 60 + 30; // 150

// The one night slept AFTER the move: 23:00 → 06:00 on Los Angeles clocks.
const POST_WAKE_DAY = "2026-08-22";
const POST_BED_MINUTES = 23 * 60; // 1380
const POST_WAKE_MINUTES = 6 * 60; // 360

// Fourteen nights ending 2026-08-20 — the window `typicalWakeTime` needs (its
// minimum-nights gate is 14) and the span the consistency strip draws.
const NIGHTS = 14;
const LAST_NY_WAKE_DAY = "2026-08-20";

function freeze(instant: string): void {
  process.env.ALLOS_TEST_NOW = instant;
}

beforeEach(() => {
  db.exec("DELETE FROM metric_samples");
  freeze(SWITCH_INSTANT);
});

afterEach(() => {
  delete process.env.ALLOS_TEST_NOW;
});

function night(profileId: number, wakeDay: string, startUtc: string, endUtc: string) {
  db.prepare(
    `INSERT INTO metric_samples
       (profile_id, source, origin, metric, date, started_at, ended_at, value)
     VALUES (?, 'health-connect', NULL, 'sleep_min', ?, ?, ?, 366)`
  ).run(profileId, wakeDay, startUtc, endUtc);
}

// A profile that slept `NIGHTS` New York nights and then flew west. `post` adds the
// one night slept on the far side of the switch.
function traveller(name: string, opts: { post?: boolean } = {}): number {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(profileId, NY);
  for (let i = NIGHTS - 1; i >= 0; i -= 1) {
    const wakeDay = shiftDateStr(LAST_NY_WAKE_DAY, -i);
    night(profileId, wakeDay, `${wakeDay}T03:24:00Z`, `${wakeDay}T09:30:00Z`);
  }
  switchProfileTimezone(profileId, LA, NY);
  if (opts.post) {
    night(
      profileId,
      POST_WAKE_DAY,
      `${POST_WAKE_DAY}T06:00:00Z`,
      `${POST_WAKE_DAY}T13:00:00Z`
    );
  }
  return profileId;
}

describe("a night keeps the clock it was slept on after a travel switch (#3428)", () => {
  it("last night, with only pre-switch nights recorded, still reads New York", () => {
    const profileId = traveller("TZ-SLEEP-PRE");
    expect(getTimezone(profileId)).toBe(LA);

    const summary = getLastNightSummary(profileId);
    expect(summary?.wakeDay).toBe(LAST_NY_WAKE_DAY);
    expect(summary?.bedMinutes).toBe(NY_BED_MINUTES);
    expect(summary?.wakeMinutes).toBe(NY_WAKE_MINUTES);

    // POSITIVE CONTROL, through the same pure function the reader calls: hand it the
    // profile's CURRENT zone — what every caller passed before this change — and the
    // identical rows produce the three-hours-early pair prod showed. Without this the
    // assertion above would also pass on a tree where nothing resolves per-instant
    // and the profile simply never left New York.
    const shifted = lastNightSummary(
      getSleepSessions(profileId),
      getTimezone(profileId)
    );
    expect(shifted?.bedMinutes).toBe(LA_SHIFTED_BED_MINUTES);
    expect(shifted?.wakeMinutes).toBe(LA_SHIFTED_WAKE_MINUTES);
  });

  it("the night slept after the move reads Los Angeles", () => {
    const profileId = traveller("TZ-SLEEP-POST", { post: true });
    const summary = getLastNightSummary(profileId);
    expect(summary?.wakeDay).toBe(POST_WAKE_DAY);
    expect(summary?.bedMinutes).toBe(POST_BED_MINUTES);
    expect(summary?.wakeMinutes).toBe(POST_WAKE_MINUTES);
  });

  // The wake time is not only a label: it is the auto Morning intake slot and the
  // sleep-waiting wake anchor, so a three-hour error here asks for a morning dose in
  // the middle of the night.
  it.each([
    { name: "typical wake time", read: typicalWakeTime, expected: NY_WAKE_MINUTES },
    { name: "typical bed time", read: typicalBedTime, expected: NY_BED_MINUTES },
  ])("$name is the median of the New York nights, not their Los Angeles shadow", ({
    read,
    expected,
  }) => {
    const profileId = traveller("TZ-SLEEP-TYPICAL");
    expect(read(profileId)).toBe(expected);
  });

  it("every night on the consistency strip keeps its own zone's hours", () => {
    const profileId = traveller("TZ-SLEEP-STRIP", { post: true });
    const strip = getSleepConsistency(profileId);
    expect(strip).toHaveLength(NIGHTS + 1);

    // Wake is unwrapped forward of bed, so a 05:30 wake after a 23:24 bed reads 29.5.
    for (const row of strip.slice(0, NIGHTS)) {
      expect(row.bedHour).toBeCloseTo(NY_BED_MINUTES / 60, 5);
      expect(row.wakeHour).toBeCloseTo(24 + NY_WAKE_MINUTES / 60, 5);
    }
    const post = strip.at(-1)!;
    expect(post.date).toBe(POST_WAKE_DAY);
    expect(post.bedHour).toBeCloseTo(POST_BED_MINUTES / 60, 5);
    expect(post.wakeHour).toBeCloseTo(24 + POST_WAKE_MINUTES / 60, 5);
  });

  // The overwhelming case, and the one that must not move: a profile that has never
  // switched has no history, so `profileDayZone` hands back a plain zone name and the
  // readers do exactly what they did before.
  it("a profile that never travelled is unchanged", () => {
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('TZ-SLEEP-HOME')").run()
        .lastInsertRowid
    );
    setTimezone(profileId, NY);
    for (let i = NIGHTS - 1; i >= 0; i -= 1) {
      const wakeDay = shiftDateStr(LAST_NY_WAKE_DAY, -i);
      night(profileId, wakeDay, `${wakeDay}T03:24:00Z`, `${wakeDay}T09:30:00Z`);
    }
    const summary = getLastNightSummary(profileId);
    expect(summary?.bedMinutes).toBe(NY_BED_MINUTES);
    expect(summary?.wakeMinutes).toBe(NY_WAKE_MINUTES);
    expect(typicalWakeTime(profileId)).toBe(NY_WAKE_MINUTES);
  });
});
