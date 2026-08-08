import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getCyclingOverviewData, getRideDetailData } from "@/lib/queries";
import { reconcileCyclingStreamSummaries } from "@/lib/cycling-stream-summary-db";
import {
  serializeCyclingStreamSummary,
  streamSummarySignature,
  summarizeCyclingStreams,
} from "@/lib/cycling-stream-summary";

const POLYLINE = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";

let profileId: number;
let otherProfileId: number;
let rideId: number;
let nonRideId: number;
let spinningId: number;

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Ride Detail')").run()
      .lastInsertRowid
  );
  otherProfileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Other Rider')").run()
      .lastInsertRowid
  );
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value)
     VALUES (?, 'birthdate', '1985-06-01')`
  ).run(profileId);
  const insertProfileSetting = db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)`
  );
  insertProfileSetting.run(profileId, "home_lat", "41.2");
  insertProfileSetting.run(profileId, "home_lng", "-73.8");
  db.prepare(
    `INSERT INTO body_metrics
       (profile_id, date, weight_kg, resting_hr, source)
     VALUES (?, '2026-06-01', 75, 55, 'manual')`
  ).run(profileId);
  const equipmentId = Number(
    db
      .prepare(
        `INSERT INTO equipment (profile_id, name, category)
         VALUES (?, 'Synthetic Road Bike', 'Bike')`
      )
      .run(profileId).lastInsertRowid
  );
  rideId = Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, notes, duration_min, elapsed_min,
            distance_km, start_time, end_time, components, source, external_id,
            avg_hr, max_hr, elevation_m, avg_speed_kmh, max_speed_kmh,
            relative_effort, avg_power_w, max_power_w, weighted_avg_power_w,
            avg_cadence, avg_temp_c, kilojoules, workout_type, equipment_id)
         VALUES (?, '2026-06-10', 'cardio', 'Synthetic park ride',
                 'Fictional fixture ride.', 60, 65, 24, '08:00', '09:05', ?,
                 'strava', 'strava:synthetic-detail', 148, 171, 210, 24, 42,
                 72, 186, 612, 193, 88, 18, 692, 'workout', ?)`
      )
      .run(
        profileId,
        JSON.stringify([
          {
            name: "Cycling",
            type: "cardio",
            distance_km: 24,
            duration_min: 60,
          },
        ]),
        equipmentId
      ).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO activity_routes (activity_id, polyline, source)
     VALUES (?, ?, 'strava')`
  ).run(rideId, POLYLINE);
  db.prepare(
    `INSERT INTO metric_samples
       (profile_id, source, metric, date, start_time, end_time, value,
        activity_external_id)
     VALUES (?, 'strava', 'active_kcal', '2026-06-10',
             '2026-06-10T08:00', '2026-06-10T09:05', 648,
             'strava:synthetic-detail')`
  ).run(profileId);
  const insertHr = db.prepare(
    `INSERT INTO hr_minutes (profile_id, ts, bpm, n, source)
     VALUES (?, ?, ?, 1, 'health-connect')`
  );
  insertHr.run(profileId, "2026-06-10T08:00", 135);
  insertHr.run(profileId, "2026-06-10T08:01", 160);
  insertHr.run(profileId, "2026-06-10T12:00", 62);
  db.prepare(
    `INSERT INTO activity_telemetry
       (profile_id, activity_id, source, streams_json, ftp_w,
        power_zones_json, snapshot_at)
     VALUES (?, ?, 'strava', ?, 250, ?, '2026-06-10T10:00:00Z')`
  ).run(
    profileId,
    rideId,
    JSON.stringify({
      time: { data: Array.from({ length: 61 }, (_, index) => index) },
      distance: {
        data: Array.from({ length: 61 }, (_, index) => index * 100),
      },
      moving: {
        data: Array.from(
          { length: 61 },
          (_, index) => index < 11 || index > 20
        ),
      },
      watts: { data: Array.from({ length: 61 }, () => 200) },
      cadence: { data: Array.from({ length: 61 }, () => 85) },
      grade_smooth: {
        data: Array.from({ length: 61 }, (_, index) =>
          index >= 31 && index <= 40 ? 4 : 0
        ),
      },
      heartrate: {
        data: Array.from({ length: 61 }, (_, index) =>
          index <= 30 ? 140 : 150
        ),
      },
      latlng: {
        data: Array.from({ length: 61 }, (_, index) => [
          38.5 + index / 1000,
          -120.2 - index / 1000,
        ]),
      },
    }),
    JSON.stringify([
      { min: 0, max: 180 },
      { min: 181, max: -1 },
    ])
  );

  const insertCyclingVariant = db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, duration_min, distance_km, components,
        avg_hr, elevation_m, avg_speed_kmh, relative_effort, avg_power_w,
        weighted_avg_power_w, avg_cadence, avg_temp_c)
     VALUES (?, ?, 'cardio', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  spinningId = Number(
    insertCyclingVariant.run(
      profileId,
      "2026-07-01",
      "Synthetic spin class",
      45,
      null,
      JSON.stringify([{ name: "Spinning", type: "cardio" }]),
      145,
      999,
      null,
      65,
      175,
      182,
      90,
      21
    ).lastInsertRowid
  );
  insertCyclingVariant.run(
    profileId,
    "2026-07-08",
    "Synthetic second spin",
    50,
    null,
    JSON.stringify([{ name: "Spinning", type: "cardio" }]),
    150,
    999,
    null,
    70,
    185,
    192,
    92,
    22
  );
  insertCyclingVariant.run(
    profileId,
    "2026-07-05",
    "Synthetic trail loops",
    75,
    18,
    JSON.stringify([{ name: "Mountain Biking", type: "cardio" }]),
    155,
    620,
    14.4,
    88,
    205,
    218,
    78,
    24
  );
  db.prepare(
    `INSERT INTO activity_routes (activity_id, polyline, source)
     VALUES (?, ?, 'synthetic')`
  ).run(spinningId, POLYLINE);
  db.prepare(
    `INSERT INTO activity_telemetry
       (profile_id, activity_id, source, streams_json, snapshot_at)
     VALUES (?, ?, 'synthetic', ?, '2026-07-01T12:00:00Z')`
  ).run(
    profileId,
    spinningId,
    JSON.stringify({
      time: { data: [0, 5, 10, 15, 20] },
      watts: { data: [150, 180, 210, 190, 170] },
      cadence: { data: [80, 85, 90, 88, 84] },
    })
  );
  db.prepare(
    `INSERT INTO activity_laps
       (profile_id, activity_id, source, external_id, lap_index, name,
        distance_m, moving_time_sec, average_watts)
     VALUES (?, ?, 'strava', 'synthetic-lap', 1, 'Lap 1', 5000, 600, 205)`
  ).run(profileId, rideId);
  db.prepare(
    `INSERT INTO activity_segment_efforts
       (profile_id, activity_id, source, external_id, name, distance_m,
        moving_time_sec, average_watts, pr_rank)
     VALUES (?, ?, 'strava', 'synthetic-effort', 'Park climb', 1200, 240, 280, 1)`
  ).run(profileId, rideId);

  db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, duration_min, distance_km, components,
        avg_hr, elevation_m, avg_speed_kmh, relative_effort, avg_power_w,
        weighted_avg_power_w, avg_cadence)
     VALUES (?, '2026-06-03', 'cardio', 'Synthetic comparison ride', 58, 22, ?,
             142, 180, 22.5, 60, 170, 178, 84)`
  ).run(
    profileId,
    JSON.stringify([
      {
        name: "Cycling",
        type: "cardio",
        distance_km: 22,
        duration_min: 58,
      },
    ])
  );

  const insertWeather = db.prepare(
    `INSERT INTO weather_days
       (lat, lng, date, temp_max_c, temp_min_c, precipitation_mm, weather_code)
     VALUES (41.2, -73.8, ?, ?, ?, ?, ?)`
  );
  insertWeather.run("2026-06-03", 19, 11, 0, 3);
  insertWeather.run("2026-06-10", 26, 16, 0, 0);
  insertWeather.run("2026-06-11", 17, 12, 8, 63);
  insertWeather.run("2026-06-12", 29, 18, 0, 0);

  db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, duration_min, distance_km, components,
        avg_hr, elevation_m, avg_speed_kmh, relative_effort, avg_power_w,
        weighted_avg_power_w, avg_cadence)
     VALUES (?, '2026-06-12', 'cardio', 'Synthetic later comparison ride', 61, 25, ?,
             150, 220, 26, 74, 202, 208, 90)`
  ).run(
    profileId,
    JSON.stringify([
      {
        name: "Cycling",
        type: "cardio",
        distance_km: 25,
        duration_min: 61,
      },
    ])
  );

  nonRideId = Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, duration_min)
         VALUES (?, '2026-06-10', 'cardio', 'Synthetic run', 30)`
      )
      .run(profileId).lastInsertRowid
  );

  // The telemetry above is inserted with raw SQL, so it carries no precomputed
  // stream summary — and since #2292 the cycling OVERVIEW reads that summary
  // instead of parsing streams. This is the same pass a real boot runs, and it is
  // how any writer other than upsertCyclingTelemetry is expected to become
  // complete: write a summary, or leave it NULL for the reconcile to fill.
  reconcileCyclingStreamSummaries(db);
});

describe("getRideDetailData", () => {
  it("assembles the existing ride measurements into one read model", () => {
    const detail = getRideDetailData(profileId, rideId);
    expect(detail).not.toBeNull();
    expect(detail).toMatchObject({
      routePolyline: POLYLINE,
      bodyweightKg: 75,
      calorieDisplay: { kcal: 648, estimated: false },
      equipment: { name: "Synthetic Road Bike" },
    });
    expect(detail!.activity.imported_metrics).toMatchObject({
      avg_power_w: 186,
      weighted_avg_power_w: 193,
      active_kcal: 648,
    });
    expect(detail!.activity.route_polyline).toBe(POLYLINE);
    expect(detail!.heartRateWindow).toEqual({
      start: "2026-06-10T08:00",
      end: "2026-06-10T09:05",
    });
    expect(detail!.heartRateMinutes).toEqual([
      { ts: "2026-06-10T08:00", bpm: 135 },
      { ts: "2026-06-10T08:01", bpm: 160 },
    ]);
    expect(detail!.zoneMinutes).toEqual([0, 1, 0, 1, 0]);
    expect(detail!.comparison).toMatchObject({
      basis: "distance",
      tolerancePercent: 30,
      rideCount: 2,
    });
    expect(detail!.rideHistory.before).toEqual([
      expect.objectContaining({ title: "Synthetic comparison ride" }),
    ]);
    expect(detail!.rideHistory.after).toEqual([
      expect.objectContaining({ title: "Synthetic later comparison ride" }),
    ]);
    expect(detail!.rideHistory.before).toHaveLength(1);
    expect(detail!.rideHistory.after).toHaveLength(1);
    expect(detail!.traces.map((trace) => trace.key)).toEqual([
      "watts",
      "cadence",
      "heartrate",
      "grade_smooth",
    ]);
    expect(detail!.timedRoute).toHaveLength(61);
    expect(detail!.timedRoute[0]).toEqual({
      elapsedSec: 0,
      lat: 38.5,
      lng: -120.2,
    });
    expect(detail!.timedRoute.at(-1)).toEqual({
      elapsedSec: 60,
      lat: 38.56,
      lng: -120.26,
    });
    expect(detail!.powerCurve).toEqual([
      { seconds: 5, label: "5 sec", watts: 200 },
      { seconds: 60, label: "1 min", watts: 200 },
    ]);
    expect(detail!.cyclingLoad).toMatchObject({
      ftpW: 250,
      weightedPowerW: 193,
    });
    expect(detail!.powerZones).toEqual([
      { min: 0, max: 180 },
      { min: 181, max: -1 },
    ]);
    expect(detail!.powerZoneTimes).toEqual([
      { zone: 1, min: 0, max: 180, seconds: 0, percent: 0 },
      { zone: 2, min: 181, max: -1, seconds: 50, percent: 100 },
    ]);
    expect(detail!.dynamics).toMatchObject({
      movingSeconds: 50,
      stoppedSeconds: 10,
      climbingSeconds: 10,
    });
    expect(detail!.distanceSplits).toHaveLength(1);
    expect(detail!.laps[0]).toMatchObject({ name: "Lap 1", distanceM: 5000 });
    expect(detail!.segmentEfforts[0]).toMatchObject({
      name: "Park climb",
      prRank: 1,
    });
    expect(
      detail!.comparison!.metrics.find((metric) => metric.key === "power")
    ).toMatchObject({
      key: "power",
      current: 186,
      median: 186,
      difference: 0,
    });
  });

  it("returns null for another profile's id and for a non-cycling activity", () => {
    expect(getRideDetailData(otherProfileId, rideId)).toBeNull();
    expect(getRideDetailData(profileId, nonRideId)).toBeNull();
  });
});

describe("getCyclingOverviewData", () => {
  it("aggregates ride records, zones, routes, and power telemetry", () => {
    const overview = getCyclingOverviewData(profileId);

    expect(overview.rollup.totals).toMatchObject({
      rides: 3,
      distanceKm: 71,
      durationMin: 179,
      elevationM: 610,
      kilojoules: 692,
    });
    expect(overview.rollup.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "distance",
          title: "Synthetic later comparison ride",
        }),
        expect.objectContaining({
          key: "power",
          title: "Synthetic later comparison ride",
        }),
      ])
    );
    expect(overview.zoneMinutes).toEqual([0, 1, 0, 1, 0]);
    expect(overview.powerBests).toEqual([
      expect.objectContaining({ seconds: 5, watts: 200, activityId: rideId }),
      expect.objectContaining({ seconds: 60, watts: 200, activityId: rideId }),
    ]);
    expect(overview.loadPoints).toEqual([
      expect.objectContaining({ activityId: rideId, ftpW: 250 }),
    ]);
    expect(overview.latestFtpW).toBe(250);
    expect(overview.telemetryRideCount).toBe(1);
    expect(overview.routeCount).toBe(1);
    expect(overview.uniqueRouteCount).toBe(1);
    expect(overview.segmentRideCount).toBe(1);
    expect(overview.segmentPersonalBestCount).toBe(1);
    expect(overview.distribution.months[5]).toMatchObject({
      label: "June",
      rides: 3,
    });
    expect(overview.distribution.weather).toMatchObject({
      coverageDays: 4,
      coveredRideDays: 3,
    });
    expect(
      overview.distribution.weather.conditions.find(
        (condition) => condition.key === "clear"
      )
    ).toMatchObject({ availableDays: 2, rideDays: 2, rideDayRate: 100 });
  });

  it("scopes rich analytics to a cycling subtype and omits outdoor context indoors", () => {
    const spinning = getCyclingOverviewData(profileId, "Spinning");
    expect(spinning).toMatchObject({
      activityName: "Spinning",
      indoorOnly: true,
      routeCount: 0,
      uniqueRouteCount: 0,
      segmentRideCount: 0,
      telemetryRideCount: 1,
    });
    expect(spinning.rollup.totals).toMatchObject({
      rides: 2,
      durationMin: 95,
      elevationM: 0,
    });
    expect(spinning.distribution.weather.coverageDays).toBe(0);

    const detail = getRideDetailData(profileId, spinningId);
    expect(detail).toMatchObject({
      activityName: "Spinning",
      indoorOnly: true,
      comparison: { basis: "duration", rideCount: 1 },
    });
    expect(
      detail!.comparison!.metrics.some((metric) => metric.key === "elevation")
    ).toBe(false);

    const mountainBiking = getCyclingOverviewData(profileId, "Mountain Biking");
    expect(mountainBiking).toMatchObject({
      activityName: "Mountain Biking",
      indoorOnly: false,
    });
    expect(mountainBiking.rollup.totals.rides).toBe(1);
  });
});

// Issue #2197: the overview's zone distribution used to read per-minute HR from the
// profile's FIRST ride ever, so the scan grew with account age. It is now bounded to
// one declared training block anchored on the most recent ride. This pins the BOUND:
// a rider whose history exceeds the window keeps the older ride in the all-time
// totals and out of the distribution.
describe("getCyclingOverviewData heart-rate window", () => {
  let riderId: number;
  let oldRideId: number;

  beforeAll(() => {
    riderId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('Long Time Rider')").run()
        .lastInsertRowid
    );
    db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value)
       VALUES (?, 'birthdate', '1985-06-01')`
    ).run(riderId);
    const components = JSON.stringify([
      { name: "Cycling", type: "cardio", distance_km: 20, duration_min: 60 },
    ]);
    const insertRide = db.prepare(
      `INSERT INTO activities
         (profile_id, date, type, title, duration_min, distance_km,
          start_time, end_time, components)
       VALUES (?, ?, 'cardio', ?, 60, 20, '08:00', '09:00', ?)`
    );
    oldRideId = Number(
      insertRide.run(riderId, "2026-01-05", "Synthetic winter ride", components)
        .lastInsertRowid
    );
    insertRide.run(riderId, "2026-06-10", "Synthetic summer ride", components);
    const insertHr = db.prepare(
      `INSERT INTO hr_minutes (profile_id, ts, bpm, n, source)
       VALUES (?, ?, ?, 1, 'health-connect')`
    );
    insertHr.run(riderId, "2026-01-05T08:00", 150); // hard, five months back
    insertHr.run(riderId, "2026-01-05T08:01", 150);
    insertHr.run(riderId, "2026-06-10T08:00", 115); // inside the window
    insertHr.run(riderId, "2026-06-10T08:02", 130);
  });

  it("counts only the block ending on the most recent ride", () => {
    // The out-of-window minutes are readable — the ride detail still reports them.
    // They are excluded by the window, not missing from the fixture.
    expect(getRideDetailData(riderId, oldRideId)!.zoneMinutes).toEqual([
      0, 0, 0, 2, 0,
    ]);

    const overview = getCyclingOverviewData(riderId);
    expect(overview.zoneWindow).toEqual({
      weeks: 12,
      since: "2026-03-19",
      through: "2026-06-10",
    });
    expect(overview.zoneMinutes).toEqual([0, 1, 1, 0, 0]);
    // The all-time surfaces are untouched: both rides still count.
    expect(overview.rollup.totals.rides).toBe(2);
  });
});

