// DB INTEGRATION TIER — the offline dose schedule asks the same day question the
// medications page asks (#5321).
//
// #5167 closed the SITUATIONS field of the intake day context; this is the rest of the
// object. The page's builder answers FIVE fields and the snapshot answered THREE, and
// the two missing ones diverge in OPPOSITE directions:
//
//   • no `predictedWorkoutDay` ⇒ a pre-workout dose keys on "a session was already
//     logged" instead of the inferred cadence (#558), so the snapshot OMITS a dose the
//     page offers on a predicted training day;
//   • no `postWorkoutReady` ⇒ `conditionAppliesOn` reads `ctx.postWorkoutReady ?? true`,
//     so an omitted field does not merely lose a condition, it DEFAULTS TO PERMISSIVE
//     and the snapshot OFFERS a dose the page holds until the session has ended.
//
// The acceptance is "five fields, and the defaults are not neutral" — both directions,
// because the `?? true` is what made the omission silent.
//
// OFFLINE IS WHAT SOMEONE READS WITH NO SIGNAL. /offline renders the schedule as rows
// with no control on them, so the acting happens in the world rather than in the app.
// Telling someone that nothing is owed while the page they cannot reach says a dose is
// due is the harm #5167 argued, one field over.
//
// Fixtures are 100% synthetic (a throwaway per-file DB via setup.ts). No AI, no network.

import { describe, it, expect, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr, weekdayOfDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { buildSnapshot, snapshotContext } from "@/lib/offline/snapshot-build";
import type { DoseScheduleEntry } from "@/lib/offline/snapshots";
import { loadMedicationsData } from "@/app/(app)/medications/med-data";
import type { IntakeCondition } from "@/lib/types";

let seq = 0;

function newProfile(): number {
  const id = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run(`Offline Day Context ${seq++}`).lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

function logWorkout(
  profileId: number,
  date: string,
  start = "07:00",
  end = "07:45"
): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min, start_time, end_time)
     VALUES (?, ?, 'strength', 'Session', 45, ?, ?)`
  ).run(profileId, date, start, end);
}

// One active, daily-cadence item with one dose, on the given day condition.
//
// Kind `medication` because that is the set BOTH surfaces answer about: the offline
// schedule carries every active intake item, while the medications board is the page
// whose builder this issue compares against. The day condition is what is under test,
// and it reads the same on either kind.
function seedItem(
  profileId: number,
  name: string,
  condition: IntakeCondition
): void {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, kind, condition, obligation, active)
         VALUES (?, ?, 'medication', ?, 'should', 1)`
      )
      .run(profileId, name, condition).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 dose', 'Morning', 'any', 0)`
  ).run(itemId);
}

/** The doses the offline snapshot would put on the device. */
function offlineDoseNames(profileId: number): string[] {
  const snap = buildSnapshot(
    "dose-schedule",
    snapshotContext(profileId, 1),
    new Date()
  );
  return (snap.data as { entries: DoseScheduleEntry[] }).entries.map(
    (d) => d.name
  );
}

/** The doses the medications page counts as due today, by item name. */
function pageDueNames(profileId: number): string[] {
  const data = loadMedicationsData(profileId);
  const names: string[] = [];
  for (const card of data.byId.values())
    for (const _dose of card.dueDoseIds) names.push(card.med.name);
  return names.sort();
}

describe("the offline day context is the page's day context (#5321)", () => {
  it("offers the pre-workout dose the page offers on a PREDICTED training day", () => {
    const p = newProfile();
    const td = today(p);
    // A weekly cadence on today's weekday, ending a week ago: nothing is logged for
    // today, so only the prediction can say this is a training day.
    for (let w = 1; w <= 8; w++) logWorkout(p, shiftDateStr(td, -w * 7));
    expect(weekdayOfDateStr(td)).toBe(weekdayOfDateStr(shiftDateStr(td, -7)));

    seedItem(p, "Pre-exercise inhaler", "pre_workout");

    // The measured defect: {taken:0, due:0} offline against {taken:0, due:1} on the page.
    expect(pageDueNames(p)).toEqual(["Pre-exercise inhaler"]);
    expect(offlineDoseNames(p)).toEqual(["Pre-exercise inhaler"]);
  });

  it("holds the post-workout dose the page holds until the session has ended", () => {
    const p = newProfile();
    const td = today(p);
    vi.setSystemTime(new Date(`${td}T09:00:00.000Z`));
    // A session is logged for today and is not over yet.
    logWorkout(p, td, "17:00", "18:00");
    seedItem(p, "Recovery tablet", "post_workout");

    // The opposite direction, and the silent one: an omitted `postWorkoutReady` reads
    // as permissive, so the snapshot offered this dose nine hours early.
    expect(pageDueNames(p)).toEqual([]);
    expect(offlineDoseNames(p)).toEqual([]);
  });

  it("offers the post-workout dose once the session is over", () => {
    // The control: the hold is the session's end time, not the condition itself.
    const p = newProfile();
    const td = today(p);
    vi.setSystemTime(new Date(`${td}T19:00:00.000Z`));
    logWorkout(p, td, "17:00", "18:00");
    seedItem(p, "Recovery tablet", "post_workout");

    expect(pageDueNames(p)).toEqual(["Recovery tablet"]);
    expect(offlineDoseNames(p)).toEqual(["Recovery tablet"]);
  });
});
