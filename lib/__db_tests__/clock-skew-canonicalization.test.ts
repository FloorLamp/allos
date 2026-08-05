// DB INTEGRATION TIER — one clock-skew canonicalization, end to end (#2088).
//
// The provider-clock-error family was being repaired one symptom at a time. This
// file proves the two halves of the replacement against real rows:
//
//   INGEST (branch A). Strava's `start_date_local` is `start_date + utc_offset`, and
//   that offset is what goes stale — it is how #2011's duplicate arrived an hour
//   early. Given the profile's own timezone and Strava's true `start_date` instant,
//   the local day and clock follow with nothing inferred, so the row lands where it
//   belongs the FIRST time. Re-running the same push writes the same row (idempotent),
//   and a hand-corrected row is left alone (`isEditLocked`).
//
//   DETECTION (branch B). Where no instant survives — a bare wall clock from two
//   providers — nothing may say which one lied, so the pair goes to Data → Review.
//   Both a MIDNIGHT-CROSSING pair (#2056) and a HALF-HOUR offset pair (#2063/#2092)
//   converge on ONE canonical reading there: one cluster, one session, two copies.
//
// All fixtures SYNTHETIC.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { mapStravaActivity } from "@/lib/integrations/strava";
import { upsertActivities } from "@/lib/integrations/normalize";
import {
  getActivityDuplicates,
  getActivityDuplicateClusters,
} from "@/lib/queries";

// Berlin is UTC+2 in July. A provider that resolved the athlete against UTC files
// every activity two hours early — the shape of a stale `utc_offset`.
const TZ = "Europe/Berlin";

let ingestProfile: number;
let detectProfile: number;

// A Strava summary whose `start_date_local` was computed against the WRONG offset:
// the true instant is 21:30Z (23:30 in Berlin), and Strava filed it as 21:30 local.
function skewedSummary(over: Record<string, unknown> = {}) {
  return {
    id: 8801,
    name: "Night ride",
    sport_type: "Ride",
    start_date: "2026-07-08T21:30:00Z",
    start_date_local: "2026-07-08T21:30:00Z",
    moving_time: 1500,
    elapsed_time: 1500,
    distance: 8000,
    ...over,
  };
}

function activityRow(profileId: number, externalId: string) {
  return db
    .prepare(
      `SELECT date, start_time, end_time, edited FROM activities
        WHERE profile_id = ? AND external_id = ?`
    )
    .get(profileId, externalId) as
    | { date: string; start_time: string; end_time: string; edited: number }
    | undefined;
}

const insAct = db.prepare(
  `INSERT INTO activities
     (profile_id, date, type, title, source, external_id,
      start_time, end_time, duration_min, distance_km)
   VALUES (?, ?, 'cardio', ?, ?, ?, ?, ?, ?, ?)`
);

beforeAll(() => {
  ingestProfile = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('CANON-INGEST')").run()
      .lastInsertRowid
  );
  detectProfile = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('CANON-DETECT')").run()
      .lastInsertRowid
  );
  setTimezone(ingestProfile, TZ);
  setTimezone(detectProfile, TZ);

  // ── The detection fixture: two pairs no instant survived for. ──
  // (1) #2056 — one 23:30 session whose copy landed at 00:30 the NEXT day.
  insAct.run(
    detectProfile,
    "2026-07-08",
    "Night walk",
    "health-connect",
    "health-connect:cross-midnight",
    "23:30",
    "23:55",
    25,
    2.1
  );
  insAct.run(
    detectProfile,
    "2026-07-09",
    "Evening Walk",
    "strava",
    "strava:cross-midnight",
    "00:30",
    "00:55",
    25,
    2.11
  );
  // (2) #2063/#2092 — an India-shaped HALF-hour offset, same day.
  insAct.run(
    detectProfile,
    "2026-07-12",
    "Morning walk",
    "health-connect",
    "health-connect:half-hour",
    "08:35",
    "09:00",
    25,
    2.1
  );
  insAct.run(
    detectProfile,
    "2026-07-12",
    "Walk",
    "strava",
    "strava:half-hour",
    "08:05",
    "08:30",
    25,
    2.1
  );
});

