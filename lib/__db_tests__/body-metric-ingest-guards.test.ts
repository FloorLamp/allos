// DB INTEGRATION TIER — the body-metric ingest guards (#605, #606).
//
// #605: multiple same-day readings in ONE batch must collapse to a single
// (profile_id, date, source) row deterministically (latest reading wins), so a
// two-weigh-in day no longer flip-flops the stored value and churns "N changed"
// every re-scan.
// #606: the oldest day of a multi-day Health Connect window is only partially
// covered; its body-fat / resting-HR day-average must NOT overwrite the fuller value
// stored when the day was wholly in the window (the partial_day guard on upsert).
//
// Runs against the real schema via vitest.db.config.ts.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  upsertBodyMetrics,
  type NormBodyMetric,
} from "@/lib/integrations/normalize";

const WITHINGS = "withings";
const HC = "health-connect";
let profileId: number;

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('INGEST-GUARDS')").run()
      .lastInsertRowid
  );
});

function storedRow(date: string, source: string) {
  return db
    .prepare(
      "SELECT weight_kg, body_fat_pct, resting_hr FROM body_metrics WHERE profile_id = ? AND date = ? AND source IS ?"
    )
    .get(profileId, date, source) as
    | {
        weight_kg: number | null;
        body_fat_pct: number | null;
        resting_hr: number | null;
      }
    | undefined;
}

describe("upsertBodyMetrics collapses same-day readings deterministically (#605)", () => {
  const early: NormBodyMetric = {
    date: "2024-07-01",
    measured_at: "2024-07-01T07:00:00Z",
    weight_kg: 75.4,
  };
  const late: NormBodyMetric = {
    date: "2024-07-01",
    measured_at: "2024-07-01T22:00:00Z",
    weight_kg: 76.1,
  };

  it("writes ONE row (latest reading wins) and re-running the batch is all-unchanged", () => {
    // Two same-day readings in one batch → exactly one insert, storing the latest.
    expect(upsertBodyMetrics(profileId, [late, early], WITHINGS)).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
      suppressed: 0,
      edited: 0,
    });
    expect(storedRow("2024-07-01", WITHINGS)?.weight_kg).toBe(76.1);
    // Re-sending the SAME batch (either order) is a no-op — no perpetual churn.
    expect(upsertBodyMetrics(profileId, [early, late], WITHINGS)).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 1,
      suppressed: 0,
      edited: 0,
    });
    expect(upsertBodyMetrics(profileId, [late, early], WITHINGS)).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 1,
      suppressed: 0,
      edited: 0,
    });
    expect(storedRow("2024-07-01", WITHINGS)?.weight_kg).toBe(76.1);
  });

  it("is order-independent: reversed batch on a fresh key yields the same value", () => {
    const a: NormBodyMetric = {
      date: "2024-07-02",
      measured_at: "2024-07-02T08:00:00Z",
      resting_hr: 55,
    };
    const b: NormBodyMetric = {
      date: "2024-07-02",
      measured_at: "2024-07-02T21:00:00Z",
      resting_hr: 61,
    };
    // Provider returned newest-first (b, a) — the latest (b) still wins.
    expect(upsertBodyMetrics(profileId, [b, a], WITHINGS).inserted).toBe(1);
    expect(storedRow("2024-07-02", WITHINGS)?.resting_hr).toBe(61);
  });
});

describe("upsertBodyMetrics partial-window guard (#606)", () => {
  it("a partial-day tail does not overwrite a stored full-day average", () => {
    // The day was fully covered on an earlier push → stored average 58.
    expect(
      upsertBodyMetrics(profileId, [{ date: "2024-07-10", resting_hr: 58 }], HC)
        .inserted
    ).toBe(1);
    // Two days later this day is the OLDEST in the window → partial, carrying only its
    // last sample (66). The guard keeps the stored 58 — no overwrite, counted unchanged.
    expect(
      upsertBodyMetrics(
        profileId,
        [{ date: "2024-07-10", resting_hr: 66, partial_day: true }],
        HC
      )
    ).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 1,
      suppressed: 0,
      edited: 0,
    });
    expect(storedRow("2024-07-10", HC)?.resting_hr).toBe(58);
  });

  it("a fully-covering re-push (not partial) still overwrites with the new value", () => {
    expect(
      upsertBodyMetrics(
        profileId,
        [{ date: "2024-07-11", resting_hr: 58, body_fat_pct: 20 }],
        HC
      ).inserted
    ).toBe(1);
    // Same day, fully covered again, corrected average → overwrites.
    expect(
      upsertBodyMetrics(
        profileId,
        [{ date: "2024-07-11", resting_hr: 60, body_fat_pct: 19 }],
        HC
      )
    ).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 0,
      suppressed: 0,
      edited: 0,
    });
    expect(storedRow("2024-07-11", HC)).toMatchObject({
      resting_hr: 60,
      body_fat_pct: 19,
    });
  });

  it("a partial day still FILLS a gap the stored row lacks", () => {
    expect(
      upsertBodyMetrics(profileId, [{ date: "2024-07-12", weight_kg: 80 }], HC)
        .inserted
    ).toBe(1);
    // Partial tail adds a resting HR the stored row didn't have → filled (not blocked).
    expect(
      upsertBodyMetrics(
        profileId,
        [{ date: "2024-07-12", resting_hr: 57, partial_day: true }],
        HC
      ).updated
    ).toBe(1);
    expect(storedRow("2024-07-12", HC)).toMatchObject({
      weight_kg: 80,
      resting_hr: 57,
    });
  });
});
