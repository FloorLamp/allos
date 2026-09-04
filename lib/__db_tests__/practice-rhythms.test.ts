// DB INTEGRATION TIER — the per-practice weekly rhythm the day chart's window reads
// (#4950 item 4).
//
// The inference itself is pure and has its own table (lib/__tests__/weekly-rhythm.ts).
// What is pinned HERE is what the database contributes: one read, folded by canonical
// identity so two spellings of one practice cannot hold two rhythms, and scoped to the
// profile asking.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getPracticeRhythms } from "@/lib/queries/wellness";
import { practiceIdentity } from "@/lib/practice";
import { shiftDateStr } from "@/lib/date";

// A Thursday, and the day every fixture below is judged as of.
const ASOF = "2026-09-03";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function insertLog(
  profileId: number,
  date: string,
  practice: string,
  startTime: string | null
): void {
  db.prepare(
    `INSERT INTO practice_logs (profile_id, practice, date, start_time)
     VALUES (?, ?, ?, ?)`
  ).run(profileId, practice, date, startTime);
}

/** `weeks` Thursdays back from ASOF, all at one clock. */
function weeklyThursdays(
  profileId: number,
  practice: string,
  startTime: string | null,
  weeks = 6
): void {
  for (let i = 0; i < weeks; i++) {
    insertLog(profileId, shiftDateStr(ASOF, -7 * i), practice, startTime);
  }
}

const key = (practice: string): string => practiceIdentity(practice)!;

describe("getPracticeRhythms", () => {
  it("infers a rhythm per practice and folds spelling variants into one", () => {
    const profileId = newProfile("Rhythms");
    weeklyThursdays(profileId, "Sauna", "19:00", 3);
    // The same practice, spelled differently — one identity, so one rhythm rather than
    // two half-populated ones that would each read as no pattern.
    for (let i = 3; i < 6; i++) {
      insertLog(profileId, shiftDateStr(ASOF, -7 * i), "sauna", "19:00");
    }
    weeklyThursdays(profileId, "Rowing", "06:00");

    const rhythms = getPracticeRhythms(profileId, ASOF);
    expect([...rhythms.keys()].sort()).toEqual(
      [key("Sauna"), key("Rowing")].sort()
    );
    expect(rhythms.get(key("Sauna"))).toMatchObject({
      hour: 19,
      hasPattern: true,
    });
    expect(rhythms.get(key("Sauna"))!.weekdays).toEqual([4]);
    expect(rhythms.get(key("Rowing"))).toMatchObject({ hour: 6 });
  });

  it("says a practice logged on no particular day has no pattern", () => {
    // #558's honesty rule at the store boundary: the every-day fallback comes back
    // with `hasPattern: false`, so a caller cannot read it as "every day".
    const profileId = newProfile("Rhythms scattered");
    for (const offset of [0, 1, 2, 3, 4, 5, 6, 7]) {
      insertLog(profileId, shiftDateStr(ASOF, -offset), "Walk", "12:00");
    }
    expect(getPracticeRhythms(profileId, ASOF).get(key("Walk"))).toMatchObject({
      hasPattern: false,
    });
  });

  it("reads only the profile asking", () => {
    const mine = newProfile("Rhythms mine");
    const theirs = newProfile("Rhythms theirs");
    weeklyThursdays(mine, "Sauna", "19:00");
    weeklyThursdays(theirs, "Rowing", "06:00");
    const rhythms = getPracticeRhythms(mine, ASOF);
    expect([...rhythms.keys()]).toEqual([key("Sauna")]);
  });

  it("holds nothing for a profile that has logged nothing", () => {
    expect(getPracticeRhythms(newProfile("Rhythms empty"), ASOF).size).toBe(0);
  });
});