// Issue #2292: the overview used to JSON.parse EVERY activity_telemetry.streams_json
// row the profile owned on each load, to derive two things — the power-curve bests
// and the per-zone seconds. Both are now precomputed at ingest into
// stream_summary_json, so the page reads a few numbers per ride instead of a ride's
// worth of per-second samples.
//
// These pin the BOUND, in the shape #2290 used for the HR window: the streams stay
// present and reachable through the ride-detail read, so what the overview leaves
// out is excluded BY COLUMN, not missing from the fixture.
describe("getCyclingOverviewData stream summary", () => {
  let summaryProfileId: number;
  let summaryRideId: number;
  let telemetryId: number;

  // 200 W flat for a minute — what parsing the streams yields.
  const STREAMS = JSON.stringify({
    time: { data: Array.from({ length: 61 }, (_, index) => index) },
    watts: { data: Array.from({ length: 61 }, () => 200) },
  });
  const ZONES = JSON.stringify([
    { min: 0, max: 180 },
    { min: 181, max: -1 },
  ]);

  beforeAll(() => {
    summaryProfileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('Summary Rider')").run()
        .lastInsertRowid
    );
    summaryRideId = Number(
      db
        .prepare(
          `INSERT INTO activities
             (profile_id, date, type, title, duration_min, distance_km,
              weighted_avg_power_w, components)
           VALUES (?, '2026-06-10', 'cardio', 'Synthetic summary ride', 60, 20,
                   205, ?)`
        )
        .run(
          summaryProfileId,
          JSON.stringify([
            {
              name: "Cycling",
              type: "cardio",
              distance_km: 20,
              duration_min: 60,
            },
          ])
        ).lastInsertRowid
    );
    telemetryId = Number(
      db
        .prepare(
          `INSERT INTO activity_telemetry
             (profile_id, activity_id, source, streams_json, ftp_w,
              power_zones_json, snapshot_at)
           VALUES (?, ?, 'strava', ?, 250, ?, '2026-06-10T10:00:00Z')`
        )
        .run(summaryProfileId, summaryRideId, STREAMS, ZONES).lastInsertRowid
    );
  });

  const setSummary = (value: string | null) =>
    db
      .prepare(
        "UPDATE activity_telemetry SET stream_summary_json = ? WHERE id = ?"
      )
      .run(value, telemetryId);

  it("reads the stored summary and never parses the streams", () => {
    // A sentinel no amount of parsing could produce: the streams are flat 200 W.
    setSummary(
      JSON.stringify({
        sig: streamSummarySignature(),
        powerCurve: [{ seconds: 5, watts: 999 }],
        powerZoneSeconds: [7, 11],
      })
    );

    const overview = getCyclingOverviewData(summaryProfileId);
    expect(overview.powerBests).toEqual([
      expect.objectContaining({ seconds: 5, label: "5 sec", watts: 999 }),
    ]);
    expect(overview.powerZoneTimes.map((zone) => zone.seconds)).toEqual([
      7, 11,
    ]);

    // The streams themselves are intact and still reachable — the ride detail,
    // which reads ONE row and is bounded by construction, parses them and reports
    // the real 200 W. So the overview's number came from the summary column, not
    // from an empty fixture.
    const detail = getRideDetailData(summaryProfileId, summaryRideId)!;
    expect(detail.powerCurve).toEqual([
      { seconds: 5, label: "5 sec", watts: 200 },
      { seconds: 60, label: "1 min", watts: 200 },
    ]);
    // The non-stream telemetry values are untouched by any of this.
    expect(overview.latestFtpW).toBe(250);
    expect(overview.telemetryRideCount).toBe(1);
    expect(overview.loadPoints).toHaveLength(1);
  });

  it("treats a missing or stale-signature summary as absent, and the reconcile heals it", () => {
    for (const unusable of [
      null,
      // A curve taken at durations the app no longer shows. Nothing about this row
      // is corrupt — it answers the PREVIOUS question, which is the silent failure
      // the signature exists to catch.
      JSON.stringify({
        sig: "1:5,30,60,300,1200",
        powerCurve: [{ seconds: 5, watts: 999 }],
        powerZoneSeconds: [7, 11],
      }),
    ]) {
      setSummary(unusable);
      const stale = getCyclingOverviewData(summaryProfileId);
      // No fallback to parsing the streams — that is the cost this change removed.
      expect(stale.powerBests).toEqual([]);
      expect(stale.powerZoneTimes).toEqual([]);
      // The ride still counts everywhere that never needed the streams.
      expect(stale.telemetryRideCount).toBe(1);
      expect(stale.rollup.totals.rides).toBe(1);

      expect(reconcileCyclingStreamSummaries(db)).toBeGreaterThan(0);
      const healed = getCyclingOverviewData(summaryProfileId);
      expect(healed.powerBests).toEqual([
        expect.objectContaining({ seconds: 5, label: "5 sec", watts: 200 }),
        expect.objectContaining({ seconds: 60, label: "1 min", watts: 200 }),
      ]);
      expect(healed.powerZoneTimes.map((zone) => zone.seconds)).toEqual([
        0, 60,
      ]);
      // What the reconcile writes is exactly what summarizing the row yields.
      expect(
        (
          db
            .prepare(
              "SELECT stream_summary_json AS s FROM activity_telemetry WHERE id = ?"
            )
            .get(telemetryId) as { s: string }
        ).s
      ).toBe(
        serializeCyclingStreamSummary(summarizeCyclingStreams(STREAMS, ZONES))
      );
    }
  });

  it("does no work on a boot with nothing to re-derive", () => {
    // The property the whole design rests on: streams_json is never read again
    // once every row is signed, so a no-drift boot costs one small-column scan.
    expect(reconcileCyclingStreamSummaries(db)).toBe(0);
  });

  it("gives an unsummarisable row a terminal state instead of re-parsing it forever", () => {
    const brokenRideId = Number(
      db
        .prepare(
          `INSERT INTO activities
             (profile_id, date, type, title, duration_min, distance_km, components)
           VALUES (?, '2026-06-12', 'cardio', 'Synthetic broken telemetry', 40, 12, ?)`
        )
        .run(
          summaryProfileId,
          JSON.stringify([
            {
              name: "Cycling",
              type: "cardio",
              distance_km: 12,
              duration_min: 40,
            },
          ])
        ).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO activity_telemetry
         (profile_id, activity_id, source, streams_json, snapshot_at)
       VALUES (?, ?, 'strava', 'not json at all', '2026-06-12T10:00:00Z')`
    ).run(summaryProfileId, brokenRideId);

    expect(reconcileCyclingStreamSummaries(db)).toBe(1);
    // Signed but empty: it contributes nothing, and the NEXT boot skips it rather
    // than parsing the same unusable payload again.
    expect(reconcileCyclingStreamSummaries(db)).toBe(0);
    const overview = getCyclingOverviewData(summaryProfileId);
    expect(overview.telemetryRideCount).toBe(2);
    expect(overview.powerBests).toHaveLength(2);
  });
});
