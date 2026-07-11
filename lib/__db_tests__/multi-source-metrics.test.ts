// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #14 — multi-source / multi-device metric coexistence:
//   • migration 014 rebuilds hr_minutes with `source` in the PRIMARY KEY
//     (legacy-row copy + NULL backfill + replay no-op),
//   • the keyed upserts let two sources share a window/minute/day while a
//     re-push from the SAME source stays idempotent and an edit-locked row
//     survives re-ingest,
//   • the reads never double-count an additive metric across sources and honor
//     the per-profile primary-source choice (profile_settings tier).
//
// Runs via `npm run test:db` (vitest.db.config.ts). The `db` singleton is pointed
// at a throwaway per-file temp DB by lib/__db_tests__/setup.ts.

import Database from "better-sqlite3";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { db } from "@/lib/db";
import { MIGRATIONS } from "@/lib/migrations/versions";
import {
  upsertBodyMetrics,
  upsertHrMinutes,
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";
import {
  getBodyMetricDailySeries,
  getHrDailySummary,
  getLatestBodyMetricDated,
  getMetricDailyTotals,
  getMetricSeriesBySource,
  getSleepSessions,
  getSleepStageDailyTotals,
} from "@/lib/queries";
import {
  deleteProfileSetting,
  setMetricSourcePriorityEntry,
} from "@/lib/settings";
import { METRIC_SOURCE_PRIORITY_KEY } from "@/lib/metric-source-priority";

// ---- migration 014: hr_minutes key rebuild -----------------------------------

function hrMinutesPkCols(handle: Database.Database): string[] {
  return (
    handle.prepare("PRAGMA table_info(hr_minutes)").all() as {
      name: string;
      pk: number;
    }[]
  )
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

describe("migration 014 — source joins the hr_minutes primary key", () => {
  it("rebuilds a legacy table, backfilling NULL sources to health-connect", () => {
    const mem = new Database(":memory:");
    mem.pragma("foreign_keys = OFF");
    // Build the pre-013 schema (migrations 1..12), then plant legacy rows.
    for (const m of MIGRATIONS) {
      if (m.id >= 13) break;
      m.up(mem);
    }
    expect(hrMinutesPkCols(mem)).toEqual(["profile_id", "ts"]);
    const profileId = Number(
      mem.prepare("INSERT INTO profiles (name) VALUES ('M13')").run()
        .lastInsertRowid
    );
    mem
      .prepare(
        "INSERT INTO hr_minutes (profile_id, ts, bpm, n, source) VALUES (?, ?, ?, ?, ?)"
      )
      .run(profileId, "2024-02-01T08:00", 61, 6, null);
    mem
      .prepare(
        "INSERT INTO hr_minutes (profile_id, ts, bpm, n, source) VALUES (?, ?, ?, ?, ?)"
      )
      .run(profileId, "2024-02-01T08:01", 63, 6, "health-connect");

    const m014 = MIGRATIONS.find((m) => m.id === 14)!;
    m014.up(mem);

    expect(hrMinutesPkCols(mem)).toEqual(["profile_id", "ts", "source"]);
    const rows = mem
      .prepare(
        "SELECT ts, bpm, source FROM hr_minutes WHERE profile_id = ? ORDER BY ts"
      )
      .all(profileId) as { ts: string; bpm: number; source: string }[];
    expect(rows).toEqual([
      { ts: "2024-02-01T08:00", bpm: 61, source: "health-connect" }, // NULL backfilled
      { ts: "2024-02-01T08:01", bpm: 63, source: "health-connect" },
    ]);

    // Replay safety: a second up() is a pure no-op (sentinel short-circuits).
    m014.up(mem);
    expect(hrMinutesPkCols(mem)).toEqual(["profile_id", "ts", "source"]);
    expect(
      (
        mem
          .prepare("SELECT COUNT(*) AS c FROM hr_minutes WHERE profile_id = ?")
          .get(profileId) as { c: number }
      ).c
    ).toBe(2);
    mem.close();
  });

  it("the fresh schema (singleton) already carries the source-aware key", () => {
    expect(hrMinutesPkCols(db as unknown as Database.Database)).toEqual([
      "profile_id",
      "ts",
      "source",
    ]);
  });
});

// ---- source coexistence + idempotency on the shared upserts -------------------

let profileId: number;

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('MultiSource')").run()
      .lastInsertRowid
  );
});

afterEach(() => {
  // Reset any primary-source choice a test made.
  deleteProfileSetting(profileId, METRIC_SOURCE_PRIORITY_KEY);
});

const sample = (
  metric: string,
  date: string,
  value: number,
  window?: { start: string; end: string }
): NormMetricSample => ({
  metric,
  date,
  start_time: window?.start ?? `${date}T00:00`,
  end_time: window?.end ?? `${date}T23:59`,
  value,
});

