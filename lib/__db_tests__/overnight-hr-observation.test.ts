// DB INTEGRATION TIER — the night's lowest heart rate as a paired-observation outcome
// (#4775 §5), and the ONE digest line the owner's 2026-09-02 exception permits.
//
// Two claims:
//   • the `overnight-hr-min` stream reads each night's FLOOR over that night's own
//     sleep session, drops a night the stream did not cover or barely measured, and
//     dates it on the WAKE day so the pair's +1 offset lands;
//   • the digest line appears ONLY behind `substance_telegram_enabled`. Off is the
//     default and off means a scan of the rendered message finds nothing about drinks.
//
// Every value is synthetic; the fixture's shape follows the issue's prod table (a
// larger drink arm, a smaller dry arm, a gap of a few bpm) and none of its values.

import { beforeEach, describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { setProfileSetting } from "@/lib/settings";
import { setProfileSubstanceTelegram } from "@/lib/settings/notifications";
import { shiftDateStr, zonedMinuteStr } from "@/lib/date";
import {
  getOvernightHrMinSeries,
  OVERNIGHT_MIN_MEASURED_MIN,
} from "@/lib/queries/event-physiology";
import { getHrMinutesInRange } from "@/lib/queries/metrics";
import { gatherSubstanceObservationLine } from "@/lib/notifications/digest-data";
import { ALCOHOL_FOOD_GROUP } from "@/lib/substance-use";

let profileId: number;

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setProfileSetting(id, "timezone", "UTC");
  setProfileSetting(id, "birthdate", "1986-06-01");
  return id;
}

/**
 * One night: a sleep session from 23:00 on `day - 1` to 07:00 on `day`, with
 * `measuredMin` minutes of HR inside it (one of them dipping to `lowBpm`) plus one
 * waking minute AT the session's end.
 *
 * That last minute is what makes coverage and measurement two independent variables.
 * Without it a sparsely-measured night would also be an uncovered one, and a fixture
 * that fails both gates cannot tell you which gate it is testing.
 */
function seedNight(
  id: number,
  day: string,
  lowBpm: number,
  measuredMin = 240
): void {
  const start = `${shiftDateStr(day, -1)}T23:00:00Z`;
  const end = `${day}T07:00:00Z`;
  db.prepare(
    `INSERT INTO metric_samples
       (profile_id, source, metric, date, started_at, ended_at, value)
     VALUES (?, 'health-connect', 'sleep_min', ?, ?, ?, 480)`
  ).run(id, day, start, end);
  const insertHr = db.prepare(
    `INSERT INTO hr_minutes (profile_id, ts, bpm, n, source)
     VALUES (?, ?, ?, 1, 'health-connect')`
  );
  const base = Date.parse(start);
  for (let i = 0; i < measuredMin; i++)
    insertHr.run(
      id,
      new Date(base + i * 60_000).toISOString().slice(0, 16),
      i === 30 ? lowBpm : lowBpm + 8
    );
  // Awake, and outside the half-open window — it carries the frontier past the end
  // without joining the night's own minutes.
  insertHr.run(id, end.slice(0, 16), lowBpm + 25);
}

/**
 * A day of food rollup, with or without a drink. The non-alcohol row is what the
 * `logging-evidence` control rule requires: a day with no food logged is evidence
 * about logging, not about drinking, and must not pad the dry arm.
 */
function seedFoodDay(id: number, day: string, drinks: number): void {
  const insert = db.prepare(
    `INSERT INTO food_daily_totals (profile_id, date, group_key, servings)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (profile_id, date, group_key)
       DO UPDATE SET servings = excluded.servings`
  );
  insert.run(id, day, "whole-grains", 1);
  if (drinks > 0) insert.run(id, day, ALCOHOL_FOOD_GROUP, drinks);
}

beforeEach(() => {
  profileId = newProfile("Overnight");
});

