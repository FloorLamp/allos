// SERVER-ACTION TIER — manual metric_samples writers after migration 081.
//
// The origin-aware natural key is an expression index over
// (profile, metric, source, COALESCE(origin, ''), start_time). Exercise both
// manual writers against the real migrated schema so a stale explicit UPSERT
// target cannot make the forms fail at runtime.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { addGrowth } from "@/app/(app)/trends/growth-actions";
import { addVitals } from "@/app/(app)/trends/vitals-actions";
import { getSleepMoodData } from "@/lib/queries";
import { actAs, createLogin, createProfile, fd } from "./harness";

interface SampleRow {
  metric: string;
  origin: string | null;
  start_time: string;
  end_time: string;
  value: number;
}

function sampleRows(profileId: number): SampleRow[] {
  return db
    .prepare(
      `SELECT metric, origin, start_time, end_time, value
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

    await addGrowth(
      fd({ date: "2026-07-20", height: "82.5", height_unit: "cm" })
    );
    await addGrowth(
      fd({ date: "2026-07-20", height: "83", height_unit: "cm" })
    );

    expect(sampleRows(profile.id)).toEqual([
      {
        metric: "height_cm",
        origin: null,
        start_time: "2026-07-20T00:00:00",
        end_time: "2026-07-20T00:00:00",
        value: 83,
      },
    ]);
  });

  it("inserts and corrects same-day sleep and HRV vitals", async () => {
    const login = createLogin();
    const profile = createProfile("Vitals reader", login.id);
    actAs(login, profile);

    await addVitals(fd({ date: "2026-07-20", sleep_hours: "7", hrv: "42" }));
    await addVitals(fd({ date: "2026-07-20", sleep_hours: "7.5", hrv: "45" }));

    expect(sampleRows(profile.id)).toEqual([
      {
        metric: "hrv_ms",
        origin: null,
        start_time: "2026-07-20T00:00:00",
        end_time: "2026-07-20T00:00:00",
        value: 45,
      },
      {
        metric: "sleep_min",
        origin: null,
        start_time: "2026-07-20T00:00:00",
        end_time: "2026-07-20T00:00:00",
        value: 450,
      },
    ]);
    expect(
      getSleepMoodData(profile.id).history.find(
        (row) => row.date === "2026-07-20"
      )
    ).toMatchObject({
      sleepHours: 7.5,
      sleepEditable: true,
      sleepEditHours: 7.5,
    });
  });
});
