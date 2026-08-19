import { describe, it, expect } from "vitest";
import {
  strengthStanding,
  strengthLevelLabel,
  strengthTone,
  bestStanding,
  strengthStandingPhrase,
  bodyweightMultiple,
  assumesFreeWeightExecution,
  standardsGap,
  standardsGapNote,
  FREE_WEIGHT_ASSUMED_NOTE,
  STRENGTH_STANDARD_LIFTS,
} from "@/lib/strength-standards";
import { effectiveLoadKg } from "@/lib/lifts";
import { estimate1RM } from "@/lib/strength";
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

// ── #1922: assisted placement, and the pin that weighted placement did not move ──
//
// The Pull Up table's basis is the TOTAL SYSTEM LOAD (stated once in the dataset
// header): bodyweight combined with any external load. That single fact is what
// lets an assisted pull-up place honestly on the same bands, and it is also why
// adding the assisted path CANNOT move a weighted pull-up — the weighted lift's
// e1RM and the bands it is compared against are both untouched.
//
// Pull Up male @80 kg floors: [68, 80, 100, 120, 152].

describe("assisted pull-up placement (#1922)", () => {
  const BW = 80;

  it("places an assisted pull-up at bodyweight MINUS the assistance", () => {
    // 10 kg of assistance × 5 reps ⇒ 70 kg of system load ⇒ e1RM 81.67, which
    // clears the novice floor (80) but not intermediate (100).
    const s = strengthStanding(
      "Assisted Pull Up",
      estimate1RM(effectiveLoadKg("assisted", BW, 10), 5),
      "male",
      BW
    )!;
    expect(s.lift).toBe("Pull Up"); // scored against the movement it substitutes for
    expect(s.exercise).toBe("Assisted Pull Up"); // …but named by what was logged
    expect(s.bodyweightLift).toBe(true);
    expect(s.level).toBe("novice");
    expect(s.levelFloorKg).toBe(80);
    expect(s.nextLevel).toBe("intermediate");
  });

  it("drops a level as the lifter takes more help", () => {
    // 25 kg of assistance ⇒ 55 kg of load ⇒ e1RM 64.17, below the beginner floor.
    const s = strengthStanding(
      "Assisted Pull Up",
      estimate1RM(effectiveLoadKg("assisted", BW, 25), 5),
      "male",
      BW
    )!;
    expect(s.level).toBe("untrained");
    expect(s.nextLevel).toBe("beginner");
    expect(s.nextFloorKg).toBe(68);
  });

  it("declines to place when assistance cancels the load entirely", () => {
    // Assistance ≥ bodyweight leaves no measurable load; the fold clamps at 0 and
    // the lookup already refuses a non-positive 1RM.
    expect(
      strengthStanding(
        "Assisted Pull Up",
        estimate1RM(effectiveLoadKg("assisted", BW, 95), 5),
        "male",
        BW
      )
    ).toBeNull();
  });

  it("clamps at the table edges exactly as the base movement does", () => {
    // Below the lowest male band (50 kg) the thresholds clamp and the standing
    // says so — the assisted path inherits this rather than re-deriving it.
    const light = strengthStanding(
      "Assisted Pull Up",
      estimate1RM(effectiveLoadKg("assisted", 45, 5), 5),
      "male",
      45
    )!;
    expect(light.clampedBodyweight).toBe("low");
    const heavy = strengthStanding(
      "Assisted Pull Up",
      estimate1RM(effectiveLoadKg("assisted", 150, 40), 5),
      "male",
      150
    )!;
    expect(heavy.clampedBodyweight).toBe("high");
  });

  it("leaves an ASSISTED lift with no covered base unplaceable", () => {
    // Assisted Dip → Dip, which carries no standards table. No standing, and no
    // accidental fallback onto some other lift's bands.
    expect(strengthStanding("Assisted Dip", 60, "male", BW)).toBeNull();
  });

  it("PIN: today's weighted pull-up placement is unchanged", () => {
    // 20 kg added × 5 reps at 80 kg bodyweight ⇒ 100 kg system load ⇒ e1RM 116.67:
    // clears intermediate (100), short of advanced (120) by 3.33 kg. This is the
    // placement that existed before assisted loads were modeled, asserted on the
    // properties (level, floors, distance) rather than a rendering of them.
    const s = strengthStanding(
      "Pull Up",
      estimate1RM(effectiveLoadKg("added", 80, 20), 5),
      "male",
      80
    )!;
    expect(s.lift).toBe("Pull Up");
    expect(s.e1rmKg).toBeCloseTo(116.667, 3);
    expect(s.level).toBe("intermediate");
    expect(s.levelFloorKg).toBe(100);
    expect(s.nextLevel).toBe("advanced");
    expect(s.nextFloorKg).toBe(120);
    expect(s.toNextKg).toBeCloseTo(3.333, 3);
    expect(s.clampedBodyweight).toBeNull();
    // …and a single clean bodyweight rep still sits exactly on the novice floor,
    // which is the anchor the dataset's own basis comment describes.
    const bare = strengthStanding(
      "Pull Up",
      effectiveLoadKg("added", 80, 0),
      "male",
      80
    )!;
    expect(bare.e1rmKg).toBe(80);
    expect(bare.level).toBe("novice");
    expect(bare.levelFloorKg).toBe(80);
  });
});

