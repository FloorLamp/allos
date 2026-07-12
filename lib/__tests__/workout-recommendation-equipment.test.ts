import { describe, expect, it } from "vitest";
import {
  recommendNextWorkout,
  type NextWorkoutInput,
  type DatedExercise,
} from "@/lib/workout-recommendation";
import type { StrengthRecent } from "@/lib/coaching";
import type { EquipmentAvailability } from "@/lib/equipment-availability";

// Equipment-aware "train today" (issue #345): the ONE workout-recommendation core
// prefers gear-satisfiable lifts when the profile has a non-empty registry, so the
// dashboard card AND the Telegram nudge (both formatters over this core) agree by
// construction. An empty/absent registry changes nothing (gym-goers own no rows).

const TODAY = "2026-07-08";

function sRec(over: Partial<StrengthRecent>): StrengthRecent {
  return {
    exercise: "Back Squat",
    bodyweight: false,
    lastSessionBest: {
      weightKg: 100,
      reps: 5,
      targetReps: null,
      toFailure: false,
    },
    lastDate: "2026-07-01",
    ...over,
  };
}

function input(over: Partial<NextWorkoutInput> = {}): NextWorkoutInput {
  return { today: TODAY, routine: [], strength: [], cardio: [], ...over };
}

// Two Legs lifts: a Barbell one (Back Squat) trained least-recently so it leads by
// default, and a Dumbbell one (Goblet Squat). No dated history ⇒ aggregate path.
const STRENGTH = [
  sRec({ exercise: "Back Squat", lastDate: "2026-07-01" }), // older → leads by default
  sRec({ exercise: "Goblet Squat", lastDate: "2026-07-03" }),
];

describe("recommendNextWorkout — equipment preference (#345)", () => {
  it("without availability, the least-recent (barbell) lift leads", () => {
    const nw = recommendNextWorkout(input({ strength: STRENGTH }));
    expect(nw.exercises[0]).toBe("Back Squat");
    expect(nw.primary?.exercise).toBe("Back Squat");
  });

  it("a dumbbell-only registry de-ranks the barbell lift and leads with the dumbbell one", () => {
    const avail: EquipmentAvailability = {
      hasAny: true,
      categories: ["Dumbbell"],
    };
    const nw = recommendNextWorkout(
      input({ strength: STRENGTH, availableEquipment: avail })
    );
    expect(nw.exercises[0]).toBe("Goblet Squat");
    expect(nw.primary?.exercise).toBe("Goblet Squat");
    // De-rank, not hide — the barbell lift is still present, just lower.
    expect(nw.exercises).toContain("Back Squat");
  });

  it("an EMPTY registry leaves the ordering unchanged (gym-goer escape hatch)", () => {
    const avail: EquipmentAvailability = { hasAny: false, categories: [] };
    const nw = recommendNextWorkout(
      input({ strength: STRENGTH, availableEquipment: avail })
    );
    expect(nw.exercises[0]).toBe("Back Squat");
  });

  it("de-ranks within the dated-history path too", () => {
    // Both lifts logged; Back Squat more frequent so it would lead by frequency,
    // but a dumbbell-only registry sinks it below the available Goblet Squat.
    const dated: DatedExercise[] = [
      { date: "2026-07-06", exercise: "Back Squat" },
      { date: "2026-07-05", exercise: "Back Squat" },
      { date: "2026-07-04", exercise: "Goblet Squat" },
    ];
    const avail: EquipmentAvailability = {
      hasAny: true,
      categories: ["Dumbbell"],
    };
    const nw = recommendNextWorkout(
      input({
        strength: STRENGTH,
        datedExercises: dated,
        availableEquipment: avail,
      })
    );
    expect(nw.exercises[0]).toBe("Goblet Squat");
    expect(nw.primary?.exercise).toBe("Goblet Squat");
  });
});
