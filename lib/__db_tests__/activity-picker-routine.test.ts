// DB INTEGRATION TIER — #1115 Fix C: the activity-form exercise picker floats TODAY'S
// resolved routine slots (+ their candidates) to the front of the frequency-ranked lift
// list, so opening the logger on a routine day surfaces the prescribed lifts first. Off
// a routine, the order is byte-for-byte the frequency ranking. The pure reorder is pinned
// in lib/__tests__/rank-by-frequency.test.ts; this proves the DB gather resolves today's
// day and reorders through it.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { createCustomRoutine, activateRoutine } from "@/lib/routines";
import { getActivitySuggestions } from "@/lib/queries";
import { shiftDateStr } from "@/lib/date";
import { RECENT_WINDOW_DAYS } from "@/lib/exercise-window";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function logLift(profileId: number, date: string, exercise: string): void {
  const id = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, source)
         VALUES (?, ?, 'strength', 'Session', 'manual')`
      )
      .run(profileId, date).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, warmup)
     VALUES (?, ?, 1, 60, 5, 0)`
  ).run(id, exercise);
}

function logSport(profileId: number, date: string, name: string): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min, components, source)
     VALUES (?, ?, 'sport', 'Match', 45, ?, 'manual')`
  ).run(
    profileId,
    date,
    JSON.stringify([{ name, type: "sport", duration_min: 45 }])
  );
}

describe("activity picker — routine-aware order (#1115 Fix C)", () => {
  it("floats today's prescribed slots to the front, keeps the rest in place", () => {
    const p = newProfile("Picker Routine");
    // Off a routine first: capture the baseline frequency order.
    const baseline = getActivitySuggestions(p).lifts;
    expect(baseline.length).toBeGreaterThan(3);
    // "Deadlift" is not normally the first catalog option — a fresh profile ranks by
    // catalog order — so a routine that prescribes it must move it to the front.
    expect(baseline[0]).not.toBe("Deadlift");

    const rid = createCustomRoutine(p, {
      name: "Pull day",
      days: [
        {
          label: "Pull",
          focus: ["Back"],
          slots: [
            { candidates: ["Deadlift"], sets: 3, repMin: 5, repMax: 8 },
            { candidates: ["Barbell Row"], sets: 3, repMin: 8, repMax: 12 },
          ],
        },
      ],
    });
    activateRoutine(p, rid);

    const lifts = getActivitySuggestions(p).lifts;
    // The prescribed slots lead, in slot order — base-collapsed ("Barbell Row" → "Row").
    expect(lifts.slice(0, 2)).toEqual(["Deadlift", "Row"]);
    // Nothing was dropped and the tail keeps its frequency order (baseline minus the
    // two floated names, same relative order).
    const tail = baseline.filter((n) => n !== "Deadlift" && n !== "Row");
    expect(lifts.slice(2)).toEqual(tail);
  });

  it("off a routine, the order is unchanged", () => {
    const p = newProfile("Picker No Routine");
    const a = getActivitySuggestions(p).lifts;
    // No active routine ⇒ pure frequency ranking; a re-read is identical.
    expect(getActivitySuggestions(p).lifts).toEqual(a);
    expect(a).not.toHaveLength(0);
  });
});

// #2384. The picker's four rankers survive only as an exact-score tiebreak once a
// key is pressed, so the matcher needs the usage question answered as data. This is
// the gather half: `logged` is the profile's own recent-window usage, lowercased,
// and nothing else.
describe("activity picker — the usage signal the matcher carries (#2384)", () => {
  it("names the profile's recently logged lifts and sports, and nothing it has not logged", () => {
    const p = newProfile("Picker Usage");
    const t = today(p);
    logLift(p, t, "Back Squat");
    logSport(p, shiftDateStr(t, -30), "Tennis");

    const { logged, lifts, sports } = getActivitySuggestions(p);
    expect(logged).toContain("back squat");
    expect(logged).toContain("tennis");
    // A catalog option the profile has never logged is OFFERED but not "used" —
    // the picker de-ranks it, it does not hide it (#345).
    expect(lifts).toContain("Front Squat");
    expect(sports).toContain("Squash");
    expect(logged).not.toContain("front squat");
    expect(logged).not.toContain("squash");
  });

  it("collapses an equipment variant onto the base name the picker offers", () => {
    // The picker offers grouped base names, so the usage key has to be the base or
    // the bonus would never land on the row it belongs to.
    const p = newProfile("Picker Usage Variant");
    logLift(p, today(p), "Dumbbell Curl");
    expect(getActivitySuggestions(p).logged).toContain("curl");
  });

  it("forgets usage that has fallen out of the recent window", () => {
    const p = newProfile("Picker Usage Window");
    const t = today(p);
    logLift(p, shiftDateStr(t, -(RECENT_WINDOW_DAYS + 30)), "Deadlift");
    logLift(p, t, "Bench Press");
    const { logged } = getActivitySuggestions(p);
    expect(logged).toContain("bench press");
    expect(logged).not.toContain("deadlift");
  });

  it("is profile-scoped — a neighbour's squats do not leak in", () => {
    const mine = newProfile("Picker Usage Mine");
    const theirs = newProfile("Picker Usage Theirs");
    logLift(theirs, today(theirs), "Back Squat");
    logSport(theirs, today(theirs), "Squash");
    expect(getActivitySuggestions(mine).logged).toEqual([]);
    expect(getActivitySuggestions(theirs).logged).toEqual(
      expect.arrayContaining(["back squat", "squash"])
    );
  });
});
