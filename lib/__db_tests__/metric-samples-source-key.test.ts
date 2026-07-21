// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Covers the fix: `source` is part of the metric_samples unique key, so two
// providers reporting the SAME metric for the SAME window coexist instead of
// silently overwriting each other. Also covers the follow-up guard that body
// fat / resting HR never re-split into metric_samples via the ingest normalizer.
//
// Runs via `npm run test:db` (vitest.db.config.ts). The `db` singleton is pointed
// at a throwaway per-file temp DB by lib/__db_tests__/setup.ts, and the schema has
// already been applied (fresh boot) by the time this module imports it.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";

// The columns of the metric_samples natural-key UNIQUE index, in order — read from
// SQLite so the test observes the REAL constraint, not a hand copy.
function uniqueKeyCols(): string[] {
  const idxs = db.prepare(`PRAGMA index_list(metric_samples)`).all() as {
    name: string;
    unique: number;
  }[];
  for (const idx of idxs) {
    if (!idx.unique) continue;
    const cols = (
      db.prepare(`PRAGMA index_info("${idx.name}")`).all() as { name: string }[]
    ).map((c) => c.name);
    if (cols.includes("metric") && cols.includes("start_time")) return cols;
  }
  return [];
}

let profileId: number;
const WINDOW = { start: "2024-01-01T00:00", end: "2024-01-01T23:59" };
const sample = (metric: string, value: number): NormMetricSample => ({
  metric,
  date: "2024-01-01",
  start_time: WINDOW.start,
  end_time: WINDOW.end,
  value,
});

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('MS')").run()
      .lastInsertRowid
  );
});

describe("metric_samples: source is part of the unique key", () => {
  it("fresh schema's unique key includes source", () => {
    expect(uniqueKeyCols()).toContain("source");
    // Leads with (profile_id, metric) to serve the rollup reads' WHERE prefix.
    expect(uniqueKeyCols().slice(0, 2)).toEqual(["profile_id", "metric"]);
  });

  it("two sources reporting the same (metric, window) coexist", () => {
    upsertMetricSamples(profileId, [sample("steps", 1000)], "health-connect");
    upsertMetricSamples(profileId, [sample("steps", 2000)], "strava");

    const rows = db
      .prepare(
        `SELECT source, value FROM metric_samples
          WHERE profile_id = ? AND metric = 'steps'
            AND start_time = ? AND end_time = ?
          ORDER BY source`
      )
      .all(profileId, WINDOW.start, WINDOW.end) as {
      source: string;
      value: number;
    }[];
    expect(rows).toEqual([
      { source: "health-connect", value: 1000 },
      { source: "strava", value: 2000 },
    ]);
  });

  it("re-sending the SAME source's window overwrites itself (idempotent)", () => {
    upsertMetricSamples(profileId, [sample("hrv_ms", 40)], "health-connect");
    upsertMetricSamples(profileId, [sample("hrv_ms", 55)], "health-connect");
    const rows = db
      .prepare(
        `SELECT value FROM metric_samples
          WHERE profile_id = ? AND metric = 'hrv_ms' AND source = 'health-connect'`
      )
      .all(profileId) as { value: number }[];
    expect(rows).toEqual([{ value: 55 }]); // one row, updated in place
  });

  it("updates a moving-end snapshot in place and keeps separate origins", () => {
    const start = "2024-01-02T00:00:00Z";
    const first: NormMetricSample = {
      metric: "steps",
      date: "2024-01-02",
      start_time: start,
      end_time: "2024-01-02T12:00:00Z",
      value: 4000,
      origin: "com.fitbit.FitbitMobile",
    };
    expect(
      upsertMetricSamples(profileId, [first], "health-connect")
    ).toMatchObject({ inserted: 1 });
    expect(
      upsertMetricSamples(
        profileId,
        [
          { ...first, end_time: "2024-01-02T20:00:00Z", value: 8000 },
          {
            ...first,
            end_time: "2024-01-02T20:00:00Z",
            value: 7000,
            origin: "com.garmin.android.apps.connectmobile",
          },
        ],
        "health-connect"
      )
    ).toMatchObject({ inserted: 1, updated: 1 });

    const rows = db
      .prepare(
        `SELECT origin, end_time, value FROM metric_samples
          WHERE profile_id = ? AND metric = 'steps' AND start_time = ?
          ORDER BY origin`
      )
      .all(profileId, start);
    expect(rows).toEqual([
      {
        origin: "com.fitbit.FitbitMobile",
        end_time: "2024-01-02T20:00:00Z",
        value: 8000,
      },
      {
        origin: "com.garmin.android.apps.connectmobile",
        end_time: "2024-01-02T20:00:00Z",
        value: 7000,
      },
    ]);

    const stale = upsertMetricSamples(
      profileId,
      [{ ...first, end_time: "2024-01-02T12:00:00Z", value: 4000 }],
      "health-connect"
    );
    expect(stale).toMatchObject({ updated: 0, unchanged: 1 });
    expect(
      db
        .prepare(
          `SELECT end_time, value FROM metric_samples
            WHERE profile_id = ? AND metric = 'steps' AND start_time = ?
              AND origin = 'com.fitbit.FitbitMobile'`
        )
        .get(profileId, start)
    ).toEqual({ end_time: "2024-01-02T20:00:00Z", value: 8000 });
  });
});

describe("metric_samples: body-metric measures never land here", () => {
  it("skips body_fat_pct / resting_hr rows in the samples upsert", () => {
    const counts = upsertMetricSamples(
      profileId,
      [
        sample("body_fat_pct", 18),
        sample("resting_hr", 52),
        sample("steps", 9),
      ],
      "health-connect"
    );
    // Only the real sample metric ('steps') is written/counted; the two
    // body-metric rows are skipped and contribute to no count. (The steps row for
    // this window already exists from an earlier test in this file, so it lands as
    // an update — either way exactly one row is accounted for.)
    expect(counts.inserted + counts.updated + counts.unchanged).toBe(1);
    const bodyMetricRows = db
      .prepare(
        `SELECT COUNT(*) AS c FROM metric_samples
          WHERE profile_id = ? AND metric IN ('body_fat_pct','resting_hr')`
      )
      .get(profileId) as { c: number };
    expect(bodyMetricRows.c).toBe(0);
  });
});
