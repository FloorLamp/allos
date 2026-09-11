// DB INTEGRATION TIER — A CATEGORICAL METRIC DECLINES TO AGGREGATE (#3167).
//
// `metricAggregation` answers "NONE" for a categorical metric, and the two daily
// reads that branch on it must return NO FIGURE rather than a fabricated one. A
// Bristol day holding a type 2 and a type 6 has no honest daily number: their mean
// (4) names textbook-normal, and their sum (8) names a type that does not exist.
//
// Both assertions are "nothing came back", which an inactive harness passes just as
// happily as a correct one — so every case carries a POSITIVE CONTROL in the same
// test: the rows are proven present in metric_samples, and an additive metric seeded
// the same way on the same day is read back with its total. Nothing here can pass by
// reading an empty database.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { getMetricDailyTotals, getMetricSeriesBySource } from "@/lib/queries";
import { BRISTOL_STOOL_METRIC } from "@/lib/bristol-stool";
import { metricAggregation } from "@/lib/metric-buckets";

const DATE = "2026-03-04";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function seedSample(
  profileId: number,
  metric: string,
  value: number,
  hour: string
): void {
  db.prepare(
    `INSERT INTO metric_samples
       (profile_id, source, metric, date, started_at, ended_at, value)
     VALUES (?, 'manual', ?, ?, ?, ?, ?)`
  ).run(profileId, metric, DATE, `${DATE}T${hour}`, `${DATE}T${hour}`, value);
}

function sampleCount(profileId: number, metric: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM metric_samples WHERE profile_id = ? AND metric = ?"
      )
      .get(profileId, metric) as { n: number }
  ).n;
}

describe("a categorical metric reaches no aggregation", () => {
  it("the daily read returns no total for Bristol, and the control metric's total", () => {
    const profile = newProfile("categorical daily read");
    // Two readings on ONE day, so a day-grouping aggregation would have something
    // to combine: AVG would answer 4, SUM would answer 8.
    seedSample(profile, BRISTOL_STOOL_METRIC, 2, "07:10");
    seedSample(profile, BRISTOL_STOOL_METRIC, 6, "19:40");
    // The control: an additive metric, same profile, same day, same seeding path.
    seedSample(profile, "steps", 4000, "07:10");
    seedSample(profile, "steps", 2500, "19:40");

    expect(metricAggregation(BRISTOL_STOOL_METRIC)).toBe("NONE");
    expect(metricAggregation("steps")).toBe("SUM");

    // POSITIVE CONTROL, part 1: the Bristol rows really are in the table, so an
    // empty daily read is a REFUSAL and not an empty database.
    expect(sampleCount(profile, BRISTOL_STOOL_METRIC)).toBe(2);

    expect(getMetricDailyTotals(profile, BRISTOL_STOOL_METRIC)).toEqual([]);

    // POSITIVE CONTROL, part 2: the same reader, on the same day's rows, does
    // produce a total for a metric that aggregates.
    expect(
      getMetricDailyTotals(profile, "steps").map((row) => [row.date, row.value])
    ).toEqual([[DATE, 6500]]);
  });

  it("the by-source read returns no series for Bristol, and the control metric's series", () => {
    const profile = newProfile("categorical by-source read");
    seedSample(profile, BRISTOL_STOOL_METRIC, 2, "07:10");
    seedSample(profile, BRISTOL_STOOL_METRIC, 6, "19:40");
    seedSample(profile, "steps", 4000, "07:10");
    seedSample(profile, "steps", 2500, "19:40");

    expect(sampleCount(profile, BRISTOL_STOOL_METRIC)).toBe(2);

    expect(getMetricSeriesBySource(profile, BRISTOL_STOOL_METRIC)).toEqual([]);

    expect(
      getMetricSeriesBySource(profile, "steps").map((series) => [
        series.source,
        series.data.map((row) => [row.date, row.value]),
      ])
    ).toEqual([["manual", [[DATE, 6500]]]]);
  });
});
