// DB TIER — the week spine's row set (#2566, Viz 1).
//
// The issue's own test gap: "a DB-fixture assertion that blocks/ticks derive from the
// same week summary the caption states." The band and the two numbers used to be
// separate SQL; if they ever answer differently, the card shows a picture that
// contradicts its own caption. So the assertion is EQUALITY between the two, on a
// fixture whose every number is pinned by hand.
//
// The fixture pins `week_mode = rolling` on purpose: the band is then always
// [today − 6, today] whatever weekday the run's frozen clock lands on, so a day offset
// is a literal and not a calculation.

import { describe, it, expect, beforeAll } from "vitest";
import {
  getTrainingLogWeekSummary,
  getTrainingWeekDayTypes,
} from "@/lib/queries";
import { buildWeekSpine } from "@/lib/training-week-spine";
import { setWeekMode } from "@/lib/settings";
import { shiftDateStr } from "@/lib/date";
import { db, today } from "@/lib/db";

let profileId: number;
let todayStr: string;
const day = (offset: number) => shiftDateStr(todayStr, offset);

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run("SPINE")
      .lastInsertRowid
  );
  todayStr = today(profileId);
  setWeekMode(profileId, "rolling");

  const add = (offset: number, type: string, title: string) => {
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min)
       VALUES (?, ?, ?, ?, 30)`
    ).run(profileId, day(offset), type, title);
  };

  // Inside the rolling window, on three distinct days.
  add(0, "strength", "SPINE squats");
  add(0, "strength", "SPINE evening accessories");
  add(-1, "cardio", "SPINE easy run");
  add(-3, "sport", "SPINE pickup game");
  add(-3, "mobility", "SPINE mobility");
  // Outside it, at BOTH ends: eight days back, and tomorrow.
  add(-8, "strength", "SPINE last week");
  add(1, "cardio", "SPINE planned run");

  // TWO CREATE-AT-START DRAFTS inside the window (#3056) — started, never logged:
  // start_time set, no end_time, no stored duration, no sets/components/notes/
  // distance, no source. They are addresses, not entries, so every number pinned
  // below reads exactly as it did before they existed. One lands on a day that
  // already has sessions (counting it would move `sessions`); one lands on an
  // otherwise EMPTY day (counting it would move `activeDays` and light a band cell).
  addDraft(profileId, day(0), "strength", "SPINE draft on a busy day");
  addDraft(profileId, day(-5), "cardio", "SPINE draft on an empty day");
});

// A live session's row exactly as create-at-start writes it: dated, typed, titled,
// started, and carrying nothing else at all.
function addDraft(
  profile: number,
  date: string,
  type: string,
  title: string
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, start_time)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(profile, date, type, title, `${date}T09:00:00.000Z`).lastInsertRowid
  );
}

describe("getTrainingWeekDayTypes", () => {
  it("returns the profile's own rolling window, closed at both ends", () => {
    const week = getTrainingWeekDayTypes(profileId);
    expect(week.start).toBe(day(-6));
    expect(week.end).toBe(todayStr);
  });

  it("tallies (day, type) inside the window and drops both out-of-window rows", () => {
    const week = getTrainingWeekDayTypes(profileId);
    // No row for day(−5): its only activity is a draft, so the day has no tally at
    // all — not a tally of zero (#3056). Today stays at 2 despite its draft.
    expect(week.rows).toEqual([
      { date: day(-3), type: "mobility", count: 1 },
      { date: day(-3), type: "sport", count: 1 },
      { date: day(-1), type: "cardio", count: 1 },
      { date: todayStr, type: "strength", count: 2 },
    ]);
  });
});

describe("the spine and the caption are one computation", () => {
  it("lays the fixture on seven cells with pinned per-day sessions", () => {
    const week = getTrainingWeekDayTypes(profileId);
    const spine = buildWeekSpine({
      start: week.start,
      today: todayStr,
      rows: week.rows,
    });

    expect(spine.days.map((d) => d.date)).toEqual([
      day(-6),
      day(-5),
      day(-4),
      day(-3),
      day(-2),
      day(-1),
      todayStr,
    ]);
    // Cell 1 is day(−5), whose only row is a draft: an EMPTY day on the band.
    expect(spine.days.map((d) => d.sessions)).toEqual([0, 0, 0, 2, 0, 1, 2]);
    expect(spine.days[3].blocks).toEqual([
      { type: "sport", count: 1 },
      { type: "mobility", count: 1 },
    ]);
    expect(spine.days[6].blocks).toEqual([{ type: "strength", count: 2 }]);
    // A rolling window ends on today, so no cell is "ahead".
    expect(spine.days.filter((d) => d.state === "ahead")).toEqual([]);
    expect(spine.days[6].state).toBe("today");
  });

  it("folds to the SAME sessions and active days the week summary states", () => {
    const week = getTrainingWeekDayTypes(profileId);
    const spine = buildWeekSpine({
      start: week.start,
      today: todayStr,
      rows: week.rows,
    });
    const summary = getTrainingLogWeekSummary(profileId);

    // Pinned by hand: 2 (today) + 1 (−1) + 2 (−3) = 5 sessions on 3 days. Tomorrow's
    // planned run and last week's session are in neither number, and neither are the
    // two create-at-start drafts (#3056) — counting them would read 7 sessions on 4
    // days, which is the week the Training Log's feed refuses to show.
    expect(spine.sessions).toBe(5);
    expect(spine.activeDays).toBe(3);
    expect(summary.sessions).toBe(5);
    expect(summary.activeDays).toBe(3);
    expect([spine.sessions, spine.activeDays]).toEqual([
      summary.sessions,
      summary.activeDays,
    ]);
  });
});

// The other half of the rule (#3056): the week must drop a draft WITHOUT dropping a
// live session that has logged something. `isDraftActivityRow` is the only judge —
// these cases exist so the week is pinned to the whole rule, not to "start_time is
// set and end_time is not".
describe("a started session that logged something is still a session", () => {
  let liveId: number;
  let liveToday: string;

  beforeAll(() => {
    liveId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run("SPINE LIVE")
        .lastInsertRowid
    );
    liveToday = today(liveId);
    setWeekMode(liveId, "rolling");
  });

  const sessions = () => getTrainingLogWeekSummary(liveId).sessions;

  it("counts nothing when the day holds only an untouched draft", () => {
    addDraft(liveId, liveToday, "strength", "LIVE untouched");
    expect(sessions()).toBe(0);
  });

  it("counts a started session once a set is logged", () => {
    const id = addDraft(liveId, liveToday, "strength", "LIVE with a set");
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, 'Squat', 1, 60, 5)`
    ).run(id);
    expect(sessions()).toBe(1);
  });

  it("counts a started session that only carries a note", () => {
    const id = addDraft(liveId, liveToday, "cardio", "LIVE with a note");
    db.prepare("UPDATE activities SET notes = ? WHERE id = ?").run(
      "felt easy",
      id
    );
    expect(sessions()).toBe(2);
  });

  it("counts a started session that only carries a distance", () => {
    const id = addDraft(liveId, liveToday, "cardio", "LIVE with a distance");
    db.prepare("UPDATE activities SET distance_km = 5 WHERE id = ?").run(id);
    expect(sessions()).toBe(3);
  });

  it("counts an IMPORTED row that happens to be open-ended", () => {
    // Imports arrive whole, so `source` alone settles it — a provider row with a
    // start and no end is not a draft (lib/activity-draft.ts).
    const id = addDraft(liveId, liveToday, "cardio", "LIVE imported ride");
    db.prepare("UPDATE activities SET source = 'strava' WHERE id = ?").run(id);
    expect(sessions()).toBe(4);
  });

  it("counts a FINISHED session with nothing logged in it", () => {
    // Ending the session settles it too: an empty finished row is an entry the user
    // chose to keep, not an address.
    const id = addDraft(liveId, liveToday, "sport", "LIVE finished empty");
    db.prepare("UPDATE activities SET end_time = ? WHERE id = ?").run(
      `${liveToday}T10:00:00.000Z`,
      id
    );
    expect(sessions()).toBe(5);
  });

  it("still reports one active day, and the untouched draft never lit one", () => {
    const summary = getTrainingLogWeekSummary(liveId);
    expect(summary.activeDays).toBe(1);
    expect(summary.sessions).toBe(5);
  });
});
