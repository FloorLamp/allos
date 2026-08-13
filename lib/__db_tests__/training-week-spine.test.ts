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
  add(-3, "recovery", "SPINE mobility");
  // Outside it, at BOTH ends: eight days back, and tomorrow.
  add(-8, "strength", "SPINE last week");
  add(1, "cardio", "SPINE planned run");
});

describe("getTrainingWeekDayTypes", () => {
  it("returns the profile's own rolling window, closed at both ends", () => {
    const week = getTrainingWeekDayTypes(profileId);
    expect(week.start).toBe(day(-6));
    expect(week.end).toBe(todayStr);
  });

  it("tallies (day, type) inside the window and drops both out-of-window rows", () => {
    const week = getTrainingWeekDayTypes(profileId);
    expect(week.rows).toEqual([
      { date: day(-3), type: "recovery", count: 1 },
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
    expect(spine.days.map((d) => d.sessions)).toEqual([0, 0, 0, 2, 0, 1, 2]);
    expect(spine.days[3].blocks).toEqual([
      { type: "sport", count: 1 },
      { type: "recovery", count: 1 },
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
    // planned run and last week's session are in neither number.
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