describe("hr_minutes upsert — per-source idempotency", () => {
  it("two sources on the same minute coexist; a same-source re-push is unchanged", () => {
    const minute = {
      ts: "2024-02-02T08:00",
      bpm: 120,
      bpm_min: 110,
      bpm_max: 130,
      n: 6,
    };
    const first = upsertHrMinutes(profileId, [minute], "health-connect");
    expect(first).toMatchObject({ inserted: 1, updated: 0, unchanged: 0 });

    const other = upsertHrMinutes(profileId, [{ ...minute, bpm: 96 }], "oura");
    expect(other).toMatchObject({ inserted: 1, updated: 0, unchanged: 0 });

    // Identical re-push from the same source: no write, counted unchanged.
    const replay = upsertHrMinutes(profileId, [minute], "health-connect");
    expect(replay).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });

    // A changed re-push replaces ONLY its own source's bucket.
    const changed = upsertHrMinutes(
      profileId,
      [{ ...minute, bpm: 121 }],
      "health-connect"
    );
    expect(changed).toMatchObject({ inserted: 0, updated: 1, unchanged: 0 });

    const rows = db
      .prepare(
        `SELECT source, bpm FROM hr_minutes
          WHERE profile_id = ? AND ts = ? ORDER BY source`
      )
      .all(profileId, minute.ts) as { source: string; bpm: number }[];
    expect(rows).toEqual([
      { source: "health-connect", bpm: 121 },
      { source: "oura", bpm: 96 },
    ]);
  });
});

describe("body_metrics upsert — two sources coexist, edit lock respected", () => {
  const DATE = "2024-02-03";

  it("each source keeps its own row for the same day", () => {
    upsertBodyMetrics(
      profileId,
      [{ date: DATE, resting_hr: 60 }],
      "health-connect"
    );
    upsertBodyMetrics(profileId, [{ date: DATE, resting_hr: 52 }], "oura");
    const rows = db
      .prepare(
        `SELECT source, resting_hr FROM body_metrics
          WHERE profile_id = ? AND date = ? ORDER BY source`
      )
      .all(profileId, DATE) as { source: string; resting_hr: number }[];
    expect(rows).toEqual([
      { source: "health-connect", resting_hr: 60 },
      { source: "oura", resting_hr: 52 },
    ]);
  });

  it("an edit-locked row survives its source's re-push; the other source still lands", () => {
    // Hand-corrected Health Connect row → edited flag set (issue #133).
    db.prepare(
      `UPDATE body_metrics SET resting_hr = 58, edited = 1
        WHERE profile_id = ? AND date = ? AND source = 'health-connect'`
    ).run(profileId, DATE);

    const counts = upsertBodyMetrics(
      profileId,
      [{ date: DATE, resting_hr: 61 }],
      "health-connect"
    );
    expect(counts).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });

    const oura = upsertBodyMetrics(
      profileId,
      [{ date: DATE, resting_hr: 53 }],
      "oura"
    );
    expect(oura).toMatchObject({ updated: 1 });

    const rows = db
      .prepare(
        `SELECT source, resting_hr FROM body_metrics
          WHERE profile_id = ? AND date = ? ORDER BY source`
      )
      .all(profileId, DATE) as { source: string; resting_hr: number }[];
    expect(rows).toEqual([
      { source: "health-connect", resting_hr: 58 }, // the hand-correction, kept
      { source: "oura", resting_hr: 53 },
    ]);
  });
});

// ---- reads: no cross-source double-count + primary-source choice --------------

describe("getMetricDailyTotals — additive metrics never sum across sources", () => {
  const DATE = "2024-02-04";

  beforeAll(() => {
    upsertMetricSamples(
      profileId,
      [sample("steps", DATE, 8000)],
      "health-connect"
    );
    upsertMetricSamples(profileId, [sample("steps", DATE, 7000)], "oura");
  });

  it("keeps one source per day (default preference: health-connect)", () => {
    const totals = getMetricDailyTotals(profileId, "steps");
    expect(totals).toEqual([{ date: DATE, value: 8000 }]);
  });

  it("honors the profile's primary source for the metric", () => {
    setMetricSourcePriorityEntry(profileId, "steps", "oura");
    expect(getMetricDailyTotals(profileId, "steps")).toEqual([
      { date: DATE, value: 7000 },
    ]);
  });

  it("point (AVG) metrics blend sources by default and narrow to a primary source", () => {
    upsertMetricSamples(
      profileId,
      [sample("hrv_ms", DATE, 40)],
      "health-connect"
    );
    upsertMetricSamples(profileId, [sample("hrv_ms", DATE, 60)], "oura");
    expect(getMetricDailyTotals(profileId, "hrv_ms")).toEqual([
      { date: DATE, value: 50 },
    ]);
    setMetricSourcePriorityEntry(profileId, "hrv_ms", "oura");
    expect(getMetricDailyTotals(profileId, "hrv_ms")).toEqual([
      { date: DATE, value: 60 },
    ]);
    // A stale pick (source with no data) falls back to the blended read.
    setMetricSourcePriorityEntry(profileId, "hrv_ms", "strava");
    expect(getMetricDailyTotals(profileId, "hrv_ms")).toEqual([
      { date: DATE, value: 50 },
    ]);
  });
});

