// DB INTEGRATION TIER — the offline dose schedule and the household card ask the same
// day question the medications page asks (#5321).
//
// #5167 closed the SITUATIONS field of the intake day context; this is the rest of the
// object. The page's builder answers FIVE fields and these two surfaces answered THREE,
// and the missing ones diverge in OPPOSITE directions:
//
//   • no `predictedWorkoutDay` ⇒ a pre-workout dose keys on "a session was already
//     logged" instead of the inferred cadence (#558), so the surface OMITS a dose the
//     page offers on a predicted training day;
//   • no `postWorkoutReady` ⇒ `conditionAppliesOn` reads `ctx.postWorkoutReady ?? true`,
//     so an omitted field does not merely lose a condition, it DEFAULTS TO PERMISSIVE
//     and the surface OFFERS a dose the page holds until the session has ended.
//
// The acceptance is "five fields, and the defaults are not neutral" — both directions,
// because the `?? true` is what made the omission silent.
//
// AND ONE OF THE FIVE IS A VERDICT, which is the axis the third describe below exists
// for. `postWorkoutReady` is a statement about the current MINUTE, and the offline
// payload is stored and read hours later, so the snapshot must ask the day's converged
// answer instead (`asOfWholeDay`) — this file's own first round did not, and froze a
// monotone gate that can only be wrong one way: it withholds. Asserting the two surfaces
// at ONE instant cannot see that. Instantaneous equality is the one property a snapshot
// does not need; what it needs is that its stored answer survives to READ TIME.
//
// OFFLINE IS WHAT SOMEONE READS WITH NO SIGNAL. /offline renders the schedule as rows
// with no control on them, so the acting happens in the world rather than in the app.
// Telling someone that nothing is owed while the page they cannot reach says a dose is
// due is the harm #5167 argued, one field over.
//
// NOTHING HERE COMPARES OFFLINE TO THE PAGE BEFORE THE EARLIEST SESSION END, AND THAT
// ABSENCE IS INTENT RATHER THAN OVERSIGHT. In that window the two deliberately still
// differ: the page holds the post-workout dose and the snapshot offers it, because the
// snapshot asks the DAY-shaped question (`asOfWholeDay`) and the day's converged answer
// is "the session has ended". Asserting agreement there would be asserting that a stored
// payload carries a wall-clock verdict, which is the thing this file's third describe
// exists to say it must not do. Closing that window means shipping the earliest session
// end time as a FACT the device evaluates against its own clock — a separate change with
// its own design, and the assertion belongs with it.
//
// Fixtures are 100% synthetic (a throwaway per-file DB via setup.ts). No AI, no network.

import { describe, it, expect, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr, weekdayOfDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { buildSnapshot, snapshotContext } from "@/lib/offline/snapshot-build";
import type { DoseScheduleEntry } from "@/lib/offline/snapshots";
import { loadMedicationsData } from "@/app/(app)/medications/med-data";
import { intakeAdherenceOn } from "@/lib/queries/household";
import {
  doseDayProgress,
  offeredItems,
} from "@/lib/queries/upcoming/intake-safety";
import { getOfferedIntakeForSlot } from "@/lib/queries/intake";
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
  condition: IntakeCondition,
  // `may` + a hint-less dose is the OFFER shape (#1505): nothing is owed, so the item
  // reaches the availability surfaces instead of the due ones, and a dose with no
  // stated time carries no slot opinion — which is what lets one item be asked about
  // at two different minutes without the slot filter deciding the answer.
  opts: { obligation?: "should" | "may"; timeOfDay?: string | null } = {}
): void {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, kind, condition, obligation, active)
         VALUES (?, ?, 'medication', ?, ?, 1)`
      )
      .run(profileId, name, condition, opts.obligation ?? "should")
      .lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 dose', ?, 'any', 0)`
  ).run(itemId, opts.timeOfDay === undefined ? "Morning" : opts.timeOfDay);
}

/** The doses the offline snapshot would put on the device, as built right now. */
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

describe("the offline schedule and the page predict the same training day (#5321)", () => {
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
});