describe("branch A — the instant canonicalizes the row at ingest", () => {
  it("files the activity on the profile's clock, not the provider's stale offset", () => {
    const mapped = mapStravaActivity(skewedSummary(), undefined, TZ);
    expect(mapped).not.toBeNull();
    // 21:30Z is 23:30 in Berlin. The provider said 21:30 and was two hours out.
    expect(mapped?.activity.date).toBe("2026-07-08");
    expect(mapped?.activity.start_time).toBe("23:30");
    expect(mapped?.activity.end_time).toBe("23:55");

    const counts = upsertActivities(
      ingestProfile,
      [mapped!.activity],
      "strava"
    );
    expect(counts.inserted).toBe(1);
    expect(activityRow(ingestProfile, "strava:8801")).toMatchObject({
      date: "2026-07-08",
      start_time: "23:30",
    });
  });

  it("is IDEMPOTENT — the same push re-syncs to unchanged", () => {
    const mapped = mapStravaActivity(skewedSummary(), undefined, TZ);
    const counts = upsertActivities(
      ingestProfile,
      [mapped!.activity],
      "strava"
    );
    expect(counts.inserted).toBe(0);
    expect(counts.unchanged).toBe(1);
  });

  it("leaves a hand-corrected row alone", () => {
    db.prepare(
      `UPDATE activities SET edited = 1, start_time = '23:40'
        WHERE profile_id = ? AND external_id = 'strava:8801'`
    ).run(ingestProfile);
    const mapped = mapStravaActivity(skewedSummary(), undefined, TZ);
    const counts = upsertActivities(
      ingestProfile,
      [mapped!.activity],
      "strava"
    );
    expect(counts.edited).toBe(1);
    expect(activityRow(ingestProfile, "strava:8801")?.start_time).toBe("23:40");
  });

  it("falls back to the provider's wall clock with no timezone to read against", () => {
    // The pre-#2088 behaviour, byte for byte, for any caller with no profile context.
    const mapped = mapStravaActivity(skewedSummary({ id: 8802 }));
    expect(mapped?.activity.date).toBe("2026-07-08");
    expect(mapped?.activity.start_time).toBe("21:30");
  });

  it("keeps the calories sample's dedup key on the REPORTED numerals", () => {
    // Re-keying it would make one already-imported calorie row look like a new one
    // and double the day; the local DATE beside it still takes the canonical answer.
    const mapped = mapStravaActivity(
      skewedSummary({ id: 8803 }),
      {
        calories: 220,
      },
      TZ
    );
    expect(mapped?.samples).toHaveLength(1);
    expect(mapped?.samples[0].start_time).toBe("2026-07-08T21:30:00.000Z");
    expect(mapped?.samples[0].date).toBe("2026-07-08");
  });
});

describe("branch B — two wall clocks converge on one canonical reading in Review", () => {
  it("collapses the midnight-crossing copies into ONE cluster (#2056)", () => {
    const clusters = getActivityDuplicateClusters(detectProfile).filter((c) =>
      c.members.some((m) => m.external_id === "strava:cross-midnight")
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].confidence).toBe("medium");
    expect(clusters[0].date).toBe("2026-07-08");
    expect(clusters[0].members).toHaveLength(2);
    expect(clusters[0].reason).toBe(
      "Across midnight, similar duration/distance — clocks differ by 1h"
    );
  });

  it("collapses the HALF-hour offset copies into ONE cluster (#2063)", () => {
    const clusters = getActivityDuplicateClusters(detectProfile).filter((c) =>
      c.members.some((m) => m.external_id === "strava:half-hour")
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].confidence).toBe("medium");
    expect(clusters[0].reason).toBe(
      "Same day, similar duration/distance — clocks differ by 30m"
    );
  });

  it("names both, and only those two — the widening is a gate, not a net", () => {
    expect(getActivityDuplicates(detectProfile)).toHaveLength(2);
  });
});
