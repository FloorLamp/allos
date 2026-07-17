// Pure-tier tests for the routine-aware recommendation path (#740): today's-day
// resolution + slot filling at boundaries, sessionCreditsDay's overlap / kind /
// once-per-day rules, cold-start (no load target), and the byte-for-byte guarantee
// that NO active routine leaves recommendNextWorkout unchanged.

import { describe, expect, it } from "vitest";
import {
  recommendNextWorkout,
  resolveRoutineSession,
  resolveTodayRoutineDayIndex,
  sessionCreditsDay,
  type ActiveRoutineInput,
  type NextWorkoutInput,
} from "@/lib/workout-recommendation";
import type { StrengthRecent } from "@/lib/coaching";
import type { EquipmentAvailability } from "@/lib/equipment-availability";
import { buildRoutineSessionPrefill } from "@/lib/activity-form-model";
import { formatWorkoutReminder } from "@/lib/notifications/workout-format";

const TODAY = "2026-07-08";

function input(over: Partial<NextWorkoutInput> = {}): NextWorkoutInput {
  return { today: TODAY, routine: [], strength: [], cardio: [], ...over };
}

function sRec(over: Partial<StrengthRecent> = {}): StrengthRecent {
  return {
    exercise: "Bench Press",
    bodyweight: false,
    lastSessionBest: {
      weightKg: 60,
      reps: 5,
      targetReps: null,
      toFailure: false,
    },
    lastDate: "2026-07-01",
    ...over,
  } as StrengthRecent;
}

// A 3-day Push/Pull/Legs routine, one slot per day for simple assertions.
function ppl(position: number): ActiveRoutineInput {
  return {
    id: 7,
    position,
    days: [
      {
        id: 1,
        label: "Push",
        focus: ["Chest", "Shoulders", "Arms"],
        slots: [
          {
            candidates: ["Barbell Bench Press", "Dumbbell Bench Press"],
            sets: 4,
            rep_min: 5,
            rep_max: 8,
          },
        ],
      },
      {
        id: 2,
        label: "Pull",
        focus: ["Back", "Shoulders", "Arms"],
        slots: [{ candidates: ["Deadlift"], sets: 3, rep_min: 5, rep_max: 8 }],
      },
      {
        id: 3,
        label: "Legs",
        focus: ["Legs", "Glutes"],
        slots: [
          { candidates: ["Back Squat"], sets: 4, rep_min: 5, rep_max: 8 },
        ],
      },
    ],
  };
}

describe("resolveTodayRoutineDayIndex — the ONE cursor→today's-day computation (#831)", () => {
  it("reads the cursor modulo the day count", () => {
    expect(resolveTodayRoutineDayIndex({ position: 0, days: [1, 2, 3] })).toBe(
      0
    );
    expect(resolveTodayRoutineDayIndex({ position: 1, days: [1, 2, 3] })).toBe(
      1
    );
    expect(resolveTodayRoutineDayIndex({ position: 2, days: [1, 2, 3] })).toBe(
      2
    );
  });

  it("normalizes an overflowed or negative cursor into [0, n)", () => {
    expect(resolveTodayRoutineDayIndex({ position: 3, days: [1, 2, 3] })).toBe(
      0
    );
    expect(resolveTodayRoutineDayIndex({ position: 7, days: [1, 2, 3] })).toBe(
      1
    );
    expect(resolveTodayRoutineDayIndex({ position: -1, days: [1, 2, 3] })).toBe(
      2
    );
    expect(resolveTodayRoutineDayIndex({ position: -4, days: [1, 2, 3] })).toBe(
      2
    );
  });

  it("returns null for a routine with no days", () => {
    expect(resolveTodayRoutineDayIndex({ position: 5, days: [] })).toBeNull();
  });

  // Cross-path pin (#831): the recommendation core (resolveRoutineSession) and the
  // crediting write path (creditRoutineSession, lib/routines.ts) are both formatters
  // over this ONE index function, so they can never disagree about "today's day".
  // Here we pin the recommendation path: whatever day resolveRoutineSession shows is
  // exactly days[resolveTodayRoutineDayIndex(routine)] — the same slice the write
  // path advances the cursor past.
  it("resolveRoutineSession selects days[resolveTodayRoutineDayIndex]", () => {
    for (const position of [0, 1, 2, 3, 4, 7, -1, -3]) {
      const routine = ppl(position);
      const idx = resolveTodayRoutineDayIndex(routine)!;
      const shown = resolveRoutineSession(routine, input())!;
      expect(shown.dayId).toBe(routine.days[idx].id);
      expect(shown.label).toBe(routine.days[idx].label);
    }
  });
});

