// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Covers the #128 fix: `source` is part of the metric_samples unique key, so two
// providers reporting the SAME metric for the SAME window coexist instead of
// silently overwriting each other. Also covers the #120-follow-up guard that body
// fat / resting HR never re-split into metric_samples via the ingest normalizer.
//
// Runs via `npm run test:db` (vitest.db.config.ts). The `db` singleton is pointed
// at a throwaway per-file temp DB by lib/__db_tests__/setup.ts, and migrate() has
// already run (fresh schema) by the time this module imports it.

import { describe, it, expect, beforeAll } from "vitest";
import { db, migrate } from "@/lib/db";
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

describe("metric_samples: source is part of the unique key (#128)", () => {
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
});

describe("metric_samples: body-metric measures never land here (#120 guard)", () => {
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

describe("metric_samples: upgrade rebuild adds source to a pre-#128 key", () => {
  it("rebuilds a profile_id-but-no-source key in place, preserving rows", () => {
    // Reconstruct the intermediate pre-#128 shape: profile_id present, but the
    // OLD unique key UNIQUE(profile_id, metric, start_time, end_time) (no source).
    db.exec(`
      DROP TABLE metric_samples;
      CREATE TABLE metric_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        source TEXT NOT NULL,
        metric TEXT NOT NULL,
        date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        value REAL NOT NULL,
        UNIQUE (profile_id, metric, start_time, end_time)
      );
    `);
    db.prepare(
      `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'health-connect', 'steps', '2024-02-01', ?, ?, 4321)`
    ).run(profileId, "2024-02-01T00:00", "2024-02-01T23:59");
    expect(uniqueKeyCols()).not.toContain("source"); // precondition: old key

    // THE UPGRADE: re-run migrate() (what an existing deployment does on boot).
    expect(() => migrate(db)).not.toThrow();

    // Key now carries source, and the pre-existing row survived the rebuild.
    expect(uniqueKeyCols()).toContain("source");
    const kept = db
      .prepare(
        `SELECT value FROM metric_samples WHERE profile_id = ? AND metric = 'steps' AND date = '2024-02-01'`
      )
      .all(profileId) as { value: number }[];
    expect(kept).toEqual([{ value: 4321 }]);

    // And a second source for that same window now coexists (the whole point).
    db.prepare(
      `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'strava', 'steps', '2024-02-01', ?, ?, 9999)`
    ).run(profileId, "2024-02-01T00:00", "2024-02-01T23:59");
    const both = db
      .prepare(
        `SELECT COUNT(*) AS c FROM metric_samples WHERE profile_id = ? AND metric = 'steps' AND date = '2024-02-01'`
      )
      .get(profileId) as { c: number };
    expect(both.c).toBe(2);
  });
});
