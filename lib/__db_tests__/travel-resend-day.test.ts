// DB INTEGRATION TIER — the WRITE-SIDE half of #3428: a re-sent row keeps the day it
// was attributed to.
//
// WHAT IS BEING GUARDED. `metric_samples.date` is a profile-local day derived at ingest
// under `getTimezone(profileId)`. The natural key omits `date`, so the Health Connect
// exporter's rolling window — which re-sends a sleep session on EVERY push for 48 h,
// not only on change — used to re-derive that day under whatever zone the profile holds
// NOW. Measured on prod (#3428, owner 2026-08-23T05:42:56Z): a hand repair of the 08-21
// night was undone by the next push six minutes later, and would have been undone again
// on every push until the window moved past the session.
//
// WHY THE RE-SEND IS THE TEST. A repair the next push undoes is not a fix, so every case
// here pushes the SAME session again after the switch, and twice, rather than asserting
// on a single ingest.
//
// WEST AND EAST ARE SEPARATE CASES on purpose. A fixed-sign error passes one and fails
// the other, and every instant here is chosen so the UTC day and the profile-local day
// differ — a night that ends 2026-05-02T06:30Z is UTC May 2, New York May 2, but Tokyo
// May 2 15:30 and Honolulu May 1 20:30.
//
// SYNTHETIC ONLY: fictional profiles, invented sleep minutes, no PHI.

import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";
import { ingestHealthConnectPayload } from "@/lib/integrations/health-connect-ingest";
import { getMetricDailyTotals } from "@/lib/queries";
import {
  getTimezone,
  setTimezone,
  switchProfileTimezone,
} from "@/lib/settings";

const NEW_YORK = "America/New_York";
const HONOLULU = "Pacific/Honolulu";
const TOKYO = "Asia/Tokyo";
const ORIGIN = "com.fitbit.FitbitMobile";

// The night every case re-sends: 2026-05-01T22:00Z → 2026-05-02T06:30Z, 510 minutes.
// Wake-day by zone: New York 2026-05-02 (02:30), Tokyo 2026-05-02 (15:30),
// Honolulu 2026-05-01 (20:30).
const NIGHT_START = "2026-05-01T22:00:00Z";
const NIGHT_END = "2026-05-02T06:30:00Z";
const NIGHT_MIN = 510;

function freeze(instant: string): void {
  process.env.ALLOS_TEST_NOW = instant;
}

afterEach(() => {
  delete process.env.ALLOS_TEST_NOW;
});

function newProfile(name: string, tz: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, tz);
  return id;
}

/** One push carrying the night, plus any extra sleep sessions given. */
function pushSleep(
  profileId: number,
  stamp: string,
  sessions: { start: string; end: string; seconds: number }[]
): void {
  ingestHealthConnectPayload(
    profileId,
    parseHealthConnectPayload(
      {
        timestamp: stamp,
        sleep: sessions.map((s) => ({
          start_time: s.start,
          end_time: s.end,
          duration_seconds: s.seconds,
          metadata: { data_origin: ORIGIN },
        })),
      },
      getTimezone(profileId)
    )
  );
}

const NIGHT = {
  start: NIGHT_START,
  end: NIGHT_END,
  seconds: NIGHT_MIN * 60,
};

function sleepRows(
  profileId: number
): { date: string; started_at: string; value: number }[] {
  return db
    .prepare(
      `SELECT date, started_at, value FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min' ORDER BY started_at`
    )
    .all(profileId) as {
    date: string;
    started_at: string;
    value: number;
  }[];
}

