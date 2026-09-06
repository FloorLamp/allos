// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #3428 item 5, first step — the SQL-side day bucketing. A day is a
// profile-local question, and after a travel switch every PAST day was being re-spanned
// under the zone the profile is standing in now: on prod (profile 1, New York →
// Los Angeles at 2026-08-21T02:11:41Z) the HR daily summary and the glucose day window
// both began cutting history at 07:00Z instead of at 04:00Z, so "Aug 19" stopped
// meaning the same window as the stored `date` columns beside it on the same page.
//
// The pure tier pins the window arithmetic over literals
// (lib/__tests__/local-day-window.test.ts). What only a real profile can show is that
// the readers ASK the right question: `profileDayZone` over the recorded history rather
// than `getTimezone`. Each traveller therefore has a HOMEBODY twin — same rows, same
// current zone, no history — which is both the "unchanged for everyone who never moved"
// guarantee and the positive control that these fixtures can produce the wrong answer.

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { setTimezone, switchProfileTimezone } from "@/lib/settings";
import { getHrDailySummary } from "@/lib/queries/metrics";
import { getGlucoseTraceDay, recordGlucoseTrace } from "@/lib/glucose-trace-db";

const NY = "America/New_York"; // UTC−4 in August
const LA = "America/Los_Angeles"; // UTC−7 in August
const SOURCE = "manual";

// The prod switch instant, and a later "now" to read from — far enough after that no
// seeded day is today, so nothing comes back marked partial.
const SWITCH_INSTANT = "2026-08-21T02:11:41Z";
const READ_NOW = "2026-08-25T18:00:00Z";

// 05:00Z is the hour the two zones DISAGREE about: 01:00 the same morning in New York,
// 22:00 the evening before in Los Angeles. Every seeded reading sits there, so a row's
// day names which zone answered.
const PRE_DAYS = ["2026-08-18", "2026-08-19", "2026-08-20"];
const POST_ROW = "2026-08-22T05:00:00Z"; // 22:00 on the 21st in Los Angeles

beforeEach(() => {
  process.env.ALLOS_TEST_NOW = SWITCH_INSTANT;
  return () => {
    delete process.env.ALLOS_TEST_NOW;
  };
});