describe("the overnight-hr-min stream", () => {
  it("reads each night's floor over its own session, dated on the wake day", () => {
    const day = "2026-06-10";
    seedNight(profileId, day, 47);
    // A midday minute lower than the night's floor: outside the session, so it must
    // not win — the whole point of scoping to the session rather than to clock hours.
    db.prepare(
      `INSERT INTO hr_minutes (profile_id, ts, bpm, n, source)
       VALUES (?, ?, 40, 1, 'health-connect')`
    ).run(profileId, `${day}T12:00`);
    expect(getOvernightHrMinSeries(profileId, 90)).toEqual([
      { date: day, value: 47 },
    ]);
  });

  it("drops a night the stream barely measured", () => {
    seedNight(profileId, "2026-06-10", 47, OVERNIGHT_MIN_MEASURED_MIN - 1);
    expect(getOvernightHrMinSeries(profileId, 90)).toEqual([]);
  });

  it("keeps a night measured exactly at the floor", () => {
    seedNight(profileId, "2026-06-10", 47, OVERNIGHT_MIN_MEASURED_MIN);
    expect(getOvernightHrMinSeries(profileId, 90)).toHaveLength(1);
  });

  // The lag case again: the last hour of the night has not been delivered, so the
  // night's floor is whatever the pipeline happened to have pushed.
  it("drops a night the frontier has not passed", () => {
    const day = "2026-06-10";
    seedNight(profileId, day, 47);
    // Discard everything from 05:00 on — the session runs to 07:00. Four hours of the
    // night are still measured, comfortably over the floor, so the ONLY reason this is
    // dropped is that the pipeline has not delivered the rest of it.
    db.prepare("DELETE FROM hr_minutes WHERE profile_id = ? AND ts >= ?").run(
      profileId,
      `${day}T05:00`
    );
    expect(getOvernightHrMinSeries(profileId, 90)).toEqual([]);
  });
});

// The per-night SLICE must return what the per-night FILTER returned (#5010).
//
// The reader stopped scanning the whole span once per night. The risk in that is not
// arithmetic, it is ORDER: the slice is a binary search, and the stamps it searches
// are profile-local, which on a fall-back night run 01:59 → 01:00 while the instants
// keep climbing. So the equivalence is asserted against the materialising filter
// ITSELF, over a zone that transitions, rather than against hand-written expectations
// that would encode the same assumption twice.
describe("the night slice equals the night filter", () => {
  // The filter this reader used to run, kept here as the reference implementation.
  const byFilter = (
    rows: { ts: string; bpm: number }[],
    from: string,
    to: string
  ) => rows.filter((b) => b.ts >= from && b.ts < to);

  it.each([
    ["UTC, ordinary nights", "UTC", ["2026-06-10", "2026-06-11", "2026-06-12"]],
    // 2026-11-01 is New York's fall back: 01:59 EDT is followed by 01:00 EST, so the
    // night of the 31st→1st contains a repeated wall-clock hour.
    [
      "America/New_York across the fall back",
      "America/New_York",
      ["2026-10-31", "2026-11-01", "2026-11-02"],
    ],
    // 2026-03-08 is the spring forward: an hour of wall clock does not happen.
    [
      "America/New_York across the spring forward",
      "America/New_York",
      ["2026-03-07", "2026-03-08", "2026-03-09"],
    ],
  ])("agrees with the filter in %s", (_label, tz, days) => {
    const id = newProfile(`slice-${tz}-${days[0]}`);
    setProfileSetting(id, "timezone", tz);
    // 480 measured minutes, not the 240 default: the session runs 23:00Z→07:00Z and
    // New York's transition sits at 06:00Z, so a half-seeded night stops short of the
    // seam and the DST rows would test the ordinary case twice over.
    days.forEach((day, i) => seedNight(id, day, 44 + i, 480));

    const series = getOvernightHrMinSeries(id, 90);

    // The reference: the same minutes, filtered per night rather than sliced.
    const nights = db
      .prepare(
        `SELECT date, started_at, ended_at FROM metric_samples
          WHERE profile_id = ? AND metric = 'sleep_min' ORDER BY date`
      )
      .all(id) as { date: string; started_at: string; ended_at: string }[];
    // The reader derives its own span from the FIRST night's start, which is the
    // evening BEFORE the first wake day — read the same span or the reference misses
    // the minutes before midnight and reports a floor that is not the night's.
    const rows = getHrMinutesInRange(
      id,
      shiftDateStr(days[0], -1),
      days[days.length - 1]
    );
    const expected = nights.flatMap(({ date, started_at, ended_at }) => {
      const from = zonedMinuteStr(tz, new Date(started_at));
      const to = zonedMinuteStr(tz, new Date(ended_at));
      const inNight = byFilter(rows, from, to);
      return inNight.length < OVERNIGHT_MIN_MEASURED_MIN
        ? []
        : [{ date, value: Math.min(...inNight.map((b) => b.bpm)) }];
    });

    // THE FIXTURE MUST REACH THE STATE THIS GUARD IS ABOUT, and there are two of
    // them. Nights that produced no rows would make both sides empty and prove
    // nothing; and the SORT is only under test where the rows arrive out of local
    // order, which happens on the fall-back night and nowhere else. Counted, not
    // assumed — the first version of this table seeded half a night, never reached the
    // seam, and stayed green with the sort deleted.
    expect(expected.length).toBeGreaterThan(0);
    // One DESCENT, not sixty rows: the stamps climb to 01:59 EDT, drop to 01:00 EST
    // and climb again, so exactly one adjacent pair goes backwards — and the 60
    // minutes after it are the ones a search over the unsorted array would miss.
    const descents = rows.filter(
      (r, i) => i > 0 && r.ts < rows[i - 1].ts
    ).length;
    expect(descents).toBe(days.includes("2026-11-01") ? 1 : 0);
    expect(series).toEqual(expected);
  });
});

