// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #1118 — main overnight sleep vs naps at read time. A Health Connect
// profile ingests EVERY sleep session unlabeled, and the daily `sleep_min` total
// SUMS them (sleep_min is additive), so an overnight + a same-day nap read as one
// inflated night — masking overnight deprivation in the poor-sleep rest trigger.
// getSleepSignal now reads the MAIN overnight session per night (mainSleepSession)
// instead of that raw sum. SRI (#160) deliberately still sees every session, naps
// included. This suite pins the end-to-end pick over a realistic fixture.
//
// Runs via `npm run test:db` (vitest.db.config.ts). The `db` singleton is pointed
// at a throwaway per-file temp DB by lib/__db_tests__/setup.ts.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";
import {
  getSleepSignal,
  getSleepSessions,
  getMainSleepNightlyMinutes,
  getLastNightSummary,
  getMetricDailyTotals,
} from "@/lib/queries";
import { setTimezone } from "@/lib/settings";

let profileId: number;

// A sleep session as UTC ("Z") instants, so with the profile timezone pinned to
// UTC the wall clock equals the stored instant (hand-checkable wake-days).
const session = (
  metric: string,
  date: string,
  value: number,
  start: string,
  end: string
): NormMetricSample => ({
  metric,
  date,
  start_time: start,
  end_time: end,
  value,
});

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Sleep1118')").run()
      .lastInsertRowid
  );
  setTimezone(profileId, "UTC");

  // Night 1 (wake 2026-02-02): a plain 7h overnight, no nap.
  upsertMetricSamples(
    profileId,
    [
      session(
        "sleep_min",
        "2026-02-02",
        420,
        "2026-02-01T23:00:00Z",
        "2026-02-02T06:00:00Z"
      ),
    ],
    "health-connect"
  );
  // Night 2 (wake 2026-02-03, the LATEST night): a deficient 5h overnight PLUS a
  // 90-min afternoon nap the same wake-day. Raw sleep_min SUMS to 390; the main
  // overnight session is 300.
  upsertMetricSamples(
    profileId,
    [
      session(
        "sleep_min",
        "2026-02-03",
        300,
        "2026-02-02T23:30:00Z",
        "2026-02-03T04:30:00Z"
      ),
      session(
        "sleep_min",
        "2026-02-03",
        90,
        "2026-02-03T14:00:00Z",
        "2026-02-03T15:30:00Z"
      ),
    ],
    "health-connect"
  );
});

describe("getSleepSignal — main overnight session, not the nap-summed total (#1118)", () => {
  it("the raw daily sleep_min total DOES sum the nap into the night (the bug)", () => {
    // Establishes the hazard getSleepSignal must avoid: the additive daily total
    // for the latest wake-day is overnight(300) + nap(90) = 390.
    const totals = getMetricDailyTotals(profileId, "sleep_min").filter(
      (r) => r.date === "2026-02-03"
    );
    expect(totals).toEqual([{ date: "2026-02-03", value: 390 }]);
  });

  it("lastNightMin is the overnight session (300), not the nap-summed 390", () => {
    const signal = getSleepSignal(profileId);
    expect(signal).not.toBeNull();
    expect(signal!.lastNightMin).toBe(300);
    // Baseline is the prior night's main session (420), so the 5h overnight reads
    // as a deficit — which the nap-summed 390 would have masked toward 420.
    expect(signal!.baselineMin).toBe(420);
  });

  it("getMainSleepNightlyMinutes drops the nap and keeps one overnight per night", () => {
    expect(getMainSleepNightlyMinutes(profileId)).toEqual([
      { date: "2026-02-02", value: 420 },
      { date: "2026-02-03", value: 300 },
    ]);
  });

  // Issue #1066: the Sleep-page hero + dashboard tile share getLastNightSummary,
  // which MUST pick the main overnight (not the latest/nap session) for the latest
  // wake-day. This pins the exact defect CI caught in the #1066 branch (the hero
  // rendered the 90-min nap instead of the 300-min night).
  it("getLastNightSummary returns the main overnight (300), with the nap counted separately (#1066)", () => {
    const summary = getLastNightSummary(profileId);
    expect(summary).not.toBeNull();
    expect(summary!.wakeDay).toBe("2026-02-03");
    // The 5h overnight — NOT the 90-min nap that ends later the same wake-day.
    expect(summary!.durationMin).toBe(300);
    // The nap is a separate figure, never folded into durationMin.
    expect(summary!.napMin).toBe(90);
    // Baseline is the prior night's main session (420) → a negative delta.
    expect(summary!.baselineAvgMin).toBe(420);
    expect(summary!.deltaMin).toBe(-120);
  });

  it("SRI's session input KEEPS the nap (naps are never dropped at the source level)", () => {
    // getSleepSessions is the SRI input; the nap window must still be present so
    // computeSleepRegularity counts its asleep epochs (#160). Three sessions total.
    const sessions = getSleepSessions(profileId);
    expect(sessions.length).toBe(3);
    expect(
      sessions.some(
        (s) =>
          s.start === "2026-02-03T14:00:00Z" && s.end === "2026-02-03T15:30:00Z"
      )
    ).toBe(true);
  });
});
