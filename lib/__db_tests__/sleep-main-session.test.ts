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
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
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
  getSleepMoodData,
  getSleepRegularity,
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

  it("uses reported asleep minutes when they are shorter than the bedtime window", () => {
    upsertMetricSamples(
      profileId,
      [
        session(
          "sleep_min",
          "2026-02-04",
          270,
          "2026-02-03T23:00:00Z",
          "2026-02-04T04:00:00Z"
        ),
      ],
      "health-connect"
    );
    const summary = getLastNightSummary(profileId)!;
    expect(summary.durationMin).toBe(270); // 4h30 asleep, not the 5h window
    expect(summary.bedMinutes).toBe(23 * 60);
    expect(summary.wakeMinutes).toBe(4 * 60);
  });
});

describe("duration-only manual sleep", () => {
  it("surfaces a manual daily amount without inventing bed/wake clocks", () => {
    const manualProfileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('ManualSleep')").run()
        .lastInsertRowid
    );
    setTimezone(manualProfileId, "UTC");
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'manual', 'sleep_min', '2026-02-03',
               '2026-02-03T00:00:00', '2026-02-03T00:00:00', 450)`
    ).run(manualProfileId);

    expect(getLastNightSummary(manualProfileId)).toMatchObject({
      wakeDay: "2026-02-03",
      durationMin: 450,
      bedMinutes: null,
      wakeMinutes: null,
      source: "manual",
    });
  });

  it("does not replace a synced timing stream with a newer duration-only row", () => {
    const mixedProfileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('MixedSleep')").run()
        .lastInsertRowid
    );
    setTimezone(mixedProfileId, "UTC");
    for (let day = 1; day <= 14; day++) {
      const wakeDay = `2026-04-${String(day + 1).padStart(2, "0")}`;
      const bedDay = `2026-04-${String(day).padStart(2, "0")}`;
      upsertMetricSamples(
        mixedProfileId,
        [
          session(
            "sleep_min",
            wakeDay,
            480,
            `${bedDay}T23:00:00Z`,
            `${wakeDay}T07:00:00Z`
          ),
        ],
        "oura"
      );
    }
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'manual', 'sleep_min', '2026-04-16',
               '2026-04-16T00:00:00', '2026-04-16T00:00:00', 450)`
    ).run(mixedProfileId);

    expect(getSleepSessions(mixedProfileId)).toHaveLength(14);
    expect(
      getSleepSessions(mixedProfileId).every((row) => row.source === "oura")
    ).toBe(true);
    expect(getSleepRegularity(mixedProfileId)).not.toBeNull();
    expect(getLastNightSummary(mixedProfileId)).toMatchObject({
      wakeDay: "2026-04-16",
      durationMin: 450,
      bedMinutes: null,
    });
  });

  it("uses nap-free main sessions for a newer manual row's baseline", () => {
    const baselineProfileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('ManualBaseline')").run()
        .lastInsertRowid
    );
    setTimezone(baselineProfileId, "UTC");
    upsertMetricSamples(
      baselineProfileId,
      [
        session(
          "sleep_min",
          "2026-05-02",
          420,
          "2026-05-01T23:00:00Z",
          "2026-05-02T06:00:00Z"
        ),
        session(
          "sleep_min",
          "2026-05-03",
          300,
          "2026-05-02T23:30:00Z",
          "2026-05-03T04:30:00Z"
        ),
        session(
          "sleep_min",
          "2026-05-03",
          90,
          "2026-05-03T14:00:00Z",
          "2026-05-03T15:30:00Z"
        ),
      ],
      "health-connect"
    );
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'manual', 'sleep_min', '2026-05-04',
               '2026-05-04T00:00:00', '2026-05-04T00:00:00', 450)`
    ).run(baselineProfileId);

    expect(getLastNightSummary(baselineProfileId)).toMatchObject({
      wakeDay: "2026-05-04",
      durationMin: 450,
      baselineAvgMin: 360,
      deltaMin: 90,
      baselineNights: 2,
    });
  });

  it("keeps a duration-only row read-only beside a timed manual window", () => {
    const mixedManualId = Number(
      db
        .prepare("INSERT INTO profiles (name) VALUES ('MixedManualSleep')")
        .run().lastInsertRowid
    );
    setTimezone(mixedManualId, "UTC");
    const wakeDay = today(mixedManualId);
    const bedDay = shiftDateStr(wakeDay, -1);
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'manual', 'sleep_min', ?, ?, ?, 420),
              (?, 'manual', 'sleep_min', ?, ?, ?, 360)`
    ).run(
      mixedManualId,
      wakeDay,
      `${bedDay}T23:00:00Z`,
      `${wakeDay}T06:00:00Z`,
      mixedManualId,
      wakeDay,
      `${wakeDay}T00:00:00`,
      `${wakeDay}T00:00:00`
    );

    expect(
      getSleepMoodData(mixedManualId, 7).history.find(
        (row) => row.date === wakeDay
      )
    ).toMatchObject({
      sleepHours: 7,
      sleepEditable: false,
      sleepEditHours: null,
    });
  });
});

