import { describe, it, expect } from "vitest";
import {
  FAMILIAR_AFTER_SESSIONS,
  exerciseSessionCount,
  isNewLift,
} from "@/lib/exercise-familiarity";
import { getExerciseGuide } from "@/lib/exercise-guides";
import type { DatedExercise } from "@/lib/workout-recommendation";

function dEx(exercise: string, date: string): DatedExercise {
  return { exercise, date };
}

describe("exerciseSessionCount (#2223)", () => {
  it("counts distinct DATES, not rows — three sets on one day is one session", () => {
    const rows = [
      dEx("Barbell Bench Press", "2026-07-01"),
      dEx("Barbell Bench Press", "2026-07-01"),
      dEx("Barbell Bench Press", "2026-07-01"),
    ];
    expect(exerciseSessionCount(rows, "Barbell Bench Press")).toBe(1);
  });

  it("counts one session per day across several days", () => {
    const rows = [
      dEx("Barbell Bench Press", "2026-07-01"),
      dEx("Barbell Bench Press", "2026-07-01"),
      dEx("Barbell Bench Press", "2026-06-24"),
    ];
    expect(exerciseSessionCount(rows, "Barbell Bench Press")).toBe(2);
  });

  it("resolves identity through exerciseHistoryKey, so a logged 'Dumbbell Curl' counts toward a recommended 'Barbell Curl'", () => {
    const rows = [dEx("Dumbbell Curl", "2026-07-01")];
    expect(exerciseSessionCount(rows, "Barbell Curl")).toBe(1);
    expect(exerciseSessionCount(rows, "Curl")).toBe(1);
    // ...and that is exactly why: both names reach the ONE guide the button would
    // deep-link to, so the two halves of the decision agree on what the lift is.
    expect(getExerciseGuide("Dumbbell Curl")).toBe(getExerciseGuide("Curl"));
    expect(getExerciseGuide("Barbell Curl")).toBe(getExerciseGuide("Curl"));
  });

  it("merges variant spellings on the same day into one session", () => {
    const rows = [
      dEx("Barbell Curl", "2026-07-01"),
      dEx("Dumbbell Curl", "2026-07-01"),
    ];
    expect(exerciseSessionCount(rows, "Curl")).toBe(1);
  });

  it("is case- and whitespace-insensitive, like every other history key", () => {
    expect(
      exerciseSessionCount([dEx("  deadlift ", "2026-07-01")], "Deadlift")
    ).toBe(1);
  });

  it("counts 0 for a lift absent from the rows", () => {
    const rows = [dEx("Barbell Bench Press", "2026-07-01")];
    expect(exerciseSessionCount(rows, "Barbell Squat")).toBe(0);
    expect(exerciseSessionCount([], "Barbell Bench Press")).toBe(0);
  });

  it("keeps distinct custom lifts distinct", () => {
    const rows = [dEx("My Weird Machine Thing", "2026-07-01")];
    expect(exerciseSessionCount(rows, "My Weird Machine Thing")).toBe(1);
    expect(exerciseSessionCount(rows, "Some Other Machine")).toBe(0);
  });
});

describe("isNewLift (#2223)", () => {
  it("is true at 0 sessions — the lift is still owed an introduction", () => {
    expect(isNewLift(0)).toBe(true);
  });

  it("is false at 1 session — one logged session is enough", () => {
    expect(isNewLift(1)).toBe(false);
    expect(isNewLift(12)).toBe(false);
    expect(FAMILIAR_AFTER_SESSIONS).toBe(1);
  });

  it("is FALSE for undefined — absent means unknown, and unknown never earns a contact", () => {
    expect(isNewLift(undefined)).toBe(false);
  });
});
