// DB INTEGRATION TIER — the GATHER behind the arrival statistic (#2214).
//
// The pure side (lib/__tests__/digest-schedule.test.ts) proves the percentile. This
// side proves the rows: that `getSleepArrivals` reads real `integration_sync_rows`
// provenance, crosses the three timestamp conventions #2205 names, and hands the
// decision a sample it can answer from — and that the whole path, settings read
// included, lands on the issue's measured 07:40 instead of the 07:10 the
// median-wake + p90-lag composition produced.
//
// The profile is deliberately NOT in UTC. The arrival minute is profile-local, both
// stored instants are absolute, and a gather that quietly skipped the conversion
// would still pass in UTC — so New York (UTC−4 in July) is the fixture.

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  getNotifySchedule,
  setProfileSetting,
  setTimezone,
} from "@/lib/settings";
import { utcInstant, zonedWallTimeToUtc } from "@/lib/date";
import { getSleepArrivals } from "@/lib/queries/metrics";
import {
  MIN_ARRIVAL_SAMPLE,
  arrivalStatistics,
  digestAutoMinute,
} from "@/lib/notifications/digest-schedule";

const PROVIDER = "health-connect";
const TZ = "America/New_York";
let profileId: number;

// #2214's measured 13 nights: the clock time last night's row landed at, and how
// far behind the session's end that was. Wake = arrival − lag varies independently
// of the lag, which is the whole reason the composition was wrong.
const MEASURED: { date: string; arrival: number; lag: number }[] = [
  { date: "2026-07-24", arrival: 6 * 60 + 2, lag: 30 },
  { date: "2026-07-25", arrival: 6 * 60 + 6, lag: 35 },
  { date: "2026-07-26", arrival: 6 * 60 + 14, lag: 40 },
  { date: "2026-07-27", arrival: 6 * 60 + 26, lag: 45 },
  { date: "2026-07-28", arrival: 6 * 60 + 47, lag: 64 },
  { date: "2026-07-29", arrival: 6 * 60 + 50, lag: 55 },
  { date: "2026-07-30", arrival: 7 * 60 + 4, lag: 86 },
  { date: "2026-07-31", arrival: 7 * 60 + 11, lag: 86 },
  { date: "2026-08-01", arrival: 7 * 60 + 26, lag: 105 },
  { date: "2026-08-02", arrival: 7 * 60 + 26, lag: 80 },
  { date: "2026-08-03", arrival: 7 * 60 + 30, lag: 70 },
  { date: "2026-08-04", arrival: 7 * 60 + 42, lag: 65 },
  { date: "2026-08-05", arrival: 7 * 60 + 48, lag: 50 },
];

const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** A synced overnight session ending `lag` minutes before its row landed. */
function night(
  date: string,
  arrivalMinute: number,
  lagMin: number,
  minutes = 420
): { sampleId: number; arrivedAt: Date } {
  const arrivedAt = zonedWallTimeToUtc(TZ, date, hhmm(arrivalMinute));
  const end = new Date(arrivedAt.getTime() - lagMin * 60_000);
  const start = new Date(end.getTime() - minutes * 60_000);
  const sampleId = Number(
    db
      .prepare(
        `INSERT INTO metric_samples
           (profile_id, source, origin, metric, date, start_time, end_time, value)
         VALUES (?, ?, NULL, 'sleep_min', ?, ?, ?, ?)`
      )
      .run(
        profileId,
        PROVIDER,
        date,
        utcInstant(start),
        utcInstant(end),
        minutes
      ).lastInsertRowid
  );
  syncRow(sampleId, arrivedAt);
  return { sampleId, arrivedAt };
}

