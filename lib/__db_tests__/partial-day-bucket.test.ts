// DB INTEGRATION TIER — THE DAY THAT IS NOT OVER (#4924).
//
// A daily bucket over a stream is a running total until local midnight, and the
// readers handed today's half-day back looking exactly like a finished one. The
// flag has to be true for the right row and false for every other, which is two
// assertions and not one: a `partial` that is always true, or never, passes a
// one-sided test happily and then either qualifies every number on the page or
// none of them.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect } from "vitest";
import { getHrDailySummary, getMetricDailyTotals } from "@/lib/queries";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function seedHrMinute(profileId: number, date: string, bpm: number): void {
  db.prepare(
    `INSERT INTO hr_minutes (profile_id, ts, bpm, bpm_min, bpm_max, n, source)
     VALUES (?, ?, ?, ?, ?, 1, 'oura')`
  ).run(profileId, `${date}T08:00`, bpm, bpm - 4, bpm + 9);
}

function seedMetric(
  profileId: number,
  metric: string,
  date: string,
  value: number
): void {
  db.prepare(
    `INSERT INTO metric_samples
       (profile_id, source, metric, date, started_at, ended_at, value)
     VALUES (?, 'oura', ?, ?, ?, ?, ?)`
  ).run(profileId, metric, date, `${date}T00:00`, `${date}T23:59`, value);
}

describe("the profile-local today is a partial bucket", () => {
  it("marks today's HR average and nothing else", () => {
    const profile = newProfile("hr partial");
    const now = today(profile);
    const before = shiftDateStr(now, -1);
    seedHrMinute(profile, before, 71);
    seedHrMinute(profile, now, 59);

    const rows = getHrDailySummary(profile, 30);
    expect(rows.map((r) => [r.date, r.partial ?? false])).toEqual([
      [before, false],
      [now, true],
    ]);
  });

  it("a stream that has not reported today leaves its last day whole", () => {
    // The converse the issue names: a metric with no row for today is unchanged,
    // so nothing on a quiet card is qualified by a day it did not report in.
    const profile = newProfile("hr quiet");
    const stale = shiftDateStr(today(profile), -3);
    seedHrMinute(profile, stale, 64);

    expect(getHrDailySummary(profile, 30).map((r) => r.partial)).toEqual([
      undefined,
    ]);
  });

  it.each([
    // An ADDITIVE total accumulates through the day; a POINT reading is complete
    // when it is taken, and calling a height measured this morning partial would
    // be a second, wrong claim.
    ["steps", true],
    ["height_cm", false],
  ])("%s today is partial: %s", (metric, partial) => {
    const profile = newProfile(`totals ${metric}`);
    const now = today(profile);
    const before = shiftDateStr(now, -1);
    seedMetric(profile, metric, before, 100);
    seedMetric(profile, metric, now, 120);

    const rows = getMetricDailyTotals(profile, metric, 30);
    expect(rows.map((r) => r.date)).toEqual([before, now]);
    expect(rows.map((r) => r.partial ?? false)).toEqual([false, partial]);
  });
});
