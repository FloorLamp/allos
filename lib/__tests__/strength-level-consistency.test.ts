import { describe, it, expect } from "vitest";
import {
  strengthStanding,
  strengthBadge,
  strengthLevelLabel,
} from "@/lib/strength-standards";
import { benchmarkState } from "@/lib/analyze-view";
import { buildPillars } from "@/lib/healthspan-pillars";
import type { Sex } from "@/lib/types";

// "One question, one computation" guard (#152, per AGENTS.md / issues #221/#222/
// #223): the strength LEVEL a lifter is at must be IDENTICAL across every surface's
// formatter for the same fixture. All surfaces route through strengthStanding, so
// this pins the label the badge (ExerciseDetailPanel / StrengthExplorer /
// LevelBadge), the Analyze benchmark card, and the healthspan pillar each show —
// exactly the drift that used to let the flat-ratio badge and a second model
// disagree by a tier on the same panel.

const FIXTURES: {
  exercise: string;
  sex: Sex;
  bodyweightKg: number;
  e1rmKg: number;
}[] = [
  { exercise: "Bench Press", sex: "male", bodyweightKg: 80, e1rmKg: 100 }, // intermediate
  { exercise: "Back Squat", sex: "male", bodyweightKg: 80, e1rmKg: 220 }, // elite
  { exercise: "Deadlift", sex: "male", bodyweightKg: 80, e1rmKg: 50 }, // untrained
  { exercise: "Bench Press", sex: "female", bodyweightKg: 65, e1rmKg: 60 }, // interpolated
  { exercise: "Overhead Press", sex: "male", bodyweightKg: 95, e1rmKg: 70 }, // interpolated band
  {
    exercise: "Barbell Bench Press",
    sex: "male",
    bodyweightKg: 80,
    e1rmKg: 130,
  }, // variant → base
];

describe("strength level is one computation across every surface", () => {
  for (const f of FIXTURES) {
    it(`${f.exercise} @${f.bodyweightKg}kg ${f.sex}, e1RM ${f.e1rmKg} agrees everywhere`, () => {
      // The single source of truth.
      const standing = strengthStanding(
        f.exercise,
        f.e1rmKg,
        f.sex,
        f.bodyweightKg
      )!;
      expect(standing).not.toBeNull();
      const level = standing.level;
      const label = strengthLevelLabel(level);

      // Badge (ExerciseDetailPanel header + StrengthExplorer row + LevelBadge).
      const badge = strengthBadge(f.exercise, f.e1rmKg, f.sex, f.bodyweightKg)!;
      expect(badge.level).toBe(level);
      expect(badge.label).toBe(label);

      // Analyze benchmark card.
      const bench = benchmarkState(
        f.exercise,
        f.sex,
        f.e1rmKg,
        f.bodyweightKg
      )!;
      expect(bench.currentLevel.level).toBe(level);
      expect(bench.currentLevel.label).toBe(label);

      // Healthspan strength pillar headline.
      const [pillar] = buildPillars({
        strength: { level, lift: standing.lift },
      });
      expect(pillar.value).toBe(label);
    });
  }
});
