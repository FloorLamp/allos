// SERVER-ACTION TIER — saveActivity's weight round-trip no-op (issue #194).
//
// An edit re-saves an activity: the form pre-fills each set's weight as
// round(kgTo(stored, unit), 1) and the action re-stores it. For an lb-preference
// user, an UNTOUCHED set must NOT drift its canonical kg by the display-rounding
// quantum on every save — saveActivity snapshots the pre-edit set loads (keyed by
// exercise + set number) and keeps a materially-unchanged one exactly.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { saveActivity } from "@/app/(app)/journal/actions";
import { LB_PER_KG } from "@/lib/units";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => revalidate.mockClear());

function seedStrengthActivity(profileId: number, weightKg: number): number {
  const id = Number(
    db
      .prepare(
        "INSERT INTO activities (date, type, title, profile_id) VALUES ('2026-07-01', 'strength', 'Lift', ?)"
      )
      .run(profileId).lastInsertRowid
  );
  db.prepare(
    "INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps) VALUES (?, 'Bench Press', 1, ?, 5)"
  ).run(id, weightKg);
  return id;
}

function setWeight(activityId: number): number {
  return (
    db
      .prepare(
        "SELECT weight_kg FROM exercise_sets WHERE activity_id = ? AND set_number = 1"
      )
      .get(activityId) as { weight_kg: number }
  ).weight_kg;
}

describe("saveActivity weight round-trip (issue #194)", () => {
  it("does not drift a set's stored kg when an lb user re-saves it unchanged", async () => {
    const login = createLogin({ weightUnit: "lb" });
    const profile = createProfile("lifter", login.id);
    actAs(login, profile);

    const storedKg = 100; // a clean canonical kg (as if entered in kg)
    const id = seedStrengthActivity(profile.id, storedKg);

    // What the edit form pre-fills for an lb user, then re-submits untouched.
    const displayLb = Math.round(storedKg * LB_PER_KG * 10) / 10;
    await saveActivity(
      fd({
        id,
        type: "strength",
        title: "Lift",
        date: "2026-07-01",
        components: JSON.stringify([
          {
            name: "Bench Press",
            type: "strength",
            distance: null,
            duration_min: null,
          },
        ]),
        sets: JSON.stringify([
          {
            exercise: "Bench Press",
            weight: displayLb,
            reps: 5,
            weightRight: null,
            repsRight: null,
            durationSec: null,
            durationSecRight: null,
            equipmentId: null,
          },
        ]),
      })
    );

    expect(setWeight(id)).toBe(storedKg);
  });

  it("still stores a genuinely changed set weight (converted through kg)", async () => {
    const login = createLogin({ weightUnit: "lb" });
    const profile = createProfile("lifter2", login.id);
    actAs(login, profile);

    const id = seedStrengthActivity(profile.id, 100);
    await saveActivity(
      fd({
        id,
        type: "strength",
        title: "Lift",
        date: "2026-07-01",
        components: JSON.stringify([
          {
            name: "Bench Press",
            type: "strength",
            distance: null,
            duration_min: null,
          },
        ]),
        sets: JSON.stringify([
          {
            exercise: "Bench Press",
            weight: 225, // user bumped it to 225 lb
            reps: 5,
            weightRight: null,
            repsRight: null,
            durationSec: null,
            durationSecRight: null,
            equipmentId: null,
          },
        ]),
      })
    );

    expect(setWeight(id)).toBeCloseTo(225 / LB_PER_KG, 6);
  });
});