describe("resolveRoutineSession — today's-day resolution + slot filling", () => {
  it("resolves the day at the rotation cursor", () => {
    expect(resolveRoutineSession(ppl(0), input())!.label).toBe("Push");
    expect(resolveRoutineSession(ppl(1), input())!.label).toBe("Pull");
    expect(resolveRoutineSession(ppl(2), input())!.label).toBe("Legs");
  });

  it("wraps the cursor modulo the day count (a sequence, not a calendar)", () => {
    expect(resolveRoutineSession(ppl(3), input())!.label).toBe("Push");
    expect(resolveRoutineSession(ppl(7), input())!.label).toBe("Pull");
  });

  it("fills each slot with the first candidate by default", () => {
    const s = resolveRoutineSession(ppl(0), input())!;
    expect(s.slots[0].exercise).toBe("Barbell Bench Press");
    expect(s.slots[0].sets).toBe(4);
    expect(s.slots[0].repMin).toBe(5);
    expect(s.slots[0].repMax).toBe(8);
  });

  it("falls down the candidate list when the first needs unavailable gear", () => {
    const dumbbellOnly: EquipmentAvailability = {
      hasAny: true,
      categories: ["Dumbbell"],
    };
    const s = resolveRoutineSession(
      ppl(0),
      input({ availableEquipment: dumbbellOnly })
    )!;
    // Barbell Bench Press de-ranked → the dumbbell candidate fills the slot.
    expect(s.slots[0].exercise).toBe("Dumbbell Bench Press");
  });

  it("attaches the next-set seed when the lift has history", () => {
    const seed = sRec({ exercise: "Barbell Bench Press" });
    const s = resolveRoutineSession(ppl(0), input({ strength: [seed] }))!;
    expect(s.slots[0].seed).toBe(seed);
  });

  it("cold start: no history ⇒ slot has no seed (no load target)", () => {
    const s = resolveRoutineSession(ppl(0), input())!;
    expect(s.slots[0].seed).toBeNull();
  });

  it("returns null for a routine with no days", () => {
    expect(
      resolveRoutineSession({ id: 1, position: 0, days: [] }, input())
    ).toBeNull();
  });

  it("classifies an empty-focus day as a cardio day", () => {
    const routine: ActiveRoutineInput = {
      id: 9,
      position: 0,
      days: [
        {
          id: 1,
          label: "Conditioning",
          focus: [],
          slots: [{ candidates: ["Run"], sets: 1, rep_min: 1, rep_max: 1 }],
        },
      ],
    };
    expect(resolveRoutineSession(routine, input())!.kind).toBe("cardio");
  });
});

describe("sessionCreditsDay — overlap / kind / crediting rule", () => {
  const pushFocus = ["Chest", "Shoulders", "Arms"] as const;

  it("credits a strength day when regions overlap the focus", () => {
    expect(
      sessionCreditsDay({ regions: ["Chest"], hasCardio: false }, [
        ...pushFocus,
      ])
    ).toBe(true);
  });

  it("does NOT credit a strength day when regions miss the focus", () => {
    expect(
      sessionCreditsDay({ regions: ["Legs"], hasCardio: false }, [...pushFocus])
    ).toBe(false);
  });

  it("never credits a strength day by cardio alone", () => {
    expect(
      sessionCreditsDay({ regions: [], hasCardio: true }, [...pushFocus])
    ).toBe(false);
  });

  it("credits a cardio day (empty focus) by any cardio activity", () => {
    expect(sessionCreditsDay({ regions: [], hasCardio: true }, [])).toBe(true);
  });

  it("never credits a cardio day by strength alone", () => {
    expect(
      sessionCreditsDay({ regions: ["Chest"], hasCardio: false }, [])
    ).toBe(false);
  });

  it("a composite session credits whichever day type it matched", () => {
    // Strength day: only the regions count, cardio ignored.
    expect(
      sessionCreditsDay({ regions: ["Chest"], hasCardio: true }, [...pushFocus])
    ).toBe(true);
    // Cardio day: only cardio counts, regions ignored.
    expect(sessionCreditsDay({ regions: ["Chest"], hasCardio: true }, [])).toBe(
      true
    );
  });
});

