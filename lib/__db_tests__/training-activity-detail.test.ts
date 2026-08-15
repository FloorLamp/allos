// DB INTEGRATION TIER — the activity page's assembly (#2870 step 1).
//
// The page's contract in four pins:
//   • THE RECORD IS THE LOG'S CARD — the assembled card is byte-comparable to the
//     one buildTrainingLogFeedPage builds for the same activity (one derivation,
//     two hosts; #2897's three-host rule starts here).
//   • SIBLINGS ARE THE DAY — the merge targets are exactly the other activities
//     of the same profile-local day, shaped as the log ships them (#64).
//   • NEIGHBORS WALK THE LEDGER — ‹older/newer› follow (date, id) order across
//     days and within a day.
//   • PROFILE SCOPING — another profile's activity id resolves to null, never to
//     a card.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect, beforeAll } from "vitest";
import { getActivityDetailData } from "@/lib/training-activity-detail";
import { buildTrainingLogFeedPage } from "@/lib/training-log-feed";
import type { UnitPrefs } from "@/lib/settings";
import { db } from "@/lib/db";

const UNITS: UnitPrefs = {
  weightUnit: "kg",
  distanceUnit: "km",
  temperatureUnit: "F",
};

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addActivity(
  profileId: number,
  date: string,
  title: string,
  type = "strength"
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min)
         VALUES (?, ?, ?, ?, 45)`
      )
      .run(profileId, date, type, title).lastInsertRowid
  );
}

function addSet(activityId: number, exercise: string, setNumber: number): void {
  db.prepare(
    `INSERT INTO exercise_sets
       (activity_id, exercise, set_number, weight_kg, reps, warmup)
     VALUES (?, ?, ?, 100, 5, 0)`
  ).run(activityId, exercise, setNumber);
}

let profileId: number;
let otherProfileId: number;
let mondayLegs: number;
let mondayWalk: number;
let wednesdayPush: number;

beforeAll(() => {
  profileId = newProfile("Detail Subject");
  otherProfileId = newProfile("Detail Other");
  mondayLegs = addActivity(profileId, "2026-03-02", "Legs");
  addSet(mondayLegs, "Back Squat", 1);
  addSet(mondayLegs, "Back Squat", 2);
  mondayWalk = addActivity(profileId, "2026-03-02", "Walk", "cardio");
  wednesdayPush = addActivity(profileId, "2026-03-04", "Push");
  addSet(wednesdayPush, "Barbell Bench Press", 1);
});

describe("getActivityDetailData (#2870)", () => {
  it("assembles the SAME card the training log feed builds", () => {
    const detail = getActivityDetailData(profileId, mondayLegs, UNITS);
    expect(detail).not.toBeNull();
    const feed = buildTrainingLogFeedPage(profileId, null, UNITS);
    const feedCard = feed.groups
      .flatMap((g) => g.cards)
      .find((c) => c.activity.id === mondayLegs);
    expect(feedCard).toBeDefined();
    expect(detail!.card).toEqual(feedCard);
  });

  it("ships the day's OTHER activities as merge siblings, log-shaped", () => {
    const detail = getActivityDetailData(profileId, mondayLegs, UNITS)!;
    expect(detail.siblings.map((s) => s.id)).toEqual([mondayWalk]);
    expect(detail.siblings[0].title).toBe("Walk");
    // A day with no siblings offers no merge targets.
    const solo = getActivityDetailData(profileId, wednesdayPush, UNITS)!;
    expect(solo.siblings).toEqual([]);
  });

  it("walks neighbors in (date, id) ledger order", () => {
    const mid = getActivityDetailData(profileId, mondayWalk, UNITS)!;
    expect(mid.olderId).toBe(mondayLegs);
    expect(mid.newerId).toBe(wednesdayPush);
    // The ledger's ends are honest nulls.
    expect(getActivityDetailData(profileId, mondayLegs, UNITS)!.olderId).toBe(
      null
    );
    expect(
      getActivityDetailData(profileId, wednesdayPush, UNITS)!.newerId
    ).toBe(null);
  });

  it("never resolves another profile's activity", () => {
    expect(getActivityDetailData(otherProfileId, mondayLegs, UNITS)).toBeNull();
  });

  it("carries an empty heart-rate block when no minutes are recorded", () => {
    const detail = getActivityDetailData(profileId, mondayLegs, UNITS)!;
    expect(detail.heartRate.minutes).toEqual([]);
    expect(detail.heartRate.zoneMinutes).toBeNull();
  });
});
