// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Covers the #115 fix: getLatestMetricSample fetches the newest metric_samples
// reading with `ORDER BY end_time DESC LIMIT 1`. end_time is NOT the third column
// of idx_metric_samples_md (profile_id, metric, date) — `date` derives from
// start_time in the profile timezone (#94) and can diverge from end_time at day
// boundaries, so the sort key stays end_time. Before the fix the planner served
// the (profile_id, metric) equality via that index but added a
// `USE TEMP B-TREE FOR ORDER BY`, materializing + sorting the whole slice to
// return one row. The companion index idx_metric_samples_end
// (profile_id, metric, end_time) makes the ORDER BY an index-ordered reverse seek.
//
// Runs via `npm run test:db` (vitest.db.config.ts). The `db` singleton is pointed
// at a throwaway per-file temp DB by lib/__db_tests__/setup.ts, and migrate() has
// already run (fresh schema) by the time this module imports it.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { getLatestMetricSample } from "@/lib/queries";

// The exact statement getLatestMetricSample prepares (lib/queries/metrics.ts).
const LATEST_SQL =
  "SELECT value, substr(end_time, 1, 10) AS date FROM metric_samples WHERE profile_id = ? AND metric = ? ORDER BY end_time DESC LIMIT 1";

function queryPlan(sql: string, ...args: unknown[]): string[] {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]
  ).map((r) => r.detail);
}

let profileId: number;

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('LatestIdx')").run()
      .lastInsertRowid
  );
  // A spread of days for one metric so a whole-slice temp sort would be visible.
  const ins = db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'health-connect', 'steps', ?, ?, ?, ?)`
  );
  for (let d = 1; d <= 28; d++) {
    const day = `2024-03-${String(d).padStart(2, "0")}`;
    ins.run(profileId, day, `${day}T00:00`, `${day}T23:59`, 1000 + d);
  }
});

describe("getLatestMetricSample: end_time ORDER BY is index-served (#115)", () => {
  it("plan uses idx_metric_samples_end with no temp b-tree sort", () => {
    const plan = queryPlan(LATEST_SQL, profileId, "steps");
    const joined = plan.join("\n");
    // The whole point of the fix: the planner no longer materializes + sorts the
    // (profile_id, metric) slice to answer ORDER BY end_time DESC LIMIT 1.
    expect(joined).not.toMatch(/TEMP B-TREE/i);
    // And it does so by walking the companion index in end_time order.
    expect(joined).toMatch(/idx_metric_samples_end/);
  });

  it("still returns the reading with the newest end_time", () => {
    // Day 28 has the latest end_time; its value (1028) is the answer.
    expect(getLatestMetricSample(profileId, "steps")).toEqual({
      value: 1028,
      date: "2024-03-28",
    });
  });
});
