// DB INTEGRATION TIER — issue #5069: the two dashboard zone reads scan the window
// they mean, not "to the last stored hr_minutes row".
//
// THE FIXTURE IS THE TEST HERE. `getDayLoadInputs` and `getIntensitySignal` both ask
// for a trailing 42 days; they used to pass no upper bound, so the shared read ran to
// the profile's last stored instant. On a profile whose rows stop at today that is the
// intended window by COINCIDENCE — which is why a fixture stopping at today cannot
// observe the defect and passes identically either side of the fix. This one stores a
// session THIRTY DAYS AHEAD of the profile-local today, the fast-clock condition #5035
// exists for and the shape #5069 measured on a snapshot.
//
// #5079 reuses that same fixture for the OTHER half of `getDayLoadInputs`: its activity
// read kept no upper bound when #5069 bounded the HR read beside it, so the ahead-dated
// session still arrived as a day carrying minutes and an intent — a day the coach counts
// as trained. The fixture's ahead session is therefore asserted to exist as an ACTIVITY
// row too, not only as hr_minutes; see the control below.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { beforeAll, describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr, utcMinute, zonedWallTimeToUtc } from "@/lib/date";
import { getHrMinutesInRange } from "@/lib/queries/metrics";
import {
  getDayLoadInputs,
  getIntensitySignal,
  getTrainingZoneData,
} from "@/lib/queries/zones";
import { getTimezone, setMaxHrOverride } from "@/lib/settings";

const SESSION_MIN = 30; // minutes of HR seeded per session
const HARD_BPM = 150; // Zone 4 at maxHr 180 — a hard minute either side of the bound
const AHEAD_DAYS = 30; // how far past today the fast-clock rows are stamped
const WINDOW_DAYS = 42; // the trailing window both reads default to

// A windowed session on `date` (08:00–09:00) carrying SESSION_MIN minutes of HR at a
// constant bpm, so the day's easy/hard split is unambiguous and its minutes are inside
// an activity window (the zone reads count only scoped minutes).
function seedSession(profileId: number, date: string): void {
  db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, duration_min, start_time, end_time)
     VALUES (?, ?, 'cardio', 'ride', 60, '08:00', '09:00')`
  ).run(profileId, date);
  const ins = db.prepare(
    "INSERT INTO hr_minutes (profile_id, ts, bpm, n, source) VALUES (?, ?, ?, 1, 'oura')"
  );
  for (let m = 0; m < SESSION_MIN; m++) {
    ins.run(profileId, `${date}T08:${String(m).padStart(2, "0")}`, HARD_BPM);
  }
}

describe("dashboard zone reads stop at the window's end (#5069)", () => {
  let profileId = 0;
  let td = "";
  let since = "";
  let ahead = "";

  beforeAll(() => {
    profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('Fast Clock')").run()
        .lastInsertRowid
    );
    setMaxHrOverride(profileId, 180); // percent-max model, no resting HR needed
    td = today(profileId);
    since = shiftDateStr(td, -(WINDOW_DAYS - 1));
    ahead = shiftDateStr(td, AHEAD_DAYS);
    seedSession(profileId, shiftDateStr(td, -1)); // inside the window
    seedSession(profileId, ahead); // the device that stamps ahead
  });

  // THE CONTROL COMES FIRST BECAUSE AN EMPTY FUTURE IS THE FLATTERING ANSWER: with no
  // rows past the window, both checks below pass on the unfixed tree.
  it("stores minutes past the window, so the checks below can observe an unbounded read", () => {
    expect(
      getHrMinutesInRange(profileId, ahead, ahead).length,
      `the fixture stored no hr_minutes on ${ahead}, which is ${AHEAD_DAYS} days past ` +
        `the window ending ${td} — nothing below could tell a bounded read from an ` +
        `unbounded one`
    ).toBe(SESSION_MIN);
    // The ACTIVITY row on the same day is the control for the load read (#5079): it is
    // what an unbounded activity scan would turn into a day with minutes and an intent.
    expect(
      db
        .prepare(
          "SELECT date FROM activities WHERE profile_id = ? AND date > ? ORDER BY date"
        )
        .all(profileId, td),
      `the fixture stored no activities row past ${td}, so the load check below would ` +
        `pass on a window that was never asked to stop`
    ).toEqual([{ date: ahead }]);
  });

  it("getDayLoadInputs splits no day after today", () => {
    const hrDays = getDayLoadInputs(profileId)
      .filter((input) => input.split)
      .map((input) => input.date)
      .sort();
    const beyond = hrDays.filter((day) => day > td);
    expect(
      beyond,
      `the zone read reached ${beyond.join(", ") || "(none)"}; its window is ` +
        `${since} … ${td}. The listed days lie past the window's end, so the read ran ` +
        `to the last stored hr_minutes row (${ahead}) instead of to today.`
    ).toEqual([]);
    // The converse, in the same test: bounding the scan must not empty it. The in-window
    // session still splits, so an empty `beyond` above means "bounded", not "blind".
    expect(hrDays).toEqual([shiftDateStr(td, -1)]);
  });

  // #5079: the same function's ACTIVITY half. Once #5069's bound is in place the
  // ahead-dated day has no HR split, so the check above no longer sees it — but its
  // activity row still produced a DayLoadInput. This test is about that row arriving
  // at all: a day with a duration and no split is a loading day to `isLoadingDay`
  // (60 min clears the duration floor), and a day with neither falls through to
  // LOADING as well, so there is no shape of it that the coach ignores.
  it("getDayLoadInputs returns no day at all past the window's end", () => {
    const days = getDayLoadInputs(profileId).map((input) => input.date);
    const beyond = days.filter((day) => day > td);
    expect(
      beyond,
      `getDayLoadInputs answered about ${beyond.join(", ") || "(none)"}; its window is ` +
        `${since} … ${td}. A day past that end has not happened, so nothing logged on ` +
        `it can be load — the activity read ran past ${td} while the HR read beside it ` +
        `stopped there, and the coach counts the day as trained.`
    ).toEqual([]);
    // Converse: the bound must not empty the read. The in-window session is still there.
    expect(days).toContain(shiftDateStr(td, -1));
  });

  it("getIntensitySignal counts only minutes inside the window", () => {
    const signal = getIntensitySignal(profileId)!;
    expect(
      signal.totalMin,
      `the split counted ${signal.totalMin} min over a window of ${since} … ${td}, ` +
        `which holds ${SESSION_MIN}. The extra minutes are the session on ${ahead}, ` +
        `past the window's end.`
    ).toBe(SESSION_MIN);
    // Converse again: the window's own minutes are all still hard (Zone 4 at maxHr 180),
    // so a passing count above is the in-window session and not a silenced read.
    expect(signal.hardMin).toBe(SESSION_MIN);
  });
});

