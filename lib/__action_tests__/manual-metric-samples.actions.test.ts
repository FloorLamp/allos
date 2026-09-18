// SERVER-ACTION TIER — manual metric_samples writers after migration 081.
//
// The origin-aware natural key is an expression index over
// (profile, metric, source, COALESCE(origin, ''), started_at). Exercise the manual
// writer against the real migrated schema so a stale explicit UPSERT target cannot
// make the form fail at runtime. Since #1486 there is ONE such form — the combined
// "Log measurements" — so both the growth (height / head circ) and the vitals
// (sleep / HRV) sample paths run through addMeasurements.

import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { addMeasurements } from "@/app/(app)/trends/measurement-actions";
import { getSleepMoodData } from "@/lib/queries";
import { actAs, createLogin, createProfile, fd } from "./harness";

interface SampleRow {
  metric: string;
  origin: string | null;
  started_at: string;
  ended_at: string;
  value: number;
}

function sampleRows(profileId: number): SampleRow[] {
  return db
    .prepare(
      `SELECT metric, origin, started_at, ended_at, value
         FROM metric_samples
        WHERE profile_id = ? AND source = 'manual'
        ORDER BY metric`
    )
    .all(profileId) as SampleRow[];
}

describe("manual metric samples", () => {
  it("inserts and corrects a same-day growth measurement", async () => {
    const login = createLogin();
    const profile = createProfile("Growing child", login.id);
    actAs(login, profile);

    await addMeasurements(
      fd({ date: "2026-07-20", height: "82.5", height_unit: "cm" })
    );
    await addMeasurements(
      fd({ date: "2026-07-20", height: "83", height_unit: "cm" })
    );

    expect(sampleRows(profile.id)).toEqual([
      {
        metric: "height_cm",
        origin: null,
        started_at: "2026-07-20T00:00:00",
        ended_at: "2026-07-20T00:00:00",
        value: 83,
      },
    ]);
  });

  it("inserts and corrects same-day sleep and HRV vitals", async () => {
    const login = createLogin();
    const profile = createProfile("Vitals reader", login.id);
    actAs(login, profile);

    // The profile's own today, not a literal day: getSleepMoodData windows its
    // history to SLEEP_MOOD_HISTORY_DAYS ending at today(profileId), so a fixed
    // day rolls out of the window as the calendar advances (#5973). The samples
    // are filed at that local day's midnight, so the expected instants derive
    // from the same string.
    const day = today(profile.id);
    const dayStart = `${day}T00:00:00`;

    await addMeasurements(fd({ date: day, sleep_hours: "7", hrv: "42" }));
    await addMeasurements(fd({ date: day, sleep_hours: "7.5", hrv: "45" }));

    expect(sampleRows(profile.id)).toEqual([
      {
        metric: "hrv_ms",
        origin: null,
        started_at: dayStart,
        ended_at: dayStart,
        value: 45,
      },
      {
        metric: "sleep_min",
        origin: null,
        started_at: dayStart,
        ended_at: dayStart,
        value: 450,
      },
    ]);
    expect(
      getSleepMoodData(profile.id).history.find((row) => row.date === day)
    ).toMatchObject({
      sleepHours: 7.5,
      sleepEditable: true,
      sleepEditHours: 7.5,
    });
  });
});
