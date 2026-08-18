// DB INTEGRATION TIER — issue #1154 Fix A + the one-per-hour merge, over a real
// schema:
//   • an `anytime` + `pre_workout` dose rides the PreWorkout pseudo-slot (timed
//     one hour before the inferred training hour), leaves the Morning gather
//     (no double-listing), and falls back to Morning when no cadence exists;
//   • an EXPLICIT bucket on a pre_workout dose is honored;
//   • two slots due together coalesce into ONE message whose contributing slots
//     are all reported (so the tick marks each's per-day marker).
// All fixture values synthetic — no real PHI.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  buildIntakeReminderForSlots,
  collectWindowDoses,
  getPreWorkoutSlotMinute,
} from "@/lib/notifications/intake";
import { inferWorkoutSchedule } from "@/lib/queries";

function createProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A habitual training cadence: sessions on TODAY's weekday for the last 4 weeks
// at 18:30 — enough distinct dates (≥ ceil(8×0.4)=4) for inferWorkoutSchedule to
// detect the pattern, with 18 the dominant start hour, and today a predicted
// training day (so a pre_workout dose is DUE).
function seedCadence(profileId: number): void {
  const td = today(profileId);
  for (const back of [7, 14, 21, 28]) {
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, start_time, end_time)
       VALUES (?, ?, 'strength', 'Evening lift (test)', '18:30', '19:30')`
    ).run(profileId, shiftDateStr(td, -back));
  }
}

function seedPreWorkoutSupp(
  profileId: number,
  name: string,
  timeOfDay: string | null
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation)
         VALUES (?, ?, 1, 'supplement', 'pre_workout', 'should')`
      )
      .run(profileId, name).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '5 g', ?, 'any', 0)`
      )
      .run(itemId, timeOfDay).lastInsertRowid
  );
  return { itemId, doseId };
}

function seedDaily(profileId: number, name: string, timeOfDay: string): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation)
         VALUES (?, ?, 1, 'supplement', 'daily', 'should')`
      )
      .run(profileId, name).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 cap', ?, 'any', 0)`
  ).run(itemId, timeOfDay);
  return itemId;
}

