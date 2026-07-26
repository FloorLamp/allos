import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { ZipBuilder } from "@/lib/zip-write";
import { importTakeoutArchive } from "@/lib/integrations/fitbit-takeout-import";

// DB INTEGRATION TIER — the Fitbit Google Takeout importer end to end: a REAL zip on
// disk → selective walk → parse → chunked upsert → sync event.
//
// The fixture is a genuine archive built with the app's own ZipBuilder, including the
// two bulk directories that make a real export unreadable-by-default and the "no
// data" placeholder files. Values are synthetic; the SHAPES are what a real export
// carries (verified against one).

const TZ = "America/New_York";
const ROOT = "Takeout/Google Health";
let profileId: number;
let archive: string;

// A ~2 MB stand-in for the ML directories that are ~81% of a real archive. If the
// walker ever stops filtering by path it will inflate this, and the entriesRead
// assertion below fails — which is the point.
const BULK = Buffer.alloc(2 * 1024 * 1024, 0x41);

const FILES: [string, string | Buffer][] = [
  [
    `${ROOT}/Physical Activity_GoogleData/weight.csv`,
    [
      "timestamp,weight grams,data source",
      "2018-05-28T13:30:12Z,62400,Renpho Fitbit 3P Web API",
      "2026-07-25T10:12:44Z,64900,Renpho Fitbit 3P Web API",
      // Already synced via Health Connect — must be left to that provider.
      "2026-07-26T10:12:44Z,64000,Phone Health Connect",
    ].join("\n"),
  ],
  [
    `${ROOT}/Physical Activity_GoogleData/body_fat_2018-06-01.csv`,
    [
      "timestamp,body fat percentage,data source",
      "2018-06-01T13:16:20Z,11.6,Renpho Fitbit 3P Web API",
    ].join("\n"),
  ],
  [
    `${ROOT}/Physical Activity_GoogleData/daily_resting_heart_rate.csv`,
    [
      "timestamp,beats per minute,data source",
      "2026-06-10T12:00:00Z,66.876,Fitbit App",
    ].join("\n"),
  ],
  [
    `${ROOT}/Physical Activity_GoogleData/daily_respiratory_rate.csv`,
    [
      "timestamp,breaths per minute,data source",
      "2026-06-11T12:00:00Z,13.8,Fitbit App",
    ].join("\n"),
  ],
  [
    `${ROOT}/Physical Activity_GoogleData/daily_oxygen_saturation.csv`,
    [
      "timestamp,average percentage,lower bound percentage,upper bound percentage,baseline percentage,standard deviation percentage,data source",
      "2026-06-11T12:00:00Z,94.8,93.2,96.5,0.0,0.0,Radiance",
    ].join("\n"),
  ],
  [
    `${ROOT}/Sleep Score/sleep_score.csv`,
    [
      "sleep_log_entry_id,timestamp,overall_score,composition_score,revitalization_score,duration_score,deep_sleep_in_minutes,resting_heart_rate,restlessness",
      "531347243,2026-07-26T12:00:00Z,48,,48,,58,63,0.15",
    ].join("\n"),
  ],
  [
    `${ROOT}/Physical Activity_GoogleData/daily_readiness.csv`,
    [
      "timestamp,score,type,readiness level,sleep readiness,heart rate variability readiness,resting heart rate readiness,data source",
      // BARE day — must not shift into 06-15.
      "2026-06-16,76,HIGH,TYPE_UNSPECIFIED,VERY_HIGH,HIGH,HIGH,Fitbit App",
    ].join("\n"),
  ],
  [
    `${ROOT}/Global Export Data/sleep-2026-06-09.json`,
    JSON.stringify([
      {
        logId: 52989815882,
        dateOfSleep: "2026-07-09",
        startTime: "2026-07-08T22:52:30.000",
        endTime: "2026-07-09T05:45:30.000",
        duration: 24780000,
        type: "stages",
        mainSleep: true,
        levels: {
          summary: {
            deep: { count: 4, minutes: 44 },
            wake: { count: 25, minutes: 78 },
            light: { count: 26, minutes: 284 },
            rem: { count: 1, minutes: 7 },
          },
        },
      },
    ]),
  ],
  [
    `${ROOT}/Global Export Data/exercise-0.json`,
    JSON.stringify([
      {
        logId: 77411312255,
        activityName: "Swim",
        startTime: "06/15/26 01:07:21",
        duration: 1024000,
        activeDuration: 1024000,
        distance: 0.170877,
        distanceUnit: "Mile",
        calories: 66,
        averageHeartRate: null,
      },
      {
        logId: 77385947804,
        activityName: "Outdoor Bike",
        startTime: "06/13/26 13:05:01",
        duration: 7475000,
        activeDuration: 7475000,
        calories: 1270,
        averageHeartRate: 155,
      },
    ]),
  ],
  // Intraday: per-second HR, and the two summable minute streams. The steps file
  // interleaves the watch with the PHONE via Health Connect — the row that must be
  // held back, or the day doubles.
  [
    `${ROOT}/Physical Activity_GoogleData/heart_rate-2026-06-10.csv`,
    [
      "timestamp,beats per minute,data source",
      "2026-06-10T16:37:52Z,133.0,Radiance",
      "2026-06-10T16:37:54Z,137.0,Radiance",
      "2026-06-10T16:38:02Z,120.0,Radiance",
    ].join("\n"),
  ],
  [
    `${ROOT}/Physical Activity_GoogleData/steps_2026-06-01.csv`,
    [
      "timestamp,steps,data source",
      "2026-06-10T16:39:00Z,34,Radiance",
      "2026-06-10T16:40:00Z,66,Radiance",
      "2026-06-10T16:39:18.008Z,500,Phone Health Connect",
    ].join("\n"),
  ],
  [
    `${ROOT}/Physical Activity_GoogleData/distance_2026-06-01.csv`,
    [
      "timestamp,distance,data source",
      "2026-06-10T16:39:00Z,1500.0,Radiance",
      "2026-06-10T16:40:00Z,500.0,Radiance",
    ].join("\n"),
  ],
  // Total calories: present, and deliberately NOT ingested (the CSV omits resting
  // minutes, so summing it would store a fraction of the day as the whole day).
  [
    `${ROOT}/Physical Activity_GoogleData/calories_2026-06-01.csv`,
    [
      "timestamp,calories,data source",
      "2026-06-10T16:27:00Z,1.07,Fitbit App",
      "2026-06-10T16:28:00Z,1.07,Fitbit App",
    ].join("\n"),
  ],
  // Present-but-empty, exactly as a real export ships them.
  [`${ROOT}/Biometrics/Glucose 1.csv`, "no data"],
  [`${ROOT}/Stress Score/Stress Score.csv`, "DATE,UPDATED_AT,STRESS_SCORE"],
  // The bulk ML directories — must never be inflated.
  [
    `${ROOT}/Health Fitness Data_GoogleData/UserActivityProbabilities_1.csv`,
    BULK,
  ],
  [
    `${ROOT}/Health Fitness Data_GoogleData/UserSensorCompressionToken_1.csv`,
    BULK,
  ],
  // A readme and a foreign product, both ignored.
  [`${ROOT}/Biometrics/Biometrics Readme.txt`, "about biometrics"],
  ["Takeout/YouTube/history.json", "[]"],
];

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('TAKEOUT')").run()
      .lastInsertRowid
  );
  setTimezone(profileId, TZ);

  const zb = new ZipBuilder();
  const parts: Buffer[] = [];
  for (const [name, data] of FILES)
    parts.push(zb.file(name, Buffer.isBuffer(data) ? data : Buffer.from(data)));
  parts.push(zb.end());
  archive = path.join(os.tmpdir(), `allos-takeout-test-${process.pid}.zip`);
  fs.writeFileSync(archive, Buffer.concat(parts));
});

