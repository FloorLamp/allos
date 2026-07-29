// DB INTEGRATION TIER — the recovery resting-HR signal folds by DATE (issue #1615).
//
// body_metrics deliberately keeps one row per (profile_id, date, source) so source
// comparison and per-metric source priority work (#14). getRestingHrSignal used to
// read raw rows with `ORDER BY date DESC LIMIT N` while asserting resting HR was
// one-per-day — so a day covered by two devices took TWO baseline slots, shortening
// the window and distorting the spread. It now asks the same question Trends asks:
// one source-prioritized point per DISTINCT date, through the shared daily fold.
//
// This tier is where the bug is visible at all — the fold is SQL + source-priority
// settings over a real schema. Every reading below is a plainly fictional bpm value.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { upsertBodyMetrics } from "@/lib/integrations/normalize";
import { getBodyMetricDailySeries, getRestingHrSignal } from "@/lib/queries";
import { setMetricSourcePriorityEntry } from "@/lib/settings";

// Four consecutive dates of resting HR; the NEWEST is the one two sources cover.
const DAYS = ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04"] as const;
const HC_BPM = [50, 52, 54, 56];

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// The daily series' own tail, as the recovery signal should read it: newest daily
// point is `recent`, the preceding points are the baseline.
function expectedFromSeries(profileId: number): {
  recent: number;
  baseline: number;
} {
  const series = getBodyMetricDailySeries(profileId, "resting_hr");
  const recent = series[series.length - 1].value;
  const prior = series.slice(0, -1);
  const baseline =
    prior.reduce((sum, p) => sum + p.value, 0) / (prior.length || 1);
  return { recent, baseline };
}

describe("getRestingHrSignal folds one source-prioritized point per date", () => {
  let profileId: number;

  beforeAll(() => {
    profileId = newProfile("RHR-FOLD");
    upsertBodyMetrics(
      profileId,
      DAYS.map((date, i) => ({ date, resting_hr: HC_BPM[i] })),
      "health-connect"
    );
  });

  it("matches the daily series before any second source exists", () => {
    const signal = getRestingHrSignal(profileId)!;
    expect(signal.recent).toBe(56);
    // Mean of 50, 52, 54.
    expect(signal.baseline).toBeCloseTo(52, 10);
    expect(signal).toMatchObject(expectedFromSeries(profileId));
  });

  it("is INVARIANT when an equal same-day row arrives from another source", () => {
    const before = getRestingHrSignal(profileId)!;
    // The exact #1615 case: Health Connect 56 bpm + Oura 56 bpm on one date. Both
    // rows persist (#14) — but the day is still ONE observation.
    upsertBodyMetrics(profileId, [{ date: DAYS[3], resting_hr: 56 }], "oura");
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM body_metrics WHERE profile_id = ? AND date = ?"
          )
          .get(profileId, DAYS[3]) as { n: number }
      ).n
    ).toBe(2);

    const after = getRestingHrSignal(profileId)!;
    expect(after).toEqual(before);
    // The old raw-row read would have spent two of its slots on 2026-05-04 and
    // dropped the oldest day out of the baseline; the fold does not.
    expect(after.baseline).toBeCloseTo(52, 10);
    expect(after).toMatchObject(expectedFromSeries(profileId));
  });

  it("uses the same primary source as the Trends daily series when sources disagree", () => {
    const p = newProfile("RHR-FOLD-DISAGREE");
    upsertBodyMetrics(
      p,
      DAYS.map((date, i) => ({ date, resting_hr: HC_BPM[i] })),
      "health-connect"
    );
    // A disagreeing same-day reading from a second source.
    upsertBodyMetrics(p, [{ date: DAYS[3], resting_hr: 70 }], "oura");

    // Default preference puts health-connect ahead of oura.
    expect(getRestingHrSignal(p)!.recent).toBe(56);
    expect(getRestingHrSignal(p)).toMatchObject(expectedFromSeries(p));

    // Configure Oura as the primary source: BOTH surfaces move together.
    setMetricSourcePriorityEntry(p, "resting_hr", "oura");
    expect(getRestingHrSignal(p)!.recent).toBe(70);
    expect(getRestingHrSignal(p)).toMatchObject(expectedFromSeries(p));
  });

  it("returns null when the profile has no resting HR at all", () => {
    expect(getRestingHrSignal(newProfile("RHR-FOLD-EMPTY"))).toBeNull();
  });

  it("computes the baseline spread from distinct dates, not raw rows", () => {
    const p = newProfile("RHR-FOLD-SPREAD");
    upsertBodyMetrics(
      p,
      [
        { date: "2026-06-01", resting_hr: 50 },
        { date: "2026-06-02", resting_hr: 60 },
        { date: "2026-06-03", resting_hr: 55 },
      ],
      "health-connect"
    );
    const before = getRestingHrSignal(p)!;
    // Equal duplicates from another source on every date must not shrink the spread
    // toward zero by doubling each day's contribution.
    upsertBodyMetrics(
      p,
      [
        { date: "2026-06-01", resting_hr: 50 },
        { date: "2026-06-02", resting_hr: 60 },
        { date: "2026-06-03", resting_hr: 55 },
      ],
      "oura"
    );
    expect(getRestingHrSignal(p)).toEqual(before);
    // Prior days are 50 and 60 → mean 55, population SD 5.
    expect(before.baselineSpreadBpm).toBeCloseTo(5, 10);
  });
});
