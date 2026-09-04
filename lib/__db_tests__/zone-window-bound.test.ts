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
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { beforeAll, describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { getHrMinutesInRange } from "@/lib/queries/metrics";
import { getDayLoadInputs, getIntensitySignal } from "@/lib/queries/zones";
import { setMaxHrOverride } from "@/lib/settings";

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