it("uses inclusive day bounds rather than chart weeks or a next-day session tail", () => {
  const profileId = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES ('Historical zone window')")
      .run().lastInsertRowid
  );
  setMaxHrOverride(profileId, 180);
  const end = shiftDateStr(today(profileId), -10);
  const start = shiftDateStr(end, -2);
  const older = shiftDateStr(start, -1);
  const next = shiftDateStr(end, 1);
  const tz = getTimezone(profileId);
  const activity = db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, start_time, end_time, duration_min)
     VALUES (?, ?, 'cardio', 'Synthetic bounded session', ?, ?, ?)`
  );
  activity.run(profileId, older, "08:00", "08:01", 1);
  activity.run(profileId, start, "00:00", "00:01", 1);
  activity.run(profileId, end, "23:59", "00:01", 2);
  const minute = db.prepare(
    "INSERT INTO hr_minutes (profile_id, ts, bpm, n, source) VALUES (?, ?, ?, 1, 'health-connect')"
  );
  for (const [day, clock, bpm] of [
    [older, "08:00", 150],
    [start, "00:00", 110],
    [end, "23:59", 150],
    [next, "00:00", 150],
  ] as const) {
    minute.run(profileId, utcMinute(zonedWallTimeToUtc(tz, day, clock)!), bpm);
  }

  // Both decoys really exist: rounding to four weeks or extending through the
  // cross-midnight session would count them. The requested two boundary minutes stay.
  expect(getHrMinutesInRange(profileId, older, next)).toHaveLength(4);
  const data = getTrainingZoneData(profileId, 4, { start, end });
  expect(data.minutes).toEqual([0, 1, 0, 1, 0]);
  expect(data.split).toEqual({
    easyMin: 1,
    hardMin: 1,
    totalMin: 2,
    easyPct: 50,
    hardPct: 50,
  });
});