describe("Fitbit Takeout import", () => {
  it("reads only the classified entries and writes every family", () => {
    const r = importTakeoutArchive(profileId, archive);

    // 12 data files are classified (9 daily + HR + steps + distance); calories,
    // the two 2 MB bulk members, the empty placeholders, the readme and the foreign
    // product are all skipped UNREAD.
    expect(r.entriesRead).toBe(12);
    expect(r.entriesSkipped).toBe(FILES.length - 12);

    // Held back: the round-trip weight row AND the phone's steps row. Counted apart
    // from malformed rows so the sync event can say so.
    expect(r.roundTripSkipped).toBe(2);
    expect(r.skipped).toBe(0);
    expect(r.counts.inserted).toBeGreaterThan(0);

    const bm = db
      .prepare(
        `SELECT date, weight_kg, body_fat_pct, resting_hr FROM body_metrics
          WHERE profile_id = ? ORDER BY date`
      )
      .all(profileId) as {
      date: string;
      weight_kg: number | null;
      body_fat_pct: number | null;
      resting_hr: number | null;
    }[];
    // Grams → kg, and the 2018 depth that no other ingest path can reach.
    expect(bm[0]).toMatchObject({ date: "2018-05-28", weight_kg: 62.4 });
    expect(bm.some((r) => r.body_fat_pct === 11.6)).toBe(true);
    expect(bm.some((r) => r.resting_hr === 67)).toBe(true);
    // The round-tripped row never landed.
    expect(bm.some((r) => r.date === "2026-07-26")).toBe(false);

    const sample = (metric: string) =>
      db
        .prepare(
          `SELECT date, value FROM metric_samples
            WHERE profile_id = ? AND metric = ? ORDER BY date`
        )
        .all(profileId, metric) as { date: string; value: number }[];

    // Vendor scores under VENDOR-PREFIXED kinds (#1069).
    expect(sample("fitbit_sleep_score")).toEqual([
      { date: "2026-07-26", value: 48 },
    ]);
    // The bare-day readiness timestamp must not shift a day westward.
    expect(sample("fitbit_readiness_score")).toEqual([
      { date: "2026-06-16", value: 76 },
    ]);

    // Sleep total + the four-bucket breakdown, on the wake day Fitbit states.
    expect(sample("sleep_min")).toEqual([{ date: "2026-07-09", value: 413 }]);
    expect(sample("sleep_deep_min")).toEqual([
      { date: "2026-07-09", value: 44 },
    ]);
    expect(sample("sleep_awake_min")).toEqual([
      { date: "2026-07-09", value: 78 },
    ]);

    const acts = db
      .prepare(
        `SELECT date, type, title, distance_km, duration_min, avg_hr FROM activities
          WHERE profile_id = ? ORDER BY date`
      )
      .all(profileId) as {
      date: string;
      type: string;
      title: string;
      distance_km: number | null;
      duration_min: number | null;
      avg_hr: number | null;
    }[];
    expect(acts).toHaveLength(2);
    // Miles → km, stored at the metric's 2dp precision. Ignoring `distanceUnit`
    // would store the raw 0.17 and under-report the swim by ~38%.
    const swim = acts.find((a) => a.title === "Swim")!;
    expect(swim.type).toBe("cardio");
    expect(swim.distance_km).toBe(0.27);
    const bike = acts.find((a) => a.title === "Outdoor Bike")!;
    expect(bike.type).toBe("cardio");
    expect(bike.avg_hr).toBe(155);

    const vitals = db
      .prepare(
        `SELECT canonical_name, value_num FROM medical_records
          WHERE profile_id = ? ORDER BY canonical_name`
      )
      .all(profileId) as { canonical_name: string; value_num: number }[];
    expect(vitals).toEqual([
      { canonical_name: "Oxygen Saturation", value_num: 94.8 },
      { canonical_name: "Respiratory Rate", value_num: 13.8 },
    ]);
  });

  it("buckets per-second heart rate to the minute", () => {
    const hr = db
      .prepare(
        `SELECT ts, bpm, bpm_min, bpm_max, n FROM hr_minutes
          WHERE profile_id = ? ORDER BY ts`
      )
      .all(profileId) as {
      ts: string;
      bpm: number;
      bpm_min: number;
      bpm_max: number;
      n: number;
    }[];
    // 16:37Z is 12:37 in New York; two samples in that minute, one in the next.
    expect(hr).toEqual([
      { ts: "2026-06-10T12:37", bpm: 135, bpm_min: 133, bpm_max: 137, n: 2 },
      { ts: "2026-06-10T12:38", bpm: 120, bpm_min: 120, bpm_max: 120, n: 1 },
    ]);
  });

  it("sums the intraday streams per day, WITHOUT the phone's duplicate steps", () => {
    const sample = (metric: string) =>
      db
        .prepare(
          `SELECT date, value FROM metric_samples
            WHERE profile_id = ? AND metric = ?`
        )
        .all(profileId, metric) as { date: string; value: number }[];
    // 34 + 66 from the watch. The phone's 500 would have made it 600.
    expect(sample("steps")).toEqual([{ date: "2026-06-10", value: 100 }]);
    // 1500 m + 500 m -> 2 km.
    expect(sample("distance_km")).toEqual([{ date: "2026-06-10", value: 2 }]);
    // Total calories are present in the archive but must never be summed into a
    // daily total from the sparse minute stream.
    expect(sample("total_kcal")).toEqual([]);
  });

  it("re-importing the same archive changes nothing", () => {
    const r = importTakeoutArchive(profileId, archive);
    expect(r.counts.inserted).toBe(0);
    expect(r.counts.updated).toBe(0);
    expect(r.counts.unchanged).toBeGreaterThan(0);
  });

  it("records ONE sync event per import, with the round-trip note", () => {
    const ev = db
      .prepare(
        `SELECT ok, received, skipped, details FROM integration_sync_events
          WHERE profile_id = ? AND provider = 'fitbit-takeout'
          ORDER BY id DESC LIMIT 1`
      )
      .get(profileId) as {
      ok: number;
      received: number;
      skipped: number;
      details: string;
    };
    expect(ev.ok).toBe(1);
    expect(ev.received).toBeGreaterThan(0);
    const details = JSON.parse(ev.details) as { warnings: string[] };
    expect(details.warnings.join(" ")).toMatch(/Health Connect/);
  });
});
