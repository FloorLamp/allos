// DB INTEGRATION TIER — the READ half of the cross-ride comparison (#3195).
// lib/__tests__/cycling-bests.test.ts owns the pure ranking rule; this file owns
// the two properties that are about the query, and neither can be checked without
// a real schema:
//
//   • AS-OF THAT RIDE, NOT AS OF NOW. A medal is a fact about the day it was
//     earned. Ranking against current state would make every historical page
//     silently rewrite itself as new rides land, and nothing would go red.
//   • NEVER A STREAM PARSE ON THE READ PATH. Pinned in the #2292 shape: the priors
//     carry SENTINEL summaries no amount of parsing their streams could produce,
//     and the streams stay present and reachable, so what the comparison leaves
//     out is excluded BY COLUMN rather than missing from the fixture.

import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getRideBestRecaps, getRideDetailData } from "@/lib/queries";
import { rideBestStatementDetail } from "@/lib/cycling-bests";
import {
  serializeCyclingStreamSummary,
  streamSummarySignature,
  summarizeCyclingStreams,
} from "@/lib/cycling-stream-summary";

// A flat 30-minute ride at a constant power and speed. Real streams and a real
// summary: the three rides below differ from each other in BOTH, so the as-of
// tests are about the ordering and not about which column was read. The column is
// the subject of the second describe, which forges a disagreement between them.
const flatStreams = (watts: number, metresPerSecond: number) =>
  JSON.stringify({
    time: { data: Array.from({ length: 1801 }, (_, index) => index) },
    distance: {
      data: Array.from({ length: 1801 }, (_, index) => index * metresPerSecond),
    },
    watts: { data: Array.from({ length: 1801 }, () => watts) },
  });

let profileId: number;
const rides = new Map<string, number>();

function plantRide(
  date: string,
  title: string,
  watts: number,
  metresPerSecond: number
) {
  const streams = flatStreams(watts, metresPerSecond);
  const id = Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, duration_min, distance_km, components)
         VALUES (?, ?, 'cardio', ?, 30, 12, ?)`
      )
      .run(
        profileId,
        date,
        title,
        JSON.stringify([
          { name: "Cycling", type: "cardio", distance_km: 12, duration_min: 30 },
        ])
      ).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO activity_telemetry
       (profile_id, activity_id, source, streams_json, snapshot_at,
        stream_summary_json)
     VALUES (?, ?, 'strava', ?, ?, ?)`
  ).run(
    profileId,
    id,
    streams,
    `${date}T12:00:00Z`,
    // Written here rather than left to a boot, exactly as the e2e fixtures do.
    serializeCyclingStreamSummary(summarizeCyclingStreams(streams, null))
  );
  rides.set(title, id);
  return id;
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Ride Bests')").run()
      .lastInsertRowid
  );
  plantRide("2026-06-01", "Synthetic first ride", 300, 6.0);
  plantRide("2026-06-02", "Synthetic record ride", 400, 6.6);
  plantRide("2026-06-03", "Synthetic beaten ride", 500, 7.2);
});

const detail = (title: string) =>
  getRideDetailData(profileId, rides.get(title)!, 5000)!;

describe("ride bests, as of the ride", () => {
  it("keeps an old ride's medal after a later ride beats it", () => {
    // The middle ride out-powered the one before it, so on its own day it was the
    // best 5-second effort the profile had recorded.
    const allFirst = [5, 60, 300, 1200].map((seconds) => ({ seconds, rank: 1 }));
    const record = detail("Synthetic record ride");
    expect(record.bests.power).toEqual(allFirst);
    expect(record.bests.comparedPowerRides).toBe(2);

    // The third ride beat it at every duration and on both splits. The second
    // ride's page still says what it earned — if this read were current-state,
    // every line above would now be rank 2.
    expect(detail("Synthetic beaten ride").bests.power).toEqual(allFirst);
    expect(detail("Synthetic record ride").bests.power).toEqual(allFirst);
    expect(detail("Synthetic record ride").bests.comparedPowerRides).toBe(2);
    expect(detail("Synthetic record ride").bests.splits).toEqual([
      { index: 1, rank: 1 },
      { index: 2, rank: 1 },
    ]);
  });

  // "EVER" IS "SINCE POWER DATA EXISTS" (#2385). The first ride has nothing to
  // compare against, so it earns no markers and its surface says which ride it is.
  it("gives the first ride with power no markers at all", () => {
    const first = detail("Synthetic first ride");
    expect(first.bests.power).toEqual([]);
    expect(first.bests.splits).toEqual([]);
    expect(first.bests.comparedPowerRides).toBe(1);
    expect(first.bests.comparedSplitRides).toBe(1);
  });

  it("states a thin history as the number of rides it really is", () => {
    expect(detail("Synthetic beaten ride").bests.comparedPowerRides).toBe(3);
  });
});