describe("standardsGap — the machine exclusion, stated rather than silent (#1922)", () => {
  it("names a machine MOVEMENT, whose exclusion is known from the catalog", () => {
    expect(
      standardsGap("Leg Press", { e1rmKg: 200, freeWeightE1rmKg: 200 })
    ).toBe("machine-implement");
    expect(
      standardsGap("Machine Curl", { e1rmKg: 40, freeWeightE1rmKg: 40 })
    ).toBe("machine-implement");
    expect(standardsGapNote("machine-implement")).toContain("machine lifts");
  });

  it("names a machine-only HISTORY under a placeable name (#2326's evidence)", () => {
    // A bare "Overhead Press" whose every set was logged on a registry machine:
    // freeWeightE1rmKg is 0, so there is no standing — and now a reason.
    expect(
      standardsGap("Overhead Press", { e1rmKg: 90, freeWeightE1rmKg: 0 })
    ).toBe("machine-history");
    expect(standardsGapNote("machine-history")).toContain("machine");
  });

  it("stays silent when the silence has nothing to do with machines", () => {
    // A placeable lift with free-weight work behind it needs no explanation…
    expect(
      standardsGap("Overhead Press", { e1rmKg: 90, freeWeightE1rmKg: 90 })
    ).toBeNull();
    // …and neither does an accessory nobody publishes norms for, where a machine
    // note would be a confidently wrong answer.
    expect(
      standardsGap("Face Pull", { e1rmKg: 40, freeWeightE1rmKg: 40 })
    ).toBeNull();
    expect(standardsGapNote(null)).toBeNull();
  });

  it("keeps an ASSISTED lift out of the machine explanation", () => {
    // An assist machine is a counterweight, not a fixed path: the movement places,
    // so there is no gap to explain.
    expect(
      standardsGap("Assisted Pull Up", { e1rmKg: 70, freeWeightE1rmKg: 70 })
    ).toBeNull();
  });
});

describe("assumesFreeWeightExecution — the soft nudge (#1922, #798 posture)", () => {
  it("fires only when free-weight and machine work coexist under one name", () => {
    // Mixed history: the standing is scored from the free-weight sets alone, so the
    // assumption behind it is worth stating.
    expect(
      assumesFreeWeightExecution({ e1rmKg: 120, freeWeightE1rmKg: 100 })
    ).toBe(true);
    // Wholly free-weight: nothing to disclose.
    expect(
      assumesFreeWeightExecution({ e1rmKg: 100, freeWeightE1rmKg: 100 })
    ).toBe(false);
    // Wholly machine: there is no standing at all, so this is standardsGap's job.
    expect(
      assumesFreeWeightExecution({ e1rmKg: 120, freeWeightE1rmKg: 0 })
    ).toBe(false);
  });

  it("is informational, never a refusal — the note names the assumption", () => {
    expect(FREE_WEIGHT_ASSUMED_NOTE).toContain("free-weight");
  });
});
