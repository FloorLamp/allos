// Pure tests for deloadAdjust (#741) — the ONE deload-week prescription adjustment
// (−10% load, −1 working set) shared by every surface. Boundary-pinned so the
// named factors can't silently drift.
import { describe, it, expect } from "vitest";
import {
  deloadAdjust,
  contextualNextSet,
  suggestNextSet,
  DELOAD_LOAD_FACTOR,
  DELOAD_SET_REDUCTION,
  DELOAD_MIN_SETS,
  type NextSet,
} from "@/lib/coaching";

function ns(overrides: Partial<NextSet> = {}): NextSet {
  return {
    weightKg: 100,
    reps: 5,
    bodyweight: false,
    targetReps: null,
    rationale: "base",
    ...overrides,
  };
}

describe("deloadAdjust — named factors", () => {
  it("uses the documented constants", () => {
    expect(DELOAD_LOAD_FACTOR).toBe(0.9);
    expect(DELOAD_SET_REDUCTION).toBe(1);
    expect(DELOAD_MIN_SETS).toBe(1);
  });
});

describe("deloadAdjust — set reduction", () => {
  it("drops one working set", () => {
    expect(
      deloadAdjust({ exercise: "Bench Press", sets: 4, nextSet: null }).sets
    ).toBe(3);
  });

  it("never drops below one working set", () => {
    expect(
      deloadAdjust({ exercise: "Bench Press", sets: 1, nextSet: null }).sets
    ).toBe(DELOAD_MIN_SETS);
  });
});

describe("deloadAdjust — load reduction, plate-loadable", () => {
  it("cuts a compound's load ~10%, rounded to its 5 kg increment", () => {
    // Squat increment is 5 kg; 100 * 0.9 = 90 → nearest 5 kg = 90.
    const out = deloadAdjust({
      exercise: "Back Squat",
      sets: 4,
      nextSet: ns({ weightKg: 100 }),
    });
    expect(out.nextSet!.weightKg).toBe(90);
    expect(out.nextSet!.reps).toBe(5); // reps unchanged
  });

  it("cuts an isolation lift's load ~10%, rounded to its 2.5 kg increment", () => {
    // Curl increment is 2.5 kg; 30 * 0.9 = 27 → nearest 2.5 = 27.5.
    const out = deloadAdjust({
      exercise: "Barbell Curl",
      sets: 3,
      nextSet: ns({ weightKg: 30 }),
    });
    expect(out.nextSet!.weightKg).toBe(27.5);
  });

  it("never rounds the load below one increment", () => {
    const out = deloadAdjust({
      exercise: "Barbell Curl",
      sets: 3,
      nextSet: ns({ weightKg: 2.5 }),
    });
    // 2.5 * 0.9 = 2.25 → would round to 2.5 (one increment), floored there.
    expect(out.nextSet!.weightKg).toBe(2.5);
  });

  it("re-phrases the rationale to name the deload", () => {
    const out = deloadAdjust({
      exercise: "Back Squat",
      sets: 4,
      nextSet: ns(),
    });
    expect(out.nextSet!.rationale).toMatch(/deload/i);
  });
});

describe("deloadAdjust — bodyweight / loadless / cold start", () => {
  it("leaves a bodyweight next-set's reps and load alone", () => {
    const bw = ns({ weightKg: 0, bodyweight: true, reps: 12 });
    const out = deloadAdjust({ exercise: "Pull Up", sets: 4, nextSet: bw });
    expect(out.nextSet).toEqual(bw); // reps preserved, no load to shave
    expect(out.sets).toBe(3); // still one fewer set
  });

  it("passes a null next-set (cold start) straight through", () => {
    const out = deloadAdjust({
      exercise: "Back Squat",
      sets: 3,
      nextSet: null,
    });
    expect(out.nextSet).toBeNull();
    expect(out.sets).toBe(2);
  });
});

// #923 / #1115 Fix B — the activity form's deload-aware next-set suggestion routes
// through the SAME modifier composition (contextualNextSet → deloadAdjust) the
// Training-overview session card uses, so the two surfaces can never disagree about the
// deload load. The form has no slot set-count, so it consumes ONLY the load half
// (contextualNextSet's deload passes sets: 0); this pins that its result equals the
// card's `nextSet` for the same seed regardless of the card's set count.
describe("contextualNextSet deload — no drift vs the session card (#923)", () => {
  // Build a concrete progression from a realistic seed, the way both surfaces do.
  const seed = {
    exercise: "Bench Press",
    bodyweight: false,
    lastSessionBest: {
      weightKg: 100,
      reps: 6,
      targetReps: null,
      toFailure: false,
    },
    lastSessionSets: [
      { weightKg: 100, reps: 6, targetReps: null, toFailure: false },
      { weightKg: 100, reps: 6, targetReps: null, toFailure: false },
      { weightKg: 100, reps: 6, targetReps: null, toFailure: false },
    ],
  };

  it("form suggestion equals the card's deload-adjusted load for the same seed", () => {
    const base = suggestNextSet(seed, "kg");
    // The card's value: deloadAdjust with the slot's real set count.
    for (const cardSets of [1, 2, 3, 4, 5]) {
      const card = deloadAdjust({
        exercise: seed.exercise,
        sets: cardSets,
        nextSet: base,
      }).nextSet;
      const form = contextualNextSet(base, seed.exercise, { deloadWeek: true });
      expect(form).toEqual(card);
    }
  });

  it("shaves the load ~10% and carries the shared rationale", () => {
    const base = suggestNextSet(seed, "kg"); // holds 100 kg, builds a rep
    const form = contextualNextSet(base, seed.exercise, { deloadWeek: true })!;
    expect(base!.weightKg).toBe(100);
    expect(form.weightKg).toBe(90); // 100 * 0.9, plate-rounded to 2.5 kg
    expect(form.rationale).toBe("Deload week — ~10% lighter to recover");
    expect(form.reps).toBe(base!.reps); // only the load half changes
  });

  it("off a deload week (or non-routine lift) returns the plain progression", () => {
    const base = suggestNextSet(seed, "kg");
    expect(contextualNextSet(base, seed.exercise, { deloadWeek: false })).toBe(
      base
    );
  });

  it("passes a null suggestion through", () => {
    expect(
      contextualNextSet(null, "Bench Press", { deloadWeek: true })
    ).toBeNull();
  });
});
