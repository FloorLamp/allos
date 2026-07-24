import { describe, expect, it } from "vitest";
import {
  plateauVariations,
  plateauBreakAdvice,
  plateauFindingDetail,
  plateauInlineHint,
} from "@/lib/plateau-advice";
import { exerciseHistoryKey } from "@/lib/lifts";
import {
  suggestNextSet,
  RPE_HARD_MIN,
  type ExerciseSummary,
} from "@/lib/coaching";

describe("plateauVariations (#1203/#482)", () => {
  it("names 1–2 same-primary-muscle catalog lifts", () => {
    const v = plateauVariations("Bench Press");
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v.length).toBeLessThanOrEqual(2);
    // Every suggestion is a distinct history from the plateaued lift…
    const source = exerciseHistoryKey("Bench Press");
    for (const name of v) expect(exerciseHistoryKey(name)).not.toBe(source);
    // …and shares its chest primary mover (Cable Fly / Close-Grip Bench Press).
    expect(v).toContain("Cable Fly");
  });

  it("EXCLUDES an equipment/variant sibling that collapses to the same history (#482)", () => {
    // "Barbell Curl" collapses to "curl"; the bare "Curl" base and "Dumbbell Curl"
    // share that history, so neither is a fresh stimulus and both must be excluded.
    const v = plateauVariations("Barbell Curl");
    const source = exerciseHistoryKey("Barbell Curl");
    for (const name of v) expect(exerciseHistoryKey(name)).not.toBe(source);
    expect(v).not.toContain("Curl");
    expect(v).not.toContain("Dumbbell Curl");
  });

  it("resolves the same variations for a composed variant as its base", () => {
    // "Barbell Bench Press" and "Bench Press" share one history — same suggestions.
    expect(plateauVariations("Barbell Bench Press")).toEqual(
      plateauVariations("Bench Press")
    );
  });

  it("is deterministic (alphabetical)", () => {
    const v = plateauVariations("Bench Press");
    expect(v).toEqual([...v].sort((a, b) => a.localeCompare(b)));
  });

  it("degrades to empty for a custom/freeform lift not in the catalog", () => {
    expect(plateauVariations("Zercher Zombie Lift")).toEqual([]);
  });
});

describe("plateauBreakAdvice", () => {
  it("carries the shared ~10% deload magnitude and named variations", () => {
    const a = plateauBreakAdvice("Bench Press");
    expect(a.deloadPhrase).toContain("~10%");
    expect(a.variationPhrase).toContain("(");
    expect(a.scheduledDeloadWhen).toBeNull();
  });

  it("points at a scheduled deload week when one is ≤2 weeks out (#741)", () => {
    expect(
      plateauBreakAdvice("Bench Press", {
        upcomingDeload: { weeksUntilDeload: 1 },
      }).scheduledDeloadWhen
    ).toBe("is next week");
    expect(
      plateauBreakAdvice("Bench Press", {
        upcomingDeload: { weeksUntilDeload: 0 },
      }).scheduledDeloadWhen
    ).toBe("is this week");
    // >2 weeks out ⇒ keep the ad-hoc drop.
    expect(
      plateauBreakAdvice("Bench Press", {
        upcomingDeload: { weeksUntilDeload: 3 },
      }).scheduledDeloadWhen
    ).toBeNull();
  });

  it("bare 'a variation' with no named parens for a catalog miss", () => {
    const a = plateauBreakAdvice("Zercher Zombie Lift");
    expect(a.variations).toEqual([]);
    expect(a.variationPhrase).toBe("a variation");
  });
});

// #221 — the no-drift property: the plateau finding detail, the next-set rationale,
// and the inline form hint must all carry the SAME concrete facts (the ~10% deload
// magnitude and the same named variations) because they all format the one helper.
describe("plateau-break copy is unified across all three surfaces (#221)", () => {
  const EXERCISE = "Bench Press";
  const advice = plateauBreakAdvice(EXERCISE);

  const findingDetail = plateauFindingDetail(EXERCISE);
  const inlineHint = plateauInlineHint(EXERCISE);
  const seed: ExerciseSummary = {
    exercise: EXERCISE,
    sessions: 3,
    bodyweight: false,
    e1rmKg: 100,
    bestWeightKg: 90,
    bestReps: 5,
    bestDate: "2026-06-20",
    topWeightKg: 90,
    topWeightDate: "2026-06-20",
    lastDate: "2026-06-20",
    // Near-failure and still under the rep floor ⇒ the plateau-break rationale branch.
    lastSessionBest: { weightKg: 80, reps: 3, rpe: RPE_HARD_MIN },
  };
  const nextSetRationale = suggestNextSet(seed)!.rationale;

  const surfaces = { findingDetail, nextSetRationale, inlineHint };

  it("every surface carries the ~10% deload magnitude", () => {
    for (const copy of Object.values(surfaces)) {
      expect(copy).toContain(advice.deloadPhrase);
      expect(copy).toContain("~10%");
    }
  });

  it("every surface names the same variations", () => {
    expect(advice.variations.length).toBeGreaterThan(0);
    for (const copy of Object.values(surfaces)) {
      expect(copy).toContain(advice.variationPhrase);
      for (const name of advice.variations) expect(copy).toContain(name);
    }
  });
});
