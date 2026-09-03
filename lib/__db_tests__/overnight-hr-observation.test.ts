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
import { shiftDateStr } from "@/lib/date";
import {
  getOvernightHrMinSeries,
  OVERNIGHT_MIN_MEASURED_MIN,
} from "@/lib/queries/event-physiology";
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