describe("the comparison never parses a prior's streams", () => {
  const summaryOf = (title: string) =>
    (
      db
        .prepare(
          `SELECT stream_summary_json AS s FROM activity_telemetry
            WHERE activity_id = ?`
        )
        .get(rides.get(title)!) as { s: string }
    ).s;
  const setSummary = (title: string, value: string) =>
    db
      .prepare(
        `UPDATE activity_telemetry SET stream_summary_json = ?
          WHERE activity_id = ?`
      )
      .run(value, rides.get(title)!);

  it("ranks against the stored summary, not the streams behind it", () => {
    const restore = summaryOf("Synthetic first ride");
    // A SENTINEL no amount of parsing could produce: the first ride's streams are
    // flat 300 W. If the read fell back to parsing them, the record ride's own
    // 400 W would still be first — through the summary column it is second.
    setSummary(
      "Synthetic first ride",
      JSON.stringify({
        sig: streamSummarySignature(),
        powerCurve: [{ seconds: 5, watts: 900 }],
        powerZoneSeconds: [],
        splitTimesSec: [{ intervalM: 5000, timesSec: [1] }],
      })
    );
    const forged = detail("Synthetic record ride");
    expect(
      forged.bests.power.find((entry) => entry.seconds === 5)
    ).toEqual({ seconds: 5, rank: 2 });
    // Only the 5-second duration and the splits are in that sentinel, so every
    // other duration's pool is empty and earns no marker at all.
    expect(forged.bests.power.map((entry) => entry.seconds)).toEqual([5]);
    // And the forged one-second 5 km split pushes both of this ride's real splits
    // to second — a time no stream in this fixture could have produced.
    expect(forged.bests.splits).toEqual([
      { index: 1, rank: 2 },
      { index: 2, rank: 2 },
    ]);

    // The streams are intact and still reachable — the ride's OWN curve, which the
    // detail page parses from the ONE row it already holds, reports the real
    // watts. So what the comparison left out is excluded BY COLUMN rather than
    // missing from the fixture.
    expect(forged.powerCurve[0]).toEqual({
      seconds: 5,
      label: "5 sec",
      watts: 400,
    });

    setSummary("Synthetic first ride", restore);
    expect(detail("Synthetic record ride").bests.power).toEqual([
      { seconds: 5, rank: 1 },
      { seconds: 60, rank: 1 },
      { seconds: 300, rank: 1 },
      { seconds: 1200, rank: 1 },
    ]);
  });

  it("treats a stale-signature prior as absent rather than falling back to its streams", () => {
    const restore = summaryOf("Synthetic first ride");
    setSummary(
      "Synthetic first ride",
      JSON.stringify({
        sig: "1:5,30,60,300,1200",
        powerCurve: [{ seconds: 5, watts: 900 }],
        powerZoneSeconds: [],
      })
    );
    // The unusable prior drops OUT of the population — it is not re-derived from
    // its streams, and it does not contribute its 900 W either.
    const record = detail("Synthetic record ride");
    expect(record.bests.comparedPowerRides).toBe(1);
    expect(record.bests.power).toEqual([]);
    setSummary("Synthetic first ride", restore);
    expect(detail("Synthetic record ride").bests.comparedPowerRides).toBe(2);
  });
});

describe("getRideBestRecaps", () => {
  it("names the LONGEST duration won and the population it was best of", () => {
    const recaps = getRideBestRecaps(profileId, "2026-06-03", 5000);
    expect(recaps).toEqual([
      {
        activityId: rides.get("Synthetic beaten ride"),
        activityName: "Cycling",
        // 20 min, not the 5 sec it also won: a five-second best is a sprint out
        // of a junction, a twenty-minute best is the ride.
        headline: {
          kind: "power",
          seconds: 1200,
          watts: 500,
          comparedRides: 3,
        },
        segmentPrNames: [],
      },
    ]);
    // The sentence names the window rather than saying "ever" (#2385).
    expect(
      rideBestStatementDetail("20 min power", recaps[0]!.headline!)
    ).toBe("Best 20 min power of 3 rides with recorded power");
  });

  it("celebrates nothing on the first ride with power", () => {
    expect(
      getRideBestRecaps(profileId, "2026-06-01", 5000)[0]!.headline
    ).toBeNull();
  });

  it("carries the ride's own pr_rank = 1 efforts and no others", () => {
    const rideId = rides.get("Synthetic beaten ride")!;
    const insert = db.prepare(
      `INSERT INTO activity_segment_efforts
         (profile_id, activity_id, source, external_id, name, start_index, pr_rank)
       VALUES (?, ?, 'strava', ?, ?, ?, ?)`
    );
    insert.run(profileId, rideId, "e2e-effort-31", "Berry descent", 10, 1);
    insert.run(profileId, rideId, "e2e-effort-32", "Sandy Hill", 20, 1);
    insert.run(profileId, rideId, "e2e-effort-33", "Mill Lane", 30, 2);
    insert.run(
      profileId,
      rides.get("Synthetic record ride")!,
      "e2e-effort-34",
      "Other day climb",
      10,
      1
    );
    expect(
      getRideBestRecaps(profileId, "2026-06-03", 5000)[0]!.segmentPrNames
    ).toEqual(["Berry descent", "Sandy Hill"]);
  });
});
