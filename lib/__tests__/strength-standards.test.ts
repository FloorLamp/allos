import { describe, it, expect } from "vitest";
import {
  strengthStanding,
  strengthLevelLabel,
  strengthTone,
  bestStanding,
  strengthStandingPhrase,
  bodyweightMultiple,
  STRENGTH_STANDARD_LIFTS,
} from "@/lib/strength-standards";
import { fmtWeight } from "@/lib/units";

// Pure lookup tests for the baked bodyweight-band strength standards (issue #152).
// The reference bodyweight for men is 80 kg, where the baked thresholds equal the
// anchor ratios × bodyweight exactly — e.g. Bench Press male @80 kg =
// [40, 60, 80, 120, 160] for [beginner, novice, intermediate, advanced, elite].

describe("strengthStanding — levels at the reference bodyweight", () => {
  it("places a 1RM at the level whose floor it clears (interior band)", () => {
    // 100 kg clears intermediate (80) but not advanced (120).
    const s = strengthStanding("Bench Press", 100, "male", 80);
    expect(s).not.toBeNull();
    expect(s!.level).toBe("intermediate");
    expect(s!.levelFloorKg).toBe(80);
    expect(s!.nextLevel).toBe("advanced");
    expect(s!.nextFloorKg).toBe(120);
    expect(s!.toNextKg).toBe(20);
    expect(s!.clampedBodyweight).toBeNull();
  });

  it("treats an exact floor as reaching that level (band edge)", () => {
    // Exactly 40 kg is the beginner floor → beginner, 20 kg to novice (60).
    const s = strengthStanding("Bench Press", 40, "male", 80)!;
    expect(s.level).toBe("beginner");
    expect(s.levelFloorKg).toBe(40);
    expect(s.nextLevel).toBe("novice");
    expect(s.toNextKg).toBe(20);
  });

  it("labels a 1RM below the beginner floor as untrained, climbing to beginner", () => {
    const s = strengthStanding("Bench Press", 30, "male", 80)!;
    expect(s.level).toBe("untrained");
    expect(s.levelFloorKg).toBeNull();
    expect(s.nextLevel).toBe("beginner");
    expect(s.nextFloorKg).toBe(40);
    expect(s.toNextKg).toBe(10);
  });

  it("caps at elite above the top floor (no next level)", () => {
    const s = strengthStanding("Bench Press", 200, "male", 80)!;
    expect(s.level).toBe("elite");
    expect(s.levelFloorKg).toBe(160);
    expect(s.nextLevel).toBeNull();
    expect(s.nextFloorKg).toBeNull();
    expect(s.toNextKg).toBeNull();
  });

  it("treats an exact elite floor as elite", () => {
    const s = strengthStanding("Bench Press", 160, "male", 80)!;
    expect(s.level).toBe("elite");
    expect(s.nextLevel).toBeNull();
  });
});

describe("strengthStanding — bodyweight interpolation", () => {
  it("interpolates the threshold vector linearly between bodyweight bands", () => {
    // Bench Press male: @50 kg intermediate floor = 58.5, @60 kg = 66. At the
    // 55 kg midpoint the intermediate floor is their mean (62.25).
    const mid = (58.5 + 66) / 2;
    const atFloor = strengthStanding("Bench Press", mid, "male", 55)!;
    expect(atFloor.level).toBe("intermediate");
    expect(atFloor.levelFloorKg).toBeCloseTo(mid, 5);

    // Just below that interpolated floor → novice, with the gap to intermediate.
    const below = strengthStanding("Bench Press", mid - 1, "male", 55)!;
    expect(below.level).toBe("novice");
    expect(below.nextLevel).toBe("intermediate");
    expect(below.toNextKg).toBeCloseTo(1, 5);
  });

  it("clamps below the lightest band and flags it", () => {
    // 40 kg is below the male 50 kg lightest band → uses the 50 kg vector, clamped.
    const s = strengthStanding("Bench Press", 100, "male", 40)!;
    expect(s.clampedBodyweight).toBe("low");
  });

  it("clamps above the heaviest band and flags it", () => {
    // 200 kg is above the male 140 kg heaviest band → uses the 140 kg vector.
    const s = strengthStanding("Bench Press", 100, "male", 200)!;
    expect(s.clampedBodyweight).toBe("high");
  });

  it("does not flag a bodyweight sitting exactly on a band", () => {
    const s = strengthStanding("Bench Press", 100, "male", 80)!;
    expect(s.clampedBodyweight).toBeNull();
  });
});

describe("strengthStanding — lift resolution", () => {
  it("maps a barbell variant onto its base lift", () => {
    const base = strengthStanding("Bench Press", 100, "male", 80)!;
    const variant = strengthStanding("Barbell Bench Press", 100, "male", 80)!;
    expect(variant.lift).toBe("Bench Press");
    expect(variant.level).toBe(base.level);
    expect(variant.levelFloorKg).toBe(base.levelFloorKg);
  });

  it("resolves the canonical plain lifts and the weighted pull-up", () => {
    expect(strengthStanding("Back Squat", 120, "male", 80)!.level).toBe(
      "intermediate"
    );
    expect(strengthStanding("Deadlift", 140, "male", 80)!.level).toBe(
      "intermediate"
    );
    const pull = strengthStanding("Pull Up", 100, "male", 80)!;
    expect(pull.bodyweightLift).toBe(true);
    expect(pull.level).toBe("intermediate"); // @80 kg pull-up floors [68,80,100,120,152]
  });

  it("uses the sex-appropriate table (women have lower absolute floors)", () => {
    const male = strengthStanding("Bench Press", 60, "male", 65)!;
    const female = strengthStanding("Bench Press", 60, "female", 65)!;
    // The same 60 kg 1RM rates higher for a woman than a man at 65 kg bodyweight.
    expect(female.level).not.toBe(male.level);
  });
});

