import { beforeEach, describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { shiftDateStr } from "@/lib/date";
import { getArrivalLagMinutes } from "@/lib/queries/integrations";

// DB INTEGRATION TIER — the ONE arrival measurement (#5001).
//
// `getSleepArrivalLagMinutes` measured how long after a night ends its row lands, and
// nothing in it was about sleep. Extracted, it answers the same question for any
// source and any row kind — which is what lets the practice bound and the recap's
// provisional line stop guessing. What is pinned here is the half the sleep tests
// never covered: ACTIVITIES, whose end is a profile-local wall clock and not a stored
// UTC instant, and the source filter that keeps two pipelines' rhythms apart.

const STRAVA = "strava";
const HC = "health-connect";

let profileId: number;
let day: string;

function ride(date: string, endClock: string, source = STRAVA): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, start_time, end_time, duration_min, source)
         VALUES (?, ?, 'cardio', 'Ride', '07:00', ?, 60, ?)`
      )
      .run(profileId, date, endClock, source).lastInsertRowid
  );
}

function arrival(
  table: "activities" | "metric_samples",
  targetId: number,
  atUtcSql: string,
  source = STRAVA
): void {
  const eventId = Number(
    db
      .prepare(
        `INSERT INTO integration_sync_events (profile_id, source_id, at, ok, inserted)
         VALUES (?, ?, ?, 1, 1)`
      )
      .run(profileId, source, atUtcSql).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO integration_sync_rows
       (event_id, target_table, target_id, disposition, created_at)
     VALUES (?, ?, ?, 'inserted', ?)`
  ).run(eventId, table, targetId, atUtcSql);
}

/** A ride ending at 08:00 local, landing `lagMin` minutes later. */
function rideArrivingAfter(dayOffset: number, lagMin: number): void {
  const date = shiftDateStr(day, -dayOffset);
  const id = ride(date, "08:00");
  const at = new Date(Date.parse(`${date}T08:00:00Z`) + lagMin * 60_000);
  arrival("activities", id, at.toISOString().replace(/\.\d{3}Z$/, "Z"));
}

beforeEach(() => {
  db.exec("DELETE FROM integration_sync_rows");
  db.exec("DELETE FROM integration_sync_events");
  db.exec("DELETE FROM activities");
  db.exec("DELETE FROM metric_samples");
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('ARRIVAL')").run()
      .lastInsertRowid
  );
  setTimezone(profileId, "UTC");
  day = shiftDateStr(today(profileId), -1);
});

describe("getArrivalLagMinutes over activities", () => {
  it("medians the gap from a ride's own END, not from its day", () => {
    // Five rides, 30/40/50/60/70 minutes late. The median is the middle one, and it
    // is measured from 08:00 — an activity states a local day plus a wall clock, and
    // measuring from the day would put every one of these ~8 hours out.
    for (const [i, lag] of [30, 40, 50, 60, 70].entries()) {
      rideArrivingAfter(i + 1, lag);
    }
    expect(
      getArrivalLagMinutes(profileId, {
        targetTable: "activities",
        sourceId: STRAVA,
      })
    ).toBe(50);
  });

  it("drops an ARCHIVE backfill, whose lag is months", () => {
    for (const [i, lag] of [30, 40, 50, 60, 70].entries()) {
      rideArrivingAfter(i + 1, lag);
    }
    // A bulk export re-inserting an old ride. Its "lag" is 60 days, and letting it in
    // would quote a rhythm nobody's pipeline has.
    const old = shiftDateStr(day, -60);
    const id = ride(old, "08:00");
    arrival("activities", id, `${day}T08:00:00Z`);
    expect(
      getArrivalLagMinutes(profileId, {
        targetTable: "activities",
        sourceId: STRAVA,
      })
    ).toBe(50);
  });

  it("refuses a median under the sample gate", () => {
    for (const [i, lag] of [30, 40, 50].entries()) {
      rideArrivingAfter(i + 1, lag);
    }
    expect(
      getArrivalLagMinutes(profileId, {
        targetTable: "activities",
        sourceId: STRAVA,
      })
    ).toBeNull();
  });

  it("keeps two sources' rhythms apart", () => {
    for (const [i, lag] of [30, 40, 50, 60, 70].entries()) {
      rideArrivingAfter(i + 1, lag);
    }
    // Health Connect lands about ten minutes after; Strava polls. Asking for one
    // must never average in the other.
    for (const [i, lag] of [8, 9, 10, 11, 12].entries()) {
      const date = shiftDateStr(day, -(i + 1));
      const id = ride(date, "18:00", HC);
      const at = new Date(Date.parse(`${date}T18:00:00Z`) + lag * 60_000);
      arrival("activities", id, at.toISOString().replace(/\.\d{3}Z$/, "Z"), HC);
    }
    expect(
      getArrivalLagMinutes(profileId, {
        targetTable: "activities",
        sourceId: HC,
      })
    ).toBe(10);
    expect(
      getArrivalLagMinutes(profileId, {
        targetTable: "activities",
        sourceId: STRAVA,
      })
    ).toBe(50);
  });

  it("ignores a ride whose window cannot be bounded", () => {
    // No end and no duration is no window, and an arrival measured from a day rather
    // than a moment is a different quantity. Four bounded rides is under the gate.
    for (const [i, lag] of [30, 40, 50, 60].entries()) {
      rideArrivingAfter(i + 1, lag);
    }
    const id = Number(
      db
        .prepare(
          `INSERT INTO activities
             (profile_id, date, type, title, start_time, end_time, duration_min, source)
           VALUES (?, ?, 'cardio', 'Ride', '07:00', NULL, NULL, ?)`
        )
        .run(profileId, shiftDateStr(day, -5), STRAVA).lastInsertRowid
    );
    arrival("activities", id, `${shiftDateStr(day, -5)}T08:00:00Z`);
    expect(
      getArrivalLagMinutes(profileId, {
        targetTable: "activities",
        sourceId: STRAVA,
      })
    ).toBeNull();
  });

  it("resolves the ride's end through the PROFILE's zone, not as UTC", () => {
    // The reason this half is not SQL. An activity states a local day and a wall
    // clock; `julianday()` over "2026-09-03T08:00" would read it as UTC and report
    // the zone offset as lag — here that is five hours of pure fiction, on every row.
    setTimezone(profileId, "America/New_York");
    for (const [i, lag] of [30, 40, 50, 60, 70].entries()) {
      const date = shiftDateStr(day, -(i + 1));
      const id = ride(date, "08:00");
      // 08:00 in New York is 12:00Z in September.
      const at = new Date(Date.parse(`${date}T12:00:00Z`) + lag * 60_000);
      arrival("activities", id, at.toISOString().replace(/\.\d{3}Z$/, "Z"));
    }
    expect(
      getArrivalLagMinutes(profileId, {
        targetTable: "activities",
        sourceId: STRAVA,
      })
    ).toBe(50);
  });

  it("does not count another profile's arrivals", () => {
    for (const [i, lag] of [30, 40, 50, 60, 70].entries()) {
      rideArrivingAfter(i + 1, lag);
    }
    const other = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('OTHER')").run()
        .lastInsertRowid
    );
    setTimezone(other, "UTC");
    expect(
      getArrivalLagMinutes(other, {
        targetTable: "activities",
        sourceId: STRAVA,
      })
    ).toBeNull();
  });
});