describe("recommendNextWorkout — routine-aware path (#740)", () => {
  it("produces a session and derives focus/exercises from it", () => {
    const nw = recommendNextWorkout(input({ activeRoutine: ppl(0) }));
    expect(nw.session).not.toBeNull();
    expect(nw.session!.label).toBe("Push");
    expect(nw.items[0].reason).toBe("routine-day");
    expect(nw.items[0].kind).toBe("strength");
    expect(nw.focus).toEqual(["Chest", "Shoulders", "Arms"]);
    expect(nw.exercises).toEqual(["Barbell Bench Press"]);
  });

  it("seeds primary from the lead slot's history when present", () => {
    const seed = sRec({ exercise: "Barbell Bench Press" });
    const nw = recommendNextWorkout(
      input({ activeRoutine: ppl(0), strength: [seed] })
    );
    expect(nw.primary).toBe(seed);
  });

  it("cold start: primary is null (no load target)", () => {
    const nw = recommendNextWorkout(input({ activeRoutine: ppl(0) }));
    expect(nw.primary).toBeNull();
  });

  it("carries the deload flag onto the session (#741)", () => {
    const off = recommendNextWorkout(input({ activeRoutine: ppl(0) }));
    expect(off.session!.deloadWeek).toBe(false); // default when absent
    const on = recommendNextWorkout(
      input({ activeRoutine: ppl(0), deloadWeek: true })
    );
    expect(on.session!.deloadWeek).toBe(true);
  });

  it("a cardio-focus day yields a cardio routine-day item", () => {
    const routine: ActiveRoutineInput = {
      id: 9,
      position: 0,
      days: [{ id: 1, label: "Conditioning", focus: [], slots: [] }],
    };
    const nw = recommendNextWorkout(input({ activeRoutine: routine }));
    expect(nw.items[0].kind).toBe("cardio");
    expect(nw.items[0].reason).toBe("routine-day");
    expect(nw.session!.kind).toBe("cardio");
  });
});

describe("recommendNextWorkout — NO active routine is byte-for-byte unchanged", () => {
  // The same fixtures with and without `activeRoutine: null` must be identical to
  // the routine field simply being absent — the guard never alters the prior path.
  const base = input({
    routine: [],
    strength: [sRec()],
    cardio: [],
  });

  it("session is null and the result matches the absent-field result exactly", () => {
    const withoutField = recommendNextWorkout(base);
    const withNull = recommendNextWorkout({ ...base, activeRoutine: null });
    expect(withoutField.session).toBeNull();
    expect(withNull.session).toBeNull();
    expect(withNull).toEqual(withoutField);
  });

  it("undefined activeRoutine keeps the habit path (no session)", () => {
    const nw = recommendNextWorkout(base);
    expect(nw.session).toBeNull();
    expect(nw.items[0].reason).toBe("habit");
  });
});

describe("buildRoutineSessionPrefill — Log this session slate", () => {
  it("builds strength components + prescribed blank sets, loads left blank", () => {
    const session = resolveRoutineSession(ppl(0), input())!;
    const prefill = buildRoutineSessionPrefill(session, TODAY);
    expect(prefill.type).toBe("strength");
    expect(prefill.date).toBe(TODAY);
    expect(prefill.title).toBe("Push");
    const comps = JSON.parse(prefill.components!) as { name: string }[];
    expect(comps.map((c) => c.name)).toEqual(["Barbell Bench Press"]);
    // 4 prescribed sets, each blank of load, target_reps = top of the rep range.
    expect(prefill.sets).toHaveLength(4);
    expect(prefill.sets.every((s) => s.weight_kg === null)).toBe(true);
    expect(prefill.sets.every((s) => s.target_reps === 8)).toBe(true);
    expect(prefill.sets.map((s) => s.set_number)).toEqual([1, 2, 3, 4]);
  });

  it("Telegram nudge titles by the routine day label (#740)", () => {
    const msg = formatWorkoutReminder({
      focus: ["Chest", "Shoulders", "Arms"],
      exercises: ["Bench Press", "Overhead Press", "Dips"],
      behind: [],
      rest: null,
      onTrack: null,
      sessionLabel: "Push",
    });
    expect(msg!.title).toContain("Push day");
    expect(msg!.body).toContain("Bench Press, Overhead Press, Dips");
  });

  it("a cardio day prefills a plain cardio log", () => {
    const routine: ActiveRoutineInput = {
      id: 9,
      position: 0,
      days: [{ id: 1, label: "Conditioning", focus: [], slots: [] }],
    };
    const session = resolveRoutineSession(routine, input())!;
    const prefill = buildRoutineSessionPrefill(session, TODAY);
    expect(prefill.type).toBe("cardio");
    expect(prefill.sets).toHaveLength(0);
  });
});