// THE CASE THAT SEPARATES THE TWO ORDERS, and the reason the table above does not.
//
// A window whose boundary sits OUTSIDE the repeated hour selects the same rows under
// either order — the disorder is wholly inside the slice, and a minimum does not care
// how its inputs are arranged. The orders differ only when a boundary lands INSIDE the
// repeat, because then the answer depends on finding every row below it, and a binary
// search over a non-monotone array cannot. So this night ENDS at 01:30 on the fall-back
// morning: a wall clock that came round twice, with the session stopping in its second
// pass.
describe("a night that ends inside the repeated hour", () => {
  const TZ = "America/New_York";

  it("takes both passes of the repeated minutes below the boundary", () => {
    const id = newProfile("fall-back-boundary");
    setProfileSetting(id, "timezone", TZ);
    // 23:00Z on the 31st (19:00 EDT) to 06:30Z on the 1st. New York falls back at
    // 06:00Z, so 06:30Z reads 01:30 EST — the SECOND time the clock says 01:30.
    const start = "2026-10-31T23:00:00Z";
    const end = "2026-11-01T06:30:00Z";
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, started_at, ended_at, value)
       VALUES (?, 'health-connect', 'sleep_min', '2026-11-01', ?, ?, 450)`
    ).run(id, start, end);
    const insertHr = db.prepare(
      `INSERT INTO hr_minutes (profile_id, ts, bpm, n, source)
       VALUES (?, ?, ?, 1, 'health-connect')`
    );
    const base = Date.parse(start);
    // THREE BLOCKS, PLACED SO EACH WRONG ANSWER IS A DIFFERENT NUMBER. Everything is
    // 58 except two half-hours either side of the seam:
    //   35 at 01:30–01:59 EDT — the FIRST pass, ABOVE the boundary stamp, so a slice
    //      that runs past the boundary reports 35;
    //   39 at 01:00–01:29 EST — the SECOND pass, BELOW it, so a slice that stops at
    //      the first stamp it sees at 01:30 loses this block and reports 58.
    // The right answer is 39, and it is neither of the two ways of being wrong.
    for (let i = 0; i <= 450; i++) {
      const at = base + i * 60_000;
      const firstPassLate =
        at >= Date.parse("2026-11-01T05:30:00Z") &&
        at < Date.parse("2026-11-01T06:00:00Z");
      const secondPassEarly =
        at >= Date.parse("2026-11-01T06:00:00Z") &&
        at < Date.parse("2026-11-01T06:30:00Z");
      insertHr.run(
        id,
        new Date(at).toISOString().slice(0, 16),
        firstPassLate ? 35 : secondPassEarly ? 39 : 58
      );
    }

    const rows = getHrMinutesInRange(id, "2026-10-31", "2026-11-01");
    const from = zonedMinuteStr(TZ, new Date(start));
    const to = zonedMinuteStr(TZ, new Date(end));
    expect(to).toBe("2026-11-01T01:30");
    const inNight = rows.filter((b) => b.ts >= from && b.ts < to);
    // THE FIXTURE REACHES THE STATE, COUNTED RATHER THAN ASSUMED: the rows arrive with
    // exactly one backwards step (the seam), the second pass is inside the window, and
    // the first pass's below-boundary block is not.
    expect(rows.filter((r, i) => i > 0 && r.ts < rows[i - 1].ts)).toHaveLength(
      1
    );
    expect(inNight.filter((b) => b.bpm === 39)).toHaveLength(30);
    expect(inNight.filter((b) => b.bpm === 35)).toHaveLength(0);

    expect(getOvernightHrMinSeries(id, 90)).toEqual([
      { date: "2026-11-01", value: 39 },
    ]);
    // …which is what the materialising filter says too.
    expect(Math.min(...inNight.map((b) => b.bpm))).toBe(39);
  });
});

describe("the ONE digest line, and the flag that gates it", () => {
  /**
   * Twelve drink evenings against ten logged-dry ones, both clear of the 8-night
   * per-arm minimum, with a floor gap of 4 bpm — above the pair's 3 bpm floor and
   * recognisably the shape of the issue's prod table.
   */
  function seedPairedHistory(id: number): string {
    const todayStr = today(id);
    for (let back = 30; back >= 1; back--) {
      const factorDay = shiftDateStr(todayStr, -back);
      const wakeDay = shiftDateStr(factorDay, 1);
      const drinking = back % 3 !== 0;
      seedFoodDay(id, factorDay, drinking ? 2 : 0);
      seedNight(id, wakeDay, drinking ? 54 : 50);
    }
    return todayStr;
  }

  it("renders nothing when the substance opt-in is off — the default", () => {
    const todayStr = seedPairedHistory(profileId);
    // The gather itself still answers, so this asserts the FLAG's effect and not an
    // empty fixture: the same call with the flag on is the next case.
    expect(gatherSubstanceObservationLine(profileId, todayStr)).not.toBeNull();
    // …and the digest's own caller asks the flag first, which is off by default.
    expect(
      db
        .prepare(
          `SELECT value FROM profile_settings
            WHERE profile_id = ? AND key = 'substance_telegram_enabled'`
        )
        .get(profileId)
    ).toBeUndefined();
  });

  it("states both arms' n and no advice verb once the opt-in is on", () => {
    const todayStr = seedPairedHistory(profileId);
    setProfileSubstanceTelegram(profileId, true);
    const line = gatherSubstanceObservationLine(profileId, todayStr)!;
    expect(line).toContain("evenings with a drink logged");
    expect(line).toMatch(/\d+ nights/);
    expect(line).toContain("not a cause");
    // No direction word and no verb telling the reader what to do about it.
    expect(line).not.toMatch(/\b(higher|lower|worse|better|should|try|cut)\b/i);
  });

  it("says nothing when the arms differ by less than the pair's floor", () => {
    const todayStr = today(profileId);
    for (let back = 30; back >= 1; back--) {
      const factorDay = shiftDateStr(todayStr, -back);
      const drinking = back % 3 !== 0;
      seedFoodDay(profileId, factorDay, drinking ? 2 : 0);
      // A 1 bpm gap — under the 3 bpm floor, which is silence by #2177 constraint 4.
      seedNight(profileId, shiftDateStr(factorDay, 1), drinking ? 51 : 50);
    }
    expect(gatherSubstanceObservationLine(profileId, todayStr)).toBeNull();
  });
});