describe("sleep — stages and sessions keep one source per night", () => {
  const DATE = "2024-02-05";
  const hcWindow = { start: "2024-02-04T23:00", end: "2024-02-05T07:00" };
  const ouraWindow = { start: "2024-02-04T23:05", end: "2024-02-05T07:10" };

  beforeAll(() => {
    upsertMetricSamples(
      profileId,
      [
        sample("sleep_min", DATE, 480, hcWindow),
        sample("sleep_deep_min", DATE, 60, hcWindow),
        sample("sleep_rem_min", DATE, 90, hcWindow),
        sample("sleep_light_min", DATE, 300, hcWindow),
        sample("sleep_awake_min", DATE, 30, hcWindow),
      ],
      "health-connect"
    );
    upsertMetricSamples(
      profileId,
      [
        sample("sleep_min", DATE, 470, ouraWindow),
        sample("sleep_deep_min", DATE, 70, ouraWindow),
        sample("sleep_rem_min", DATE, 80, ouraWindow),
        sample("sleep_light_min", DATE, 290, ouraWindow),
        sample("sleep_awake_min", DATE, 35, ouraWindow),
      ],
      "oura"
    );
  });

  it("stage totals are one source's night, never the sum of both", () => {
    const [night] = getSleepStageDailyTotals(profileId).filter(
      (r) => r.date === DATE
    );
    expect(night).toEqual({
      date: DATE,
      deep: 60,
      rem: 90,
      light: 300,
      awake: 30,
    });
  });

  it("nightly duration follows the same pick (no 950-minute night)", () => {
    const totals = getMetricDailyTotals(profileId, "sleep_min").filter(
      (r) => r.date === DATE
    );
    expect(totals).toEqual([{ date: DATE, value: 480 }]);
  });

  it("the sleep_min primary source flips BOTH the duration and the stage night", () => {
    setMetricSourcePriorityEntry(profileId, "sleep_min", "oura");
    expect(
      getMetricDailyTotals(profileId, "sleep_min").filter(
        (r) => r.date === DATE
      )
    ).toEqual([{ date: DATE, value: 470 }]);
    expect(
      getSleepStageDailyTotals(profileId).filter((r) => r.date === DATE)[0]
    ).toEqual({ date: DATE, deep: 70, rem: 80, light: 290, awake: 35 });
  });

  it("sessions come from a single stream (the SRI input never interleaves)", () => {
    const sessions = getSleepSessions(profileId);
    const sources = new Set(sessions.map((s) => s.source));
    expect(sources.size).toBe(1);
  });
});

describe("single-value + series reads honor the primary source", () => {
  it("getLatestBodyMetricDated prefers the chosen source even when older", () => {
    upsertBodyMetrics(
      profileId,
      [{ date: "2024-02-07", resting_hr: 61 }],
      "health-connect"
    );
    upsertBodyMetrics(
      profileId,
      [{ date: "2024-02-06", resting_hr: 51 }],
      "oura"
    );

    // Unset: newest reading of any source (the 2024-02-07 HC row).
    // (The 2024-02-03 rows from the edit-lock suite are older and don't win.)
    expect(getLatestBodyMetricDated(profileId, "resting_hr")).toEqual({
      value: 61,
      date: "2024-02-07",
    });

    setMetricSourcePriorityEntry(profileId, "resting_hr", "oura");
    expect(getLatestBodyMetricDated(profileId, "resting_hr")).toEqual({
      value: 51,
      date: "2024-02-06",
    });

    // A chosen source with no readings falls back to the newest of any source.
    setMetricSourcePriorityEntry(profileId, "resting_hr", "strava");
    expect(getLatestBodyMetricDated(profileId, "resting_hr")).toEqual({
      value: 61,
      date: "2024-02-07",
    });
  });

  it("getBodyMetricDailySeries keeps one value per day", () => {
    const series = getBodyMetricDailySeries(profileId, "resting_hr");
    const dates = series.map((r) => r.date);
    expect(new Set(dates).size).toBe(dates.length); // no doubled days
    const day = series.find((r) => r.date === "2024-02-07");
    expect(day).toEqual({ date: "2024-02-07", value: 61 });
  });

  it("getHrDailySummary keeps one source's minutes per day", () => {
    // 2024-02-02 (from the upsert suite) carries HC bpm 121 and Oura bpm 96 on the
    // same minute; blending them would average ~108.5.
    const day = getHrDailySummary(profileId).find(
      (r) => r.date === "2024-02-02"
    );
    expect(day?.avg).toBe(121); // health-connect preferred, oura kept for compare
  });

  it("getMetricSeriesBySource returns every source's series for the overlay", () => {
    const series = getMetricSeriesBySource(profileId, "steps");
    expect(series.map((s) => s.source)).toEqual(["health-connect", "oura"]);
    expect(series[0].data).toEqual([{ date: "2024-02-04", value: 8000 }]);
    expect(series[1].data).toEqual([{ date: "2024-02-04", value: 7000 }]);
  });
});
