// SERVER-ACTION TIER — routine position advance on session crediting (#740).
//
// Logging a session that CREDITS today's routine day advances `routines.position`
// by one — at most ONCE per profile-local day and ONLY on a credited session. A
// skipped/rest day (nothing logged), a repeat session the same day, and a cardio
// activity on a strength day must all NOT advance it. Driven through the real
// saveActivity write path against the seeded active routine.

import { describe, it, expect } from "vitest";
import { saveActivity } from "@/app/(app)/journal/actions";
import {
  adoptTemplate,
  activateRoutine,
  getActiveRoutine,
} from "@/lib/routines";
import { createLogin, createProfile, actAs, fd } from "./harness";

function position(profileId: number): number {
  return getActiveRoutine(profileId)!.position;
}

// A strength saveActivity FormData for a single lift on a given date.
function strengthFd(exercise: string, date: string): FormData {
  return fd({
    type: "strength",
    title: exercise,
    date,
    components: JSON.stringify([
      { name: exercise, type: "strength", distance: null, duration_min: null },
    ]),
    sets: JSON.stringify([
      {
        exercise,
        weight: 60,
        reps: 5,
        weightRight: null,
        repsRight: null,
        durationSec: null,
        durationSecRight: null,
        equipmentId: null,
      },
    ]),
  });
}

function cardioFd(date: string): FormData {
  return fd({
    type: "cardio",
    title: "Run",
    date,
    components: JSON.stringify([
      { name: "Run", type: "cardio", distance: 5, duration_min: 30 },
    ]),
  });
}

function setupActiveRoutine() {
  const login = createLogin({ weightUnit: "kg" });
  const profile = createProfile("routine-lifter", login.id);
  actAs(login, profile);
  const routineId = adoptTemplate(profile.id, "push-pull-legs-6x");
  activateRoutine(profile.id, routineId); // position reset to 0 (day 0 = Push)
  return profile;
}

describe("routine position advance (#740)", () => {
  it("advances once when a credited strength session is logged", async () => {
    const profile = setupActiveRoutine();
    expect(position(profile.id)).toBe(0); // Push day

    // Bench Press = Chest, overlaps Push focus → credits → advance to Pull.
    const res = await strengthFd("Bench Press", "2026-07-08");
    await saveActivity(res);
    expect(position(profile.id)).toBe(1);
  });

  it("does NOT advance a second time the same profile-local day", async () => {
    const profile = setupActiveRoutine();
    await saveActivity(strengthFd("Bench Press", "2026-07-08"));
    expect(position(profile.id)).toBe(1);
    // A second credited session the same day is a no-op for the cursor.
    await saveActivity(strengthFd("Bench Press", "2026-07-08"));
    expect(position(profile.id)).toBe(1);
  });

  it("advances again on a NEW day with a credited session", async () => {
    const profile = setupActiveRoutine();
    await saveActivity(strengthFd("Bench Press", "2026-07-08")); // Push → 1 (Pull)
    // Deadlift = Back, overlaps Pull focus → credits → advance to Legs.
    await saveActivity(strengthFd("Deadlift", "2026-07-09"));
    expect(position(profile.id)).toBe(2);
  });

  it("does NOT advance a strength day by a cardio activity", async () => {
    const profile = setupActiveRoutine();
    await saveActivity(strengthFd("Bench Press", "2026-07-08")); // Push → 1 (Pull)
    // A cardio activity on a strength (Pull) day never credits it.
    await saveActivity(cardioFd("2026-07-09"));
    expect(position(profile.id)).toBe(1);
  });

  it("does NOT advance on an off-focus session (missed day stays next up)", async () => {
    const profile = setupActiveRoutine();
    // On Push day (Chest/Shoulders/Arms), a Legs session doesn't credit it.
    await saveActivity(strengthFd("Back Squat", "2026-07-08"));
    expect(position(profile.id)).toBe(0); // still Push
  });
});