describe("a re-sent row keeps the day it was attributed to (#3428, write side)", () => {
  it("WESTWARD: New York → Honolulu, the night keeps its New York wake-day across two re-sends", () => {
    const profileId = newProfile("Resend West", NEW_YORK);
    freeze("2026-05-02T07:00:00Z");
    pushSleep(profileId, "2026-05-02T07:00:05Z", [NIGHT]);
    expect(sleepRows(profileId)).toEqual([
      { date: "2026-05-02", started_at: NIGHT_START, value: NIGHT_MIN },
    ]);

    // The traveller flies to Honolulu. Under Honolulu the same wake instant is
    // 2026-05-01 20:30 — a DIFFERENT calendar day, which is the whole bug.
    freeze("2026-05-02T08:00:00Z");
    switchProfileTimezone(profileId, HONOLULU, NEW_YORK);

    // The rolling window re-sends the very same session. On `main` this moved all of
    // its rows to 2026-05-01.
    freeze("2026-05-02T09:00:00Z");
    pushSleep(profileId, "2026-05-02T09:00:05Z", [NIGHT]);
    expect(sleepRows(profileId)).toEqual([
      { date: "2026-05-02", started_at: NIGHT_START, value: NIGHT_MIN },
    ]);

    // AND AGAIN, because the exporter sends on every push for 48 hours — a repair that
    // only survives one push is not a repair.
    freeze("2026-05-02T10:00:00Z");
    pushSleep(profileId, "2026-05-02T10:00:05Z", [NIGHT]);
    expect(sleepRows(profileId)).toEqual([
      { date: "2026-05-02", started_at: NIGHT_START, value: NIGHT_MIN },
    ]);

    // The night is on ONE day, and it is the day it was slept into.
    const totals = getMetricDailyTotals(profileId, "sleep_min");
    expect(totals).toEqual([{ date: "2026-05-02", value: NIGHT_MIN }]);
  });

  it("EASTWARD: Honolulu → Tokyo, the night keeps its Honolulu wake-day across two re-sends", () => {
    const profileId = newProfile("Resend East", HONOLULU);
    freeze("2026-05-02T07:00:00Z");
    pushSleep(profileId, "2026-05-02T07:00:05Z", [NIGHT]);
    expect(sleepRows(profileId)).toEqual([
      { date: "2026-05-01", started_at: NIGHT_START, value: NIGHT_MIN },
    ]);

    freeze("2026-05-02T08:00:00Z");
    switchProfileTimezone(profileId, TOKYO, HONOLULU);

    freeze("2026-05-02T09:00:00Z");
    pushSleep(profileId, "2026-05-02T09:00:05Z", [NIGHT]);
    expect(sleepRows(profileId)).toEqual([
      { date: "2026-05-01", started_at: NIGHT_START, value: NIGHT_MIN },
    ]);

    freeze("2026-05-02T10:00:00Z");
    pushSleep(profileId, "2026-05-02T10:00:05Z", [NIGHT]);
    expect(sleepRows(profileId)).toEqual([
      { date: "2026-05-01", started_at: NIGHT_START, value: NIGHT_MIN },
    ]);
  });

  it("a night that arrives for the FIRST time after the switch buckets under the new zone", () => {
    const profileId = newProfile("Resend New Row", NEW_YORK);
    freeze("2026-05-02T07:00:00Z");
    pushSleep(profileId, "2026-05-02T07:00:05Z", [NIGHT]);

    freeze("2026-05-02T08:00:00Z");
    switchProfileTimezone(profileId, HONOLULU, NEW_YORK);

    // The NEXT night, slept in Honolulu: 2026-05-02T09:00Z → 2026-05-02T17:00Z is
    // Honolulu 2026-05-01 23:00 → 2026-05-02 07:00, so wake-day 2026-05-02.
    const honoluluNight = {
      start: "2026-05-02T09:00:00Z",
      end: "2026-05-02T17:00:00Z",
      seconds: 480 * 60,
    };
    freeze("2026-05-02T18:00:00Z");
    pushSleep(profileId, "2026-05-02T18:00:05Z", [NIGHT, honoluluNight]);

    // The old night keeps New York's day; the new one gets Honolulu's. Only the
    // RECOMPUTE on conflict was wrong — a first insert still buckets under the zone in
    // force at the instant.
    expect(sleepRows(profileId)).toEqual([
      { date: "2026-05-02", started_at: NIGHT_START, value: NIGHT_MIN },
      { date: "2026-05-02", started_at: honoluluNight.start, value: 480 },
    ]);
  });

  it("the per-stage rows of one session stay with their session's total", () => {
    const profileId = newProfile("Resend Stages", NEW_YORK);
    const stages = [
      { stage: "deep", start: NIGHT_START, end: "2026-05-02T00:00:00Z" },
      {
        stage: "rem",
        start: "2026-05-02T00:00:00Z",
        end: "2026-05-02T03:00:00Z",
      },
      { stage: "light", start: "2026-05-02T03:00:00Z", end: NIGHT_END },
    ];
    const payload = {
      timestamp: "2026-05-02T07:00:05Z",
      sleep: [
        {
          start_time: NIGHT_START,
          end_time: NIGHT_END,
          duration_seconds: NIGHT_MIN * 60,
          metadata: { data_origin: ORIGIN },
          stages: stages.map((s) => ({
            stage: s.stage,
            start_time: s.start,
            end_time: s.end,
          })),
        },
      ],
    };
    freeze("2026-05-02T07:00:00Z");
    ingestHealthConnectPayload(
      profileId,
      parseHealthConnectPayload(payload, getTimezone(profileId))
    );
    const before = db
      .prepare(
        `SELECT metric, date FROM metric_samples
          WHERE profile_id = ? AND metric LIKE 'sleep%' ORDER BY metric, started_at`
      )
      .all(profileId) as { metric: string; date: string }[];
    // Every row of the night — total and stages — on the one New York wake-day.
    expect(before.length).toBeGreaterThan(1);
    expect(new Set(before.map((r) => r.date))).toEqual(new Set(["2026-05-02"]));

    freeze("2026-05-02T08:00:00Z");
    switchProfileTimezone(profileId, HONOLULU, NEW_YORK);
    freeze("2026-05-02T09:00:00Z");
    ingestHealthConnectPayload(
      profileId,
      parseHealthConnectPayload(
        { ...payload, timestamp: "2026-05-02T09:00:05Z" },
        getTimezone(profileId)
      )
    );
    // A NIGHT IS NEVER SPLIT ACROSS TWO DATES. This is why the rule is total rather than
    // conditional on a row's own instants moving: a stage row and its session's total
    // are two different rows, and any per-row test that lets one move can leave the
    // other behind — the exact symptom #3428 reports on prod.
    const after = db
      .prepare(
        `SELECT metric, date FROM metric_samples
          WHERE profile_id = ? AND metric LIKE 'sleep%' ORDER BY metric, started_at`
      )
      .all(profileId) as { metric: string; date: string }[];
    expect(after).toEqual(before);
  });

  it("an HRV point reading keeps its day across a re-send", () => {
    const profileId = newProfile("Resend HRV", NEW_YORK);
    // 2026-05-02T02:00Z = New York 2026-05-01 22:00, Honolulu 2026-05-01 16:00 — the
    // UTC day and the New York day differ, which is what makes this reading worth
    // asserting on.
    const at = "2026-05-02T02:00:00Z";
    const hrvPayload = (stamp: string) => ({
      timestamp: stamp,
      heart_rate_variability: [
        { time: at, rmssd_millis: 42, metadata: { data_origin: ORIGIN } },
      ],
    });
    freeze("2026-05-02T07:00:00Z");
    ingestHealthConnectPayload(
      profileId,
      parseHealthConnectPayload(
        hrvPayload("2026-05-02T07:00:05Z"),
        getTimezone(profileId)
      )
    );
    const day = () =>
      (
        db
          .prepare(
            "SELECT date FROM metric_samples WHERE profile_id = ? AND metric = 'hrv_ms'"
          )
          .all(profileId) as { date: string }[]
      ).map((r) => r.date);
    expect(day()).toEqual(["2026-05-01"]);

    freeze("2026-05-02T08:00:00Z");
    switchProfileTimezone(profileId, TOKYO, NEW_YORK);
    freeze("2026-05-02T09:00:00Z");
    ingestHealthConnectPayload(
      profileId,
      parseHealthConnectPayload(
        hrvPayload("2026-05-02T09:00:05Z"),
        getTimezone(profileId)
      )
    );
    // Tokyo would call this instant 2026-05-02 11:00.
    expect(day()).toEqual(["2026-05-01"]);
  });

  it("a re-anchorable DAY BUCKET still re-derives — the one carve-out, and #3424 depends on it", () => {
    const profileId = newProfile("Resend Day Bucket", TOKYO);
    // The exporter's `daily` steps record for Tokyo 2026-05-02: Tokyo midnight → now.
    freeze("2026-05-01T23:00:00Z");
    ingestHealthConnectPayload(
      profileId,
      parseHealthConnectPayload(
        {
          timestamp: "2026-05-01T23:00:05Z",
          steps: [
            {
              start_time: "2026-05-01T15:00:00Z",
              end_time: "2026-05-01T23:00:00Z",
              count: 3000,
              metadata: { data_origin: ORIGIN },
            },
          ],
        },
        getTimezone(profileId)
      )
    );
    expect(
      (
        db
          .prepare(
            "SELECT date FROM metric_samples WHERE profile_id = ? AND metric = 'steps'"
          )
          .all(profileId) as { date: string }[]
      ).map((r) => r.date)
    ).toEqual(["2026-05-02"]);

    freeze("2026-05-02T01:00:00Z");
    switchProfileTimezone(profileId, HONOLULU, TOKYO);
    ingestHealthConnectPayload(
      profileId,
      parseHealthConnectPayload(
        {
          timestamp: "2026-05-02T01:00:05Z",
          steps: [
            {
              start_time: "2026-05-01T15:00:00Z",
              end_time: "2026-05-01T23:00:00Z",
              count: 3000,
              metadata: { data_origin: ORIGIN },
            },
          ],
        },
        getTimezone(profileId)
      )
    );
    // A `daily` bucket's `date` is the DEVICE's local day label, not an attribution of
    // an instant. It must follow the re-anchoring, or the stale bucket is stranded on a
    // day #3424's supersede can never reach (`AND date = ?`) and its double count goes
    // both permanent and unreported. See `resendDay`'s header for the measurement.
    expect(
      (
        db
          .prepare(
            "SELECT date FROM metric_samples WHERE profile_id = ? AND metric = 'steps'"
          )
          .all(profileId) as { date: string }[]
      ).map((r) => r.date)
    ).toEqual(["2026-05-01"]);
  });
});