describe("a live surface holds a post-workout dose until the session ends (#5321)", () => {
  // THE `?? true` DIRECTION, on the surfaces that RENDER rather than store. The household
  // card is read at the moment it is built, so it wants the same minute-shaped answer the
  // member's own page gives — and without the field it offered a dose that page holds.
  it("counts what the medications page counts, mid-session and after", () => {
    const p = newProfile();
    const td = today(p);
    seedItem(p, "Recovery tablet", "post_workout");
    logWorkout(p, td, "17:00", "18:00");

    vi.setSystemTime(new Date(`${td}T09:00:00.000Z`));
    expect(pageDueNames(p)).toEqual([]);
    expect(intakeAdherenceOn(p, td)).toEqual({ taken: 0, due: 0 });

    // The control: the hold is the session's end time, not the condition itself.
    vi.setSystemTime(new Date(`${td}T19:00:00.000Z`));
    expect(pageDueNames(p)).toEqual(["Recovery tablet"]);
    expect(intakeAdherenceOn(p, td)).toEqual({ taken: 0, due: 1 });
  });

  // THE THREE SURFACES #5637 LEFT, closed here as the behavior fix the PM ruled it is
  // (2026-09-09). Upcoming's dose rows, Upcoming's availability disclosure and the
  // quick-log sheet each assembled their own four-field context, so `?? true` unheld a
  // dose the page was holding — a person mid-session was offered a post-workout dose on
  // one surface and told to wait on another, about the same dose on the same day.
  //
  // Both directions, because a surface that simply never offered the dose would pass a
  // one-sided assertion: held before the earliest session end, offered after it.
  it("holds it on Upcoming and the quick-log sheet too, then offers it", () => {
    const p = newProfile();
    const td = today(p);
    // One item per surface shape: `should` reaches the due rows, `may` reaches the two
    // offer surfaces. Both are post-workout on the same session, so one gate decides.
    seedItem(p, "Recovery tablet", "post_workout");
    seedItem(p, "Recovery shake", "post_workout", {
      obligation: "may",
      timeOfDay: null,
    });
    logWorkout(p, td, "17:00", "18:00");

    vi.setSystemTime(new Date(`${td}T09:00:00.000Z`));
    expect(pageDueNames(p)).toEqual([]);
    expect(doseDayProgress(p, td)).toEqual({ scheduled: 0, taken: 0 });
    expect(offeredItems(p, td).map((i) => i.title)).toEqual([]);
    expect(getOfferedIntakeForSlot(p, "09:00").map((o) => o.name)).toEqual([]);

    vi.setSystemTime(new Date(`${td}T19:00:00.000Z`));
    expect(pageDueNames(p)).toEqual(["Recovery tablet"]);
    expect(doseDayProgress(p, td)).toEqual({ scheduled: 1, taken: 0 });
    expect(offeredItems(p, td).map((i) => i.title)).toEqual(["Recovery shake"]);
    expect(getOfferedIntakeForSlot(p, "19:00").map((o) => o.name)).toEqual([
      "Recovery shake",
    ]);
  });
});

describe("the stored snapshot answer survives to read time (#5321)", () => {
  // THE AXIS THE PAYLOAD LIVES ON, and the one a same-instant assertion cannot see.
  //
  // A session logged 07:00-07:45 and a snapshot built at 07:20. The person is offline for
  // the rest of the day: refresh rides authenticated traffic, so the build minute is by
  // construction their LAST ONLINE MOMENT, and `isSnapshotStale` is day-granular for a
  // profile-day payload, so /offline renders it all day with no qualifier. A frozen
  // `postWorkoutReady: false` would therefore withhold the dose for sixteen hours while
  // the page they cannot reach says it is due — #5321's own harm, pointed the other way.
  const buildAt = (profileId: number, day: string, hhmm: string): string[] => {
    vi.setSystemTime(new Date(`${day}T${hhmm}:00.000Z`));
    return offlineDoseNames(profileId);
  };

  it("matches the page when the snapshot is READ, not only when it is built", () => {
    const p = newProfile();
    const td = today(p);
    seedItem(p, "Recovery tablet", "post_workout");
    logWorkout(p, td, "07:00", "07:45");

    const stored = buildAt(p, td, "07:20");

    // Read that same payload thirteen hours later. Nothing was rebuilt in between.
    vi.setSystemTime(new Date(`${td}T20:00:00.000Z`));
    expect(pageDueNames(p)).toEqual(["Recovery tablet"]);
    expect(stored).toEqual(["Recovery tablet"]);
  });

  it("does not depend on the minute it happened to be built at", () => {
    const p = newProfile();
    const td = today(p);
    seedItem(p, "Recovery tablet", "post_workout");
    logWorkout(p, td, "07:00", "07:45");

    // Before the session ends, during it, and long after: one day, one stored answer.
    expect(buildAt(p, td, "06:30")).toEqual(["Recovery tablet"]);
    expect(buildAt(p, td, "07:20")).toEqual(["Recovery tablet"]);
    expect(buildAt(p, td, "20:00")).toEqual(["Recovery tablet"]);
  });

  it("still omits what the day itself does not owe", () => {
    // The control that keeps the two above from passing for any reason at all: the
    // day-shaped question is not "offer everything". A rest-day item on a predicted
    // training day is absent at every build minute.
    const p = newProfile();
    const td = today(p);
    for (let w = 1; w <= 8; w++) logWorkout(p, shiftDateStr(td, -w * 7));
    seedItem(p, "Rest-day tablet", "rest_day");

    expect(buildAt(p, td, "07:20")).toEqual([]);
    expect(buildAt(p, td, "20:00")).toEqual([]);
    expect(pageDueNames(p)).toEqual([]);
  });
});