/** The provenance pair (#1333) saying a sync wrote this sample at this instant. */
function syncRow(sampleId: number, at: Date): void {
  const eventId = Number(
    db
      .prepare(
        `INSERT INTO integration_sync_events (profile_id, provider, at, ok, inserted)
         VALUES (?, ?, ?, 1, 1)`
      )
      .run(profileId, PROVIDER, utcInstant(at)).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO integration_sync_rows
       (event_id, target_table, target_id, disposition, created_at)
     VALUES (?, 'metric_samples', ?, 'inserted', ?)`
  ).run(eventId, sampleId, utcInstant(at));
}

function seedMeasured(): void {
  for (const n of MEASURED) night(n.date, n.arrival, n.lag);
}

beforeEach(() => {
  db.exec("DELETE FROM integration_sync_rows");
  db.exec("DELETE FROM integration_sync_events");
  db.exec("DELETE FROM metric_samples");
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('ARRIVALS')").run()
      .lastInsertRowid
  );
  setTimezone(profileId, TZ);
});

describe("getSleepArrivals — the rows, in the profile's own clock", () => {
  it("reads each night's local arrival minute and its lag", () => {
    seedMeasured();
    const rows = getSleepArrivals(profileId);
    expect(rows).toHaveLength(13);
    // Newest first, as the SQL orders it; every value is the LOCAL clock time, not
    // the UTC instant four hours ahead of it.
    expect(rows[0]).toEqual({
      date: "2026-08-05",
      arrivalMinute: 7 * 60 + 48,
      lagMin: 50,
      dstTransition: false,
    });
    expect(rows.map((r) => r.arrivalMinute).sort((a, b) => a - b)).toEqual(
      MEASURED.map((n) => n.arrival).sort((a, b) => a - b)
    );
    expect(rows.map((r) => r.lagMin).sort((a, b) => a - b)).toEqual(
      MEASURED.map((n) => n.lag).sort((a, b) => a - b)
    );
  });

  it("takes the FIRST time a row appeared, not a later re-sync", () => {
    const { sampleId, arrivedAt } = night("2026-07-24", 6 * 60 + 2, 30);
    syncRow(sampleId, new Date(arrivedAt.getTime() + 5 * 60 * 60_000));
    const rows = getSleepArrivals(profileId);
    expect(rows).toHaveLength(1);
    expect(rows[0].arrivalMinute).toBe(6 * 60 + 2);
    expect(rows[0].lagMin).toBe(30);
  });

  it("has nothing to say about a night with no provenance", () => {
    // A manually logged night has no arrival to measure. Absent is the right answer.
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, origin, metric, date, start_time, end_time, value)
       VALUES (?, 'manual', NULL, 'sleep_min', '2026-07-24',
               '2026-07-23T23:00:00Z', '2026-07-24T06:00:00Z', 420)`
    ).run(profileId);
    expect(getSleepArrivals(profileId)).toEqual([]);
  });

  it("ignores a nap's sync latency", () => {
    seedMeasured();
    night("2026-08-06", 15 * 60, 20, 90); // 90-minute afternoon session
    expect(getSleepArrivals(profileId)).toHaveLength(13);
  });

  it("flags a night whose local day changed UTC offset", () => {
    // US fall back, 2026-11-01: a 25-hour local day. The flag is what the statistic
    // excludes on; the gather only reports it.
    night("2026-11-01", 7 * 60 + 10, 70);
    night("2026-10-31", 7 * 60 + 10, 70);
    const rows = getSleepArrivals(profileId);
    expect(rows.map((r) => [r.date, r.dstTransition])).toEqual([
      ["2026-11-01", true],
      ["2026-10-31", false],
    ]);
  });
});

describe("the arrival statistic, end to end", () => {
  it("resolves the measured 13 nights to the p90 the issue reports", () => {
    seedMeasured();
    const s = arrivalStatistics(getSleepArrivals(profileId));
    expect(s).toEqual({
      available: true,
      nights: 13,
      p90Minute: 7 * 60 + 40, // 07:39.6 interpolated — the issue's 07:39/07:40
      medianMinute: 7 * 60 + 4,
    });
    // The composition this replaces resolved the same fixture to 07:10.
    expect(digestAutoMinute(s)).toBe(7 * 60 + 41);
  });

  it("gives the `auto` digest the corrected minute through the settings read", () => {
    seedMeasured();
    setProfileSetting(profileId, "notify_digest_hour", "auto");
    const sched = getNotifySchedule(profileId);
    expect(sched.digestAuto).toBe(true);
    expect(sched.digestMinute).toBe(7 * 60 + 41);
  });

  it("invents nothing on a thin profile, and neither consumer gets a time", () => {
    for (const n of MEASURED.slice(0, MIN_ARRIVAL_SAMPLE - 1)) {
      night(n.date, n.arrival, n.lag);
    }
    const s = arrivalStatistics(getSleepArrivals(profileId));
    expect(s).toEqual({
      available: false,
      nights: MIN_ARRIVAL_SAMPLE - 1,
      reason: "thin-sample",
    });
    expect(digestAutoMinute(s)).toBeNull();
    // The digest falls back to the wake-time behavior rather than to a guess.
    setProfileSetting(profileId, "notify_digest_hour", "auto");
    expect(getNotifySchedule(profileId).digestMinute).not.toBe(7 * 60 + 41);
  });

  it("says 'no source' for a profile that has never synced sleep", () => {
    expect(arrivalStatistics(getSleepArrivals(profileId))).toEqual({
      available: false,
      nights: 0,
      reason: "no-source",
    });
  });
});