function profile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function hrMinute(profileId: number, ts: string, bpm: number): void {
  db.prepare(
    `INSERT INTO hr_minutes (profile_id, ts, bpm, bpm_min, bpm_max, n, source)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).run(profileId, ts, bpm, bpm, bpm, SOURCE);
}

// A profile that recorded its readings in New York and then flew west, and its twin
// that has simply always been in Los Angeles. The two hold identical rows.
function traveller(name: string): number {
  const profileId = profile(name);
  setTimezone(profileId, NY);
  switchProfileTimezone(profileId, LA, NY);
  return profileId;
}

function homebody(name: string): number {
  const profileId = profile(name);
  setTimezone(profileId, LA);
  return profileId;
}

function seedHr(profileId: number): void {
  PRE_DAYS.forEach((day, i) => hrMinute(profileId, `${day}T05:00:00Z`, 60 + i));
  hrMinute(profileId, POST_ROW, 70);
}

describe("the HR daily summary buckets each day in the zone it was lived in", () => {
  it("keeps the pre-switch days on New York midnights and the later one on Los Angeles'", () => {
    const moved = traveller("HR-BUCKET-TRAVELLER");
    const stayed = homebody("HR-BUCKET-HOMEBODY");
    seedHr(moved);
    seedHr(stayed);
    process.env.ALLOS_TEST_NOW = READ_NOW;

    // Each reading lands on the calendar day its own clock was showing: the three New
    // York mornings, and the Los Angeles evening of the 21st.
    expect(
      getHrDailySummary(moved).map(({ date, avg }) => ({ date, avg }))
    ).toEqual([
      { date: "2026-08-18", avg: 60 },
      { date: "2026-08-19", avg: 61 },
      { date: "2026-08-20", avg: 62 },
      { date: "2026-08-21", avg: 70 },
    ]);

    // THE CONTROL, through the same reader on the same rows: with no history to read,
    // every 05:00Z reading is the previous Los Angeles evening — which is what the
    // traveller's own history used to say about its past, and is still exactly right
    // for a profile that never moved.
    expect(
      getHrDailySummary(stayed).map(({ date, avg }) => ({ date, avg }))
    ).toEqual([
      { date: "2026-08-17", avg: 60 },
      { date: "2026-08-18", avg: 61 },
      { date: "2026-08-19", avg: 62 },
      { date: "2026-08-21", avg: 70 },
    ]);
  });

  // The 27-hour switch day (#3263's stated consequence, not a defect): it opens on New
  // York's midnight and closes on Los Angeles' next one, so it holds BOTH the reading
  // the old clock called 00:30 and the one the new clock called 22:00 the same evening.
  // The homebody's 20th is an ordinary 24 hours and holds neither of those two.
  it("gives the switch day both sides of the seam, and no reading to two days", () => {
    const moved = traveller("HR-BUCKET-SEAM");
    const stayed = homebody("HR-BUCKET-SEAM-HOME");
    for (const p of [moved, stayed]) {
      hrMinute(p, "2026-08-20T04:30:00Z", 50); // 00:30 on the 20th in New York
      hrMinute(p, "2026-08-21T05:00:00Z", 90); // 22:00 on the 20th in Los Angeles
      hrMinute(p, "2026-08-21T09:00:00Z", 95); // 02:00 on the 21st in Los Angeles
    }
    process.env.ALLOS_TEST_NOW = READ_NOW;

    expect(getHrDailySummary(moved)).toEqual([
      { date: "2026-08-20", avg: 70, min: 50, max: 90 },
      { date: "2026-08-21", avg: 95, min: 95, max: 95 },
    ]);
    expect(getHrDailySummary(stayed)).toEqual([
      { date: "2026-08-19", avg: 50, min: 50, max: 50 },
      { date: "2026-08-20", avg: 90, min: 90, max: 90 },
      { date: "2026-08-21", avg: 95, min: 95, max: 95 },
    ]);
  });
});

describe("the glucose day window keeps its edges across a switch", () => {
  it("still returns a pre-switch day's points, and recomputes that day rather than a new one", () => {
    const moved = traveller("CGM-TRAVELLER");
    const stayed = homebody("CGM-HOMEBODY");
    const points = [
      { ts: "2026-08-19T05:00:00Z", mgdl: 100 }, // 01:00 on the 19th in New York
      { ts: "2026-08-19T06:00:00Z", mgdl: 120 },
    ];
    const first = recordGlucoseTrace(moved, points, SOURCE);
    recordGlucoseTrace(stayed, points, SOURCE);
    expect(first.days).toEqual(["2026-08-19"]);
    process.env.ALLOS_TEST_NOW = READ_NOW;

    // The window that held these points while they were being logged still holds them.
    expect(getGlucoseTraceDay(moved, "2026-08-19", SOURCE)).toEqual(points);
    // The twin's identical readings are a Los Angeles evening, and stay one.
    expect(getGlucoseTraceDay(stayed, "2026-08-19", SOURCE)).toEqual([]);
    expect(getGlucoseTraceDay(stayed, "2026-08-18", SOURCE)).toEqual(points);

    // A rolling re-push after the move is an UPDATE of the day it already summarised.
    // The derived rows are keyed on `started_at`, which is that day's own local
    // midnight, so a boundary that walked would land a SECOND set of rows here.
    const replay = recordGlucoseTrace(moved, points, SOURCE);
    expect(replay.days).toEqual(["2026-08-19"]);
    expect(replay.derived.inserted).toBe(0);
    expect(
      db
        .prepare(
          `SELECT DISTINCT date, started_at FROM metric_samples
            WHERE profile_id = ? AND metric LIKE 'glucose%'`
        )
        .all(moved)
    ).toEqual([{ date: "2026-08-19", started_at: "2026-08-19T04:00:00Z" }]);
  });
});