describe("#1154 Fix A — the PreWorkout pseudo-slot", () => {
  it("an anytime pre_workout dose rides the pseudo-slot (17:00 for an 18:00 trainer), NOT Morning", () => {
    const p = createProfile("PreSlot Cadence (test)");
    seedCadence(p);
    seedPreWorkoutSupp(p, "Creatine (test)", "anytime");

    const inf = inferWorkoutSchedule(p);
    expect(inf.hasPattern).toBe(true);
    expect(inf.hour).toBe(18);
    expect(getPreWorkoutSlotMinute(p)).toBe(17 * 60);

    const td = today(p);
    const pre = collectWindowDoses(p, "PreWorkout", td);
    expect(pre.map((e) => e.item.name)).toContain("Creatine (test)");
    // No double-listing: it left the Morning fold.
    const morning = collectWindowDoses(p, "Morning", td);
    expect(morning.map((e) => e.item.name)).not.toContain("Creatine (test)");
  });

  it("an EXPLICIT Morning bucket is honored even with an inferred cadence", () => {
    const p = createProfile("PreSlot Explicit (test)");
    seedCadence(p);
    seedPreWorkoutSupp(p, "Beta-Alanine (test)", "morning");

    const td = today(p);
    expect(
      collectWindowDoses(p, "Morning", td).map((e) => e.item.name)
    ).toContain("Beta-Alanine (test)");
    expect(
      collectWindowDoses(p, "PreWorkout", td).map((e) => e.item.name)
    ).not.toContain("Beta-Alanine (test)");
    // No anytime pre_workout dose → the pseudo-slot has no time.
    expect(getPreWorkoutSlotMinute(p)).toBeNull();
  });

  it("no inferable cadence → the #558 fallback: the dose stays in Morning, no pseudo-slot", () => {
    const p = createProfile("PreSlot NoCadence (test)");
    seedPreWorkoutSupp(p, "Creatine (test)", "anytime");
    // A single logged workout today makes the dose DUE without creating a cadence.
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title)
       VALUES (?, ?, 'strength', 'One-off (test)')`
    ).run(p, today(p));

    expect(getPreWorkoutSlotMinute(p)).toBeNull();
    expect(
      collectWindowDoses(p, "Morning", today(p)).map((e) => e.item.name)
    ).toContain("Creatine (test)");
  });
});

describe("#1154 — same-hour sends coalesce into ONE message", () => {
  it("two window slots merge; both are reported as contributing (so both markers get set)", () => {
    const p = createProfile("Merge Windows (test)");
    seedDaily(p, "Vitamin D (test)", "morning");
    seedDaily(p, "Magnesium (test)", "midday");

    const built = buildIntakeReminderForSlots(p, ["Morning", "Midday"]);
    expect(built).not.toBeNull();
    expect(built!.slots.sort()).toEqual(["Midday", "Morning"]);
    expect(built!.message.title).toBe("💊 Morning & Midday supplements");
    expect(built!.message.body).toContain("Vitamin D (test)");
    expect(built!.message.body).toContain("Magnesium (test)");
  });

  it("the PreWorkout pseudo-slot merges with a window into one send", () => {
    const p = createProfile("Merge PreWindow (test)");
    seedCadence(p);
    seedPreWorkoutSupp(p, "Creatine (test)", "anytime");
    seedDaily(p, "Fish Oil (test)", "evening");

    const built = buildIntakeReminderForSlots(p, ["Evening", "PreWorkout"]);
    expect(built).not.toBeNull();
    expect(built!.slots.sort()).toEqual(["Evening", "PreWorkout"]);
    expect(built!.message.title).toBe("💊 Evening & Pre-workout supplements");
    expect(built!.message.body).toContain("Creatine (test)");
    expect(built!.message.body).toContain("Fish Oil (test)");
  });

  it("a due slot with nothing to say is NOT reported (its marker stays unset for the retry)", () => {
    const p = createProfile("Merge Empty (test)");
    seedDaily(p, "Vitamin D (test)", "morning");
    const built = buildIntakeReminderForSlots(p, ["Morning", "Bedtime"]);
    expect(built).not.toBeNull();
    expect(built!.slots).toEqual(["Morning"]);
  });
});

// ---- The ride-along tail on a DOSE REMINDER keyboard (#1505 / #2890) ----
//
// SAFETY TIER. The dose reminder is the message that says what is still due, and its
// keyboard already carries "✅ All (N)" over exactly that set. #2890 renamed the digest's
// offer tail to a bare "➕ Doses (N)" — and on this message that put TWO dose counts side
// by side that mean different things and cannot be added up: "2 still due here" beside
// "3 you may log any time". The reminder therefore keeps the word "other", whose
// referent — unlike on the digest — is the message it is attached to.
describe("the reminder's ride-along names what it is other THAN (#2890)", () => {
  // A `may` item with no slot hint is offered in every slot, so this is deterministic
  // whatever hour the suite runs at.
  function seedMayItem(profileId: number, name: string): void {
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation)
           VALUES (?, ?, 1, 'supplement', 'daily', 'may')`
        )
        .run(profileId, name).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '1 cap', NULL, 'any', 0)`
    ).run(itemId);
  }

  it("does not put a second bare dose count beside ✅ All", () => {
    const p = createProfile("RideAlong Rhea (test)");
    // Two due doses in one slot, which is what mints "✅ All (2)"…
    seedDaily(p, "Levothyroxine (test)", "morning");
    seedDaily(p, "Vitamin D (test)", "morning");
    // …and three `may` items the tail offers.
    for (const n of ["Magnesium", "Zinc", "Iron"]) {
      seedMayItem(p, `${n} (test)`);
    }

    const labels = (
      buildIntakeReminderForSlots(p, ["Morning"])?.message.actions ?? []
    ).map((a) => a.label);

    expect(labels).toContain("✅ All (2)");
    expect(labels).toContain("➕ Log other (3)");
    // The regression this pins: "➕ Doses (3)" beside "✅ All (2)".
    expect(labels).not.toContain("➕ Doses (3)");
    // Exactly one label carries a count that is ABOUT what is due here.
    expect(labels.filter((l) => l.startsWith("✅ All"))).toHaveLength(1);
  });
});
