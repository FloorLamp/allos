// DB INTEGRATION TIER — the one event-window physiology computation reaches BOTH the
// page and the sends (#4775 §1, the #221 invariant).
//
// The claim under test is not "the numbers are right" (the pure tier owns that). It is
// that there is ONE computation: the activity page's heart-rate block and the send
// gather answer from the same read of the same fixture, and the page's zone minutes
// are byte-identical to what the inline assembly produced before the extraction. A
// "shared" module with two implementations behind it is worse than the duplication it
// replaced, so the pin is on the identity, not on a plausible-looking number.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getActivityDetailData } from "@/lib/training-activity-detail";
import {
  getEventPhysiology,
  getHrFrontierLocal,
  restingCeilingBpm,
} from "@/lib/queries/event-physiology";
import { getHrMinutesInRange, getProfileZoneModel } from "@/lib/queries";
import { scopeBucketsToWindows, zoneMinuteTotals } from "@/lib/training-zones";
import type { UnitPrefs } from "@/lib/settings";

const UNITS: UnitPrefs = {
  weightUnit: "kg",
  distanceUnit: "km",
  temperatureUnit: "F",
};

const DAY = "2026-06-10";
const WINDOW = { start: `${DAY}T08:00`, end: `${DAY}T08:30` };

let profileId: number;
let activityId: number;

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Physiology')").run()
      .lastInsertRowid
  );
  // UTC keeps the fixture's local minute stamps equal to its stored ones, so a wrong
  // number here can only come from the assembly and never from the zone.
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', 'UTC')`
  ).run(profileId);
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value)
     VALUES (?, 'birthdate', '1986-06-01')`
  ).run(profileId);
  // Three resting-HR days: a baseline with a real spread, so the recovery ceiling is
  // the same quantity `rest-rhr` reads rather than a bare constant.
  const bm = db.prepare(
    `INSERT INTO body_metrics (profile_id, date, resting_hr, source)
     VALUES (?, ?, ?, 'manual')`
  );
  bm.run(profileId, "2026-06-07", 52);
  bm.run(profileId, "2026-06-08", 54);
  bm.run(profileId, "2026-06-09", 53);

  activityId = Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, start_time, end_time, duration_min)
         VALUES (?, ?, 'strength', 'Barbell session', '08:00', '08:30', 30)`
      )
      .run(profileId, DAY).lastInsertRowid
  );

  const insertHr = db.prepare(
    `INSERT INTO hr_minutes (profile_id, ts, bpm, n, source)
     VALUES (?, ?, ?, 1, 'health-connect')`
  );
  // Pre-window band: the ten minutes before 08:00 the baseline averages over.
  for (let i = 10; i >= 1; i--)
    insertHr.run(profileId, minuteBefore(WINDOW.start, i), 60);
  // In-window: thirty minutes climbing 110 → 168.
  for (let i = 0; i < 30; i++)
    insertHr.run(profileId, minuteAfter(WINDOW.start, i), 110 + i * 2);
  // After: elevated for eight minutes, then back inside the resting range.
  for (let i = 0; i < 8; i++)
    insertHr.run(profileId, minuteAfter(WINDOW.end, i), 95);
  for (let i = 8; i < 20; i++)
    insertHr.run(profileId, minuteAfter(WINDOW.end, i), 51);
});

function minuteAfter(stamp: string, add: number): string {
  const base = Date.parse(`${stamp}:00Z`);
  return new Date(base + add * 60_000).toISOString().slice(0, 16);
}
function minuteBefore(stamp: string, back: number): string {
  return minuteAfter(stamp, -back);
}

describe("one computation, two consumers", () => {
  it("gives the page the same in-window minutes and zone split as the send gather", () => {
    const detail = getActivityDetailData(profileId, activityId, UNITS);
    const send = getEventPhysiology(profileId, {
      date: DAY,
      start_time: "08:00",
      end_time: "08:30",
      duration_min: 30,
    });
    expect(detail).not.toBeNull();
    expect(send).not.toBeNull();
    expect(detail!.heartRate.window).toEqual(WINDOW);
    expect(detail!.heartRate.minutes).toEqual(send!.minutes);
    expect(detail!.heartRate.zoneMinutes).toEqual(send!.zoneMinutes);
  });

  // BYTE-IDENTICAL, against the assembly the page carried inline before #4775 rather
  // than against a number typed into this file: the two are recomputed here from the
  // same primitives the old block called, in the same order.
  it("renders the pre-extraction zone minutes exactly", () => {
    const zoneModel = getProfileZoneModel(profileId);
    const preExtraction = scopeBucketsToWindows(
      getHrMinutesInRange(profileId, DAY, "2026-06-11"),
      [WINDOW]
    ).sort((a, b) => a.ts.localeCompare(b.ts));
    const detail = getActivityDetailData(profileId, activityId, UNITS)!;
    expect(detail.heartRate.minutes).toEqual(preExtraction);
    expect(detail.heartRate.zoneMinutes).toEqual(
      zoneMinuteTotals(preExtraction, zoneModel!)
    );
    // The fixture's own arithmetic, so a silent widening of the window is visible.
    expect(detail.heartRate.minutes).toHaveLength(30);
    expect(detail.heartRate.zoneMinutes!.reduce((a, b) => a + b, 0)).toBe(30);
  });

  it("gives the page the two facts the extraction added", () => {
    const detail = getActivityDetailData(profileId, activityId, UNITS)!;
    expect(detail.heartRate.preWindowMeanBpm).toBe(60);
    expect(detail.heartRate.recoveryMin).toBe(8);
  });
});

describe("the reads the coverage gate rests on", () => {
  it("reads the frontier as the newest local HR minute the profile holds", () => {
    // 08:30 + 19 minutes is the last bucket the fixture inserted.
    expect(getHrFrontierLocal(profileId)).toBe(minuteAfter(WINDOW.end, 19));
  });

  it("covers a window the frontier has passed", () => {
    expect(
      getEventPhysiology(profileId, {
        date: DAY,
        start_time: "08:00",
        end_time: "08:30",
        duration_min: 30,
      })!.covered
    ).toBe(true);
  });

  // The lag case, at the gather tier: a session still running past the newest minute
  // the pipeline has delivered. Every fact below it is a partial window's.
  it("does NOT cover a window whose end is past the frontier", () => {
    const late = getEventPhysiology(profileId, {
      date: DAY,
      start_time: "08:00",
      end_time: "12:00",
      duration_min: 240,
    })!;
    expect(late.covered).toBe(false);
    expect(late.inWindow).not.toBeNull();
  });

  it("builds the recovery ceiling from the resting baseline plus its spread", () => {
    // Baseline over the prior points (52, 54) is 53; the ceiling sits above it.
    const ceiling = restingCeilingBpm(profileId);
    expect(ceiling).not.toBeNull();
    expect(ceiling!).toBeGreaterThan(53);
    expect(ceiling!).toBeLessThan(60);
  });

  it("has nothing to say about a row with no bounded window", () => {
    expect(
      getEventPhysiology(profileId, {
        date: DAY,
        start_time: null,
        end_time: null,
        duration_min: null,
      })
    ).toBeNull();
  });
});
