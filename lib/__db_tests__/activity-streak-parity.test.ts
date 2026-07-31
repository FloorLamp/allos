// DB INTEGRATION TIER — #1398: the three surfaces that show a "streak" must show the
// SAME number.
//
// The bug: the Training/Journal week-summary tile built its number from the strict
// currentStreak (which dies on the first rest day) while the milestone engine and the
// weekly recap built theirs from the rest-tolerant flexibleStreak — so one profile could
// be congratulated on an N-day activity streak while the page tile read 1. The pure tier
// can pin the math, but only this tier can prove the three GATHERS agree on one profile,
// which is the layer the drift actually lived in.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { getJournalWeekSummary } from "@/lib/queries";
import { gatherMilestoneInput } from "@/lib/milestones-db";
import { gatherRecapInput } from "@/lib/notifications/weekly-recap-data";
import { activityStreak, currentStreak } from "@/lib/streak";

let profileId: number;
let todayStr: string;
let activeDates: string[];

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run("STREAKPARITY")
      .lastInsertRowid
  );
  todayStr = today(profileId);
  // A realistic rest-day rhythm relative to the profile's own "today" (never a
  // hard-coded calendar date): trained today, rested yesterday, trained the three
  // days before that. Strict = 1, rest-tolerant = 4 — the exact fixture that made
  // the two engines disagree.
  activeDates = [
    todayStr,
    shiftDateStr(todayStr, -2),
    shiftDateStr(todayStr, -3),
    shiftDateStr(todayStr, -4),
  ];
  const insert = db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min)
     VALUES (?, ?, 'strength', 'Streak parity session', 30)`
  );
  for (const d of activeDates) insert.run(profileId, d);
});

describe("activity streak parity across surfaces (#1398)", () => {
  it("the fixture is one where the two variants disagree", () => {
    expect(currentStreak(todayStr, activeDates)).toBe(1);
    expect(activityStreak(todayStr, activeDates)).toBe(4);
  });

  it("the week-summary tile, the milestone engine, and the recap read one number", () => {
    const expected = activityStreak(todayStr, activeDates);
    expect(getJournalWeekSummary(profileId).streak).toBe(expected);
    expect(gatherMilestoneInput(profileId).streak).toBe(expected);
    expect(gatherRecapInput(profileId).streak).toBe(expected);
  });

  it("the recap keeps the strict count under its own separate label", () => {
    // Both semantics survive — but the strict one travels as `strictStreak` and
    // renders as the "N-day consecutive" delta, never as the word "streak" alone.
    const recap = gatherRecapInput(profileId);
    expect(recap.strictStreak).toBe(currentStreak(todayStr, activeDates));
    expect(recap.strictStreak).not.toBe(recap.streak);
  });
});