describe("bedtime supplements on the Sleep page", () => {
  it("joins due supplement doses to the actual sleep-start day", () => {
    const bedtimeProfileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('BedtimeSleep')").run()
        .lastInsertRowid
    );
    setTimezone(bedtimeProfileId, "UTC");
    const wakeDay = today(bedtimeProfileId);
    const sleepDate = shiftDateStr(wakeDay, -1);
    upsertMetricSamples(
      bedtimeProfileId,
      [
        session(
          "sleep_min",
          wakeDay,
          420,
          `${sleepDate}T23:00:00Z`,
          `${wakeDay}T06:00:00Z`
        ),
      ],
      "health-connect"
    );

    const insertItem = db.prepare(
      `INSERT INTO intake_items
         (profile_id, name, active, kind, condition, priority, as_needed, created_at)
       VALUES (?, ?, 1, ?, 'daily', 'high', 0, ?)`
    );
    const createdAt = `${shiftDateStr(sleepDate, -7)} 00:00:00`;
    const magnesiumId = Number(
      insertItem.run(bedtimeProfileId, "Magnesium", "supplement", createdAt)
        .lastInsertRowid
    );
    const glycineId = Number(
      insertItem.run(bedtimeProfileId, "Glycine", "supplement", createdAt)
        .lastInsertRowid
    );
    const morningId = Number(
      insertItem.run(bedtimeProfileId, "Vitamin D", "supplement", createdAt)
        .lastInsertRowid
    );
    const medicationId = Number(
      insertItem.run(
        bedtimeProfileId,
        "Prescription sleep aid",
        "medication",
        createdAt
      ).lastInsertRowid
    );
    const insertDose = db.prepare(
      `INSERT INTO intake_item_doses
         (item_id, amount, time_of_day, food_timing, sort, created_at)
       VALUES (?, '1 cap', ?, 'any', 0, ?)`
    );
    const magnesiumDoseId = Number(
      insertDose.run(magnesiumId, "Before sleep", createdAt).lastInsertRowid
    );
    const glycineDoseId = Number(
      insertDose.run(glycineId, "bedtime", createdAt).lastInsertRowid
    );
    insertDose.run(morningId, "Morning", createdAt);
    insertDose.run(medicationId, "Before sleep", createdAt);

    const insertLog = db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status)
       VALUES (?, ?, ?, 'taken')`
    );
    // Magnesium was taken before the session. Glycine has a misleading wake-day
    // log: it must remain missing for this night because the session began on the
    // prior profile-local date.
    insertLog.run(magnesiumDoseId, magnesiumId, sleepDate);
    insertLog.run(glycineDoseId, glycineId, wakeDay);

    const row = getSleepMoodData(bedtimeProfileId, 7).history.find(
      (entry) => entry.date === wakeDay
    );
    expect(row?.bedtimeSupplements).toMatchObject({
      sleepDate,
      due: 2,
      taken: 1,
      skipped: 0,
      state: "partial",
      items: [
        { name: "Magnesium", state: "taken" },
        { name: "Glycine", state: "missed" },
      ],
    });
  });

  it("keeps supplement context for every wake-day when nights include naps", () => {
    const historyProfileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('BedtimeHistory')").run()
        .lastInsertRowid
    );
    setTimezone(historyProfileId, "UTC");
    const end = today(historyProfileId);
    const oldestWakeDay = shiftDateStr(end, -59);
    const oldestSleepDate = shiftDateStr(oldestWakeDay, -1);
    const samples: NormMetricSample[] = [];
    for (let offset = 59; offset >= 0; offset--) {
      const wakeDay = shiftDateStr(end, -offset);
      const sleepDate = shiftDateStr(wakeDay, -1);
      samples.push(
        session(
          "sleep_min",
          wakeDay,
          420,
          `${sleepDate}T23:00:00Z`,
          `${wakeDay}T06:00:00Z`
        ),
        session(
          "sleep_min",
          wakeDay,
          30,
          `${wakeDay}T14:00:00Z`,
          `${wakeDay}T14:30:00Z`
        )
      );
    }
    upsertMetricSamples(historyProfileId, samples, "health-connect");
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, priority, as_needed, created_at)
           VALUES (?, 'Magnesium', 1, 'supplement', 'daily', 'high', 0, ?)`
        )
        .run(historyProfileId, `${shiftDateStr(oldestSleepDate, -1)} 00:00:00`)
        .lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses
             (item_id, amount, time_of_day, food_timing, sort, created_at)
           VALUES (?, '1 cap', 'Before sleep', 'any', 0, ?)`
        )
        .run(itemId, `${shiftDateStr(oldestSleepDate, -1)} 00:00:00`)
        .lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status)
       VALUES (?, ?, ?, 'taken')`
    ).run(doseId, itemId, oldestSleepDate);

    const oldest = getSleepMoodData(historyProfileId, 60).history.find(
      (row) => row.date === oldestWakeDay
    );
    expect(oldest?.bedtimeSupplements).toMatchObject({
      due: 1,
      taken: 1,
      state: "taken",
    });
  });

  it("preserves resolved bedtime logs after retirement or pause without inventing a retimed slot", () => {
    const historyProfileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('ChangedBedtime')").run()
        .lastInsertRowid
    );
    setTimezone(historyProfileId, "UTC");
    const wakeDay = today(historyProfileId);
    const sleepDate = shiftDateStr(wakeDay, -1);
    upsertMetricSamples(
      historyProfileId,
      [
        session(
          "sleep_min",
          wakeDay,
          420,
          `${sleepDate}T23:00:00Z`,
          `${wakeDay}T06:00:00Z`
        ),
      ],
      "health-connect"
    );
    const insertItem = db.prepare(
      `INSERT INTO intake_items
         (profile_id, name, active, kind, condition, priority, as_needed, created_at)
       VALUES (?, ?, ?, 'supplement', 'daily', 'high', 0, ?)`
    );
    const createdAt = `${shiftDateStr(sleepDate, -7)} 00:00:00`;
    const pausedId = Number(
      insertItem.run(historyProfileId, "Paused", 0, createdAt).lastInsertRowid
    );
    const retiredId = Number(
      insertItem.run(historyProfileId, "Retired", 1, createdAt).lastInsertRowid
    );
    const retimedId = Number(
      insertItem.run(historyProfileId, "Retimed", 1, createdAt).lastInsertRowid
    );
    const retimedToBedId = Number(
      insertItem.run(historyProfileId, "Retimed to bed", 1, createdAt)
        .lastInsertRowid
    );
    const insertDose = db.prepare(
      `INSERT INTO intake_item_doses
         (item_id, amount, time_of_day, food_timing, sort, retired, created_at, updated_at)
       VALUES (?, '1 cap', ?, 'any', 0, ?, ?, ?)`
    );
    const pausedDose = Number(
      insertDose.run(pausedId, "Before sleep", 0, createdAt, null)
        .lastInsertRowid
    );
    const retiredDose = Number(
      insertDose.run(retiredId, "Before sleep", 1, createdAt, null)
        .lastInsertRowid
    );
    const retimedDose = Number(
      insertDose.run(retimedId, "Morning", 0, createdAt, `${wakeDay} 12:00:00`)
        .lastInsertRowid
    );
    const retimedToBedDose = Number(
      insertDose.run(
        retimedToBedId,
        "Before sleep",
        0,
        createdAt,
        `${wakeDay} 12:00:00`
      ).lastInsertRowid
    );
    const insertLog = db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status)
       VALUES (?, ?, ?, ?)`
    );
    insertLog.run(pausedDose, pausedId, sleepDate, "taken");
    insertLog.run(retiredDose, retiredId, sleepDate, "skipped");
    insertLog.run(retimedDose, retimedId, sleepDate, "taken");
    insertLog.run(retimedToBedDose, retimedToBedId, sleepDate, "taken");

    expect(
      getSleepMoodData(historyProfileId, 7).history.find(
        (row) => row.date === wakeDay
      )?.bedtimeSupplements
    ).toMatchObject({
      due: 2,
      taken: 1,
      skipped: 1,
      state: "partial",
    });
  });
});