describe("strengthStanding — missing data hides the standing (null)", () => {
  it("returns null when sex is unset", () => {
    expect(strengthStanding("Bench Press", 100, null, 80)).toBeNull();
    expect(strengthStanding("Bench Press", 100, undefined, 80)).toBeNull();
  });

  it("returns null when bodyweight is unset or non-positive", () => {
    expect(strengthStanding("Bench Press", 100, "male", null)).toBeNull();
    expect(strengthStanding("Bench Press", 100, "male", 0)).toBeNull();
    expect(strengthStanding("Bench Press", 100, "male", NaN)).toBeNull();
  });

  it("returns null when the estimated 1RM is unset or non-positive", () => {
    expect(strengthStanding("Bench Press", null, "male", 80)).toBeNull();
    expect(strengthStanding("Bench Press", 0, "male", 80)).toBeNull();
  });

  it("returns null for a lift with no baked table", () => {
    expect(strengthStanding("Bicep Curl", 30, "male", 80)).toBeNull();
    expect(strengthStanding("Dumbbell Bench Press", 30, "male", 80)).toBeNull();
  });
});

describe("labels, tone, ranking, and best standing", () => {
  it("labels every level", () => {
    expect(strengthLevelLabel("untrained")).toBe("Untrained");
    expect(strengthLevelLabel("intermediate")).toBe("Intermediate");
    expect(strengthLevelLabel("elite")).toBe("Elite");
  });

  it("buckets tone by level", () => {
    expect(strengthTone("elite")).toBe("good");
    expect(strengthTone("advanced")).toBe("good");
    expect(strengthTone("intermediate")).toBe("warn");
    expect(strengthTone("novice")).toBe("warn");
    expect(strengthTone("beginner")).toBe("bad");
    expect(strengthTone("untrained")).toBe("bad");
  });

  it("bestStanding picks the strongest level across lifts", () => {
    const squat = strengthStanding("Back Squat", 220, "male", 80)!; // elite
    const bench = strengthStanding("Bench Press", 90, "male", 80)!; // intermediate
    expect(bestStanding([bench, squat])!.lift).toBe("Back Squat");
    expect(bestStanding([bench, squat])!.level).toBe("elite");
    expect(bestStanding([])).toBeNull();
  });

  it("exposes the covered lifts (five core + three retired-model carryovers)", () => {
    expect(STRENGTH_STANDARD_LIFTS.sort()).toEqual(
      [
        "Back Squat",
        "Bench Press",
        "Chin Up",
        "Deadlift",
        "Front Squat",
        "Incline Bench Press",
        "Overhead Press",
        "Pull Up",
      ].sort()
    );
  });

  it("covers the lifts the retired flat-ratio model used to level", () => {
    // Front Squat / Incline Bench / Chin Up were carried over so unifying onto the
    // new model doesn't drop a lift that used to show a level.
    expect(strengthStanding("Front Squat", 120, "male", 80)).not.toBeNull();
    expect(
      strengthStanding("Incline Bench Press", 80, "male", 80)
    ).not.toBeNull();
    expect(strengthStanding("Chin Up", 90, "male", 80)!.bodyweightLift).toBe(
      true
    );
  });
});

// The coaching sentence beneath the level badge (issue #314) — one phrase over the
// SINGLE standing, tier-boundary cases pinned. Bench Press male @80 kg floors are
// [40, 60, 80, 120, 160] for [beginner, novice, intermediate, advanced, elite].
describe("strengthStandingPhrase — tier-boundary sentences", () => {
  it("untrained: distance to the beginner standard", () => {
    const s = strengthStanding("Bench Press", 30, "male", 80)!;
    expect(strengthStandingPhrase(s, "male", "kg")).toBe(
      "10 kg from the beginner standard for men at your bodyweight."
    );
  });

  it("a middle tier: current standard plus distance to the next level", () => {
    const s = strengthStanding("Bench Press", 100, "male", 80)!;
    expect(strengthStandingPhrase(s, "male", "kg")).toBe(
      "At the intermediate standard for men at your bodyweight — 20 kg to advanced."
    );
  });

  it("elite: the top band, no next level", () => {
    const s = strengthStanding("Bench Press", 200, "male", 80)!;
    expect(strengthStandingPhrase(s, "male", "kg")).toBe(
      "At the elite standard for men at your bodyweight — the top band."
    );
  });

  it("uses the sex-appropriate word for women", () => {
    const s = strengthStanding("Bench Press", 100, "male", 80)!;
    expect(strengthStandingPhrase(s, "female", "kg")).toContain(
      "for women at your bodyweight"
    );
  });

  it("renders distances in the requested weight unit", () => {
    const s = strengthStanding("Bench Press", 100, "male", 80)!;
    // toNextKg is 20 kg here → formatted through fmtWeight in lb.
    expect(strengthStandingPhrase(s, "male", "lb")).toBe(
      `At the intermediate standard for men at your bodyweight — ${fmtWeight(
        20,
        "lb"
      )} to advanced.`
    );
  });
});

describe("bodyweightMultiple — 1RM ÷ bodyweight", () => {
  it("computes the ratio when bodyweight is known", () => {
    expect(bodyweightMultiple(120, 80)).toBeCloseTo(1.5, 10);
  });
  it("is null without a bodyweight", () => {
    expect(bodyweightMultiple(120, null)).toBeNull();
    expect(bodyweightMultiple(120, undefined)).toBeNull();
    expect(bodyweightMultiple(120, 0)).toBeNull();
  });
  it("is null for a non-positive 1RM", () => {
    expect(bodyweightMultiple(0, 80)).toBeNull();
  });
});
