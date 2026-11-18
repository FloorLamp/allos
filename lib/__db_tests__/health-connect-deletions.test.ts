// DB INTEGRATION TIER — Health Connect deletions (FP-9634). A push's `deleted` list
// names Health Connect record ids; each record that stated `metadata.id` earlier is
// removed from the store it landed in, and a replay changes nothing more.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";
import { ingestHealthConnectPayload } from "@/lib/integrations/health-connect-ingest";

const TZ = "UTC";

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, TZ);
  return id;
}

function push(profileId: number, body: object, cgmConnection = false) {
  return ingestHealthConnectPayload(
    profileId,
    parseHealthConnectPayload(body, TZ, { cgmConnection })
  );
}

const meta = (id: string) => ({ metadata: { id } });

function count(sql: string, ...args: unknown[]): number {
  return (db.prepare(sql).get(...args) as { n: number }).n;
}

const samples = (profileId: number, metric: string) =>
  count(
    "SELECT COUNT(*) AS n FROM metric_samples WHERE profile_id = ? AND metric = ?",
    profileId,
    metric
  );

describe("Health Connect deletions (FP-9634)", () => {
  it("removes metric samples: an interval, a point and a sleep session with its stages", () => {
    const p = newProfile("HC-DEL-SAMPLES");
    push(p, {
      steps: [
        {
          ...meta("steps-1"),
          count: 1200,
          start_time: "2026-06-01T08:00:00Z",
          end_time: "2026-06-01T09:00:00Z",
        },
        {
          ...meta("steps-2"),
          count: 800,
          start_time: "2026-06-01T10:00:00Z",
          end_time: "2026-06-01T11:00:00Z",
        },
      ],
      heart_rate_variability: [
        { ...meta("hrv-1"), time: "2026-06-01T07:00:00Z", rmssd_millis: 42 },
      ],
      sleep: [
        {
          ...meta("sleep-1"),
          start_time: "2026-05-31T23:00:00Z",
          end_time: "2026-06-01T07:00:00Z",
          stages: [
            {
              stage: "deep",
              start_time: "2026-05-31T23:00:00Z",
              end_time: "2026-06-01T01:00:00Z",
            },
            {
              stage: "rem",
              start_time: "2026-06-01T01:00:00Z",
              end_time: "2026-06-01T07:00:00Z",
            },
          ],
        },
      ],
    });
    expect(samples(p, "steps")).toBe(2);
    expect(samples(p, "sleep_deep_min")).toBe(1);

    const res = push(p, { deleted: ["steps-1", "hrv-1", "sleep-1"] });
    expect(res.deletions).toEqual({
      records: 3,
      unmatched: 0,
      removed: 5,
      edited: 0,
    });
    expect(res.split.superseded).toBe(5);
    expect(samples(p, "steps")).toBe(1);
    expect(samples(p, "hrv_ms")).toBe(0);
    expect(samples(p, "sleep_min")).toBe(0);
    expect(samples(p, "sleep_deep_min")).toBe(0);
    expect(samples(p, "sleep_rem_min")).toBe(0);
  });

  it("clears the body measure the deleted record reports, and the row once empty", () => {
    const p = newProfile("HC-DEL-BODY");
    push(p, {
      weight: [
        { ...meta("w-1"), time: "2026-06-01T07:00:00Z", kilograms: 70 },
        { ...meta("w-2"), time: "2026-06-02T07:00:00Z", kilograms: 71 },
      ],
      resting_heart_rate: [
        { ...meta("rhr-1"), time: "2026-06-01T06:00:00Z", bpm: 55 },
      ],
    });
    const row = (date: string) =>
      db
        .prepare(
          "SELECT weight_kg, weight_at, resting_hr FROM body_metrics WHERE profile_id = ? AND date = ?"
        )
        .get(p, date) as
        | {
            weight_kg: number | null;
            weight_at: string | null;
            resting_hr: number | null;
          }
        | undefined;

    const res = push(p, { deleted: ["w-1", "w-2"] });
    expect(res.deletions.removed).toBe(2);
    expect(row("2026-06-01")).toEqual({
      weight_kg: null,
      weight_at: null,
      resting_hr: 55,
    });
    expect(row("2026-06-02")).toBeUndefined();
  });

  it("keeps a weight a later reading of the day replaced", () => {
    const p = newProfile("HC-DEL-BODY-LATER");
    push(p, {
      weight: [
        { ...meta("w-early"), time: "2026-06-01T07:00:00Z", kilograms: 70 },
        { ...meta("w-late"), time: "2026-06-01T19:00:00Z", kilograms: 71 },
      ],
    });
    const res = push(p, { deleted: ["w-early"] });
    expect(res.deletions).toMatchObject({ records: 1, removed: 0 });
    expect(
      count(
        "SELECT COUNT(*) AS n FROM body_metrics WHERE profile_id = ? AND weight_kg = 71",
        p
      )
    ).toBe(1);
  });

  it("removes clinical readings: both blood-pressure analytes and a spot vital", () => {
    const p = newProfile("HC-DEL-VITALS");
    push(p, {
      blood_pressure: [
        {
          ...meta("bp-1"),
          time: "2026-06-01T08:00:00Z",
          systolic: 120,
          diastolic: 80,
        },
      ],
      oxygen_saturation: [
        { ...meta("spo2-1"), time: "2026-06-01T08:05:00Z", percentage: 97 },
      ],
    });
    const vitals = () =>
      count(
        "SELECT COUNT(*) AS n FROM medical_records WHERE profile_id = ?",
        p
      );
    expect(vitals()).toBe(3);
    const res = push(p, { deleted: ["bp-1", "spo2-1"] });
    expect(res.deletions.removed).toBe(3);
    expect(vitals()).toBe(0);
    // Not tombstoned: the phone re-writing the reading lands it again.
    push(p, {
      oxygen_saturation: [
        { ...meta("spo2-2"), time: "2026-06-01T08:05:00Z", percentage: 97 },
      ],
    });
    expect(vitals()).toBe(1);
  });

  it("removes an exercise session", () => {
    const p = newProfile("HC-DEL-EXERCISE");
    push(p, {
      exercise: [
        {
          ...meta("ex-1"),
          type: "RUNNING",
          start_time: "2026-06-01T06:00:00Z",
          end_time: "2026-06-01T06:30:00Z",
        },
      ],
    });
    const activities = () =>
      count("SELECT COUNT(*) AS n FROM activities WHERE profile_id = ?", p);
    expect(activities()).toBe(1);
    push(p, { deleted: ["ex-1"] });
    expect(activities()).toBe(0);
  });

  it("removes a heart-rate record's minutes and leaves the others", () => {
    const p = newProfile("HC-DEL-HR");
    push(p, {
      heart_rate: [
        { ...meta("hr-1"), time: "2026-06-01T08:00:10Z", bpm: 70 },
        { ...meta("hr-1"), time: "2026-06-01T08:02:10Z", bpm: 72 },
        { ...meta("hr-2"), time: "2026-06-01T09:00:10Z", bpm: 65 },
      ],
    });
    const minutes = () =>
      count("SELECT COUNT(*) AS n FROM hr_minutes WHERE profile_id = ?", p);
    expect(minutes()).toBe(3);
    push(p, { deleted: ["hr-1"] });
    expect(minutes()).toBe(1);
  });

  it("removes a CGM point and re-derives its day", () => {
    const p = newProfile("HC-DEL-CGM");
    const reading = (id: string, time: string, mmol: number) => ({
      ...meta(id),
      time,
      mmol_per_liter: mmol,
      metadata: { id, data_origin: "com.dexcom.g7" },
    });
    push(
      p,
      {
        blood_glucose: [
          reading("g-1", "2026-06-01T08:00:00Z", 5.5),
          reading("g-2", "2026-06-01T08:05:00Z", 6.0),
        ],
      },
      true
    );
    const points = () =>
      count("SELECT COUNT(*) AS n FROM glucose_trace WHERE profile_id = ?", p);
    const derivedPoints = () =>
      (
        db
          .prepare(
            "SELECT value FROM metric_samples WHERE profile_id = ? AND metric = 'glucose_trace_points'"
          )
          .get(p) as { value: number } | undefined
      )?.value;
    expect(points()).toBe(2);
    expect(derivedPoints()).toBe(2);
    push(p, { deleted: ["g-1"] }, true);
    expect(points()).toBe(1);
    expect(derivedPoints()).toBe(1);
    push(p, { deleted: ["g-2"] }, true);
    expect(points()).toBe(0);
    expect(derivedPoints()).toBeUndefined();
  });

  it("is idempotent: a replayed deletion and an unknown id change nothing", () => {
    const p = newProfile("HC-DEL-REPLAY");
    const body = {
      steps: [
        {
          ...meta("steps-a"),
          count: 100,
          start_time: "2026-06-01T08:00:00Z",
          end_time: "2026-06-01T09:00:00Z",
        },
        {
          ...meta("steps-b"),
          count: 200,
          start_time: "2026-06-01T10:00:00Z",
          end_time: "2026-06-01T11:00:00Z",
        },
      ],
    };
    push(p, body);
    // A push carrying a record and its deletion ends deleted, however often replayed.
    const del = { ...body, steps: [body.steps[0]], deleted: ["steps-a"] };
    for (let i = 0; i < 2; i++) {
      push(p, del);
      expect(samples(p, "steps")).toBe(1);
    }
    const replay = push(p, { deleted: ["steps-a", "never-seen"] });
    expect(replay.deletions).toEqual({
      records: 0,
      unmatched: 2,
      removed: 0,
      edited: 0,
    });
    expect(samples(p, "steps")).toBe(1);
  });

  it("keeps a hand-edited row", () => {
    const p = newProfile("HC-DEL-EDITED");
    push(p, {
      steps: [
        {
          ...meta("steps-e"),
          count: 100,
          start_time: "2026-06-01T08:00:00Z",
          end_time: "2026-06-01T09:00:00Z",
        },
      ],
    });
    db.prepare(
      "UPDATE metric_samples SET edited = 1 WHERE profile_id = ? AND metric = 'steps'"
    ).run(p);
    const res = push(p, { deleted: ["steps-e"] });
    expect(res.deletions).toMatchObject({ records: 1, removed: 0, edited: 1 });
    expect(samples(p, "steps")).toBe(1);
  });

  it("does not count deleted ids as skipped records", () => {
    const parsed = parseHealthConnectPayload({ deleted: ["a", "b", 3] }, TZ);
    expect(parsed.deleted).toEqual(["a", "b"]);
    expect(parsed.skipped).toBe(1);
  });
});
