import { describe, expect, it } from "vitest";
import {
  constraintCoversExercise,
  constraintsToReview,
  excludedRegionDisclosures,
  excludedRegions,
  exerciseDisclosures,
  exerciseInjuryVerdict,
  injuryConstraints,
  injuryReviewDue,
  injuryScope,
  lateralityLimitation,
  parseInjuryExercises,
  parseLoadFactor,
  parseMovements,
  regionInjuryConstraint,
  scopeChange,
  scopeSummary,
  temperedExerciseLabel,
  temperedRegions,
  RECOVERING_LOAD_FACTOR,
  type Injury,
  type InjuryConstraint,
} from "@/lib/injury-model";
import { exerciseHistoryKey } from "@/lib/lifts";

// #2024 — the constraint is still the USER'S declaration; what changed is that they can
// declare it at the level they mean. These tests pin the precedence (exercise → movement →
// region), that a precise constraint stops deleting a whole region, that a declared load
// preference beats the app's fallback, and that a limitation the engine cannot honor is
// disclosed rather than pretended away.

function inj(over: Partial<Injury> = {}): Injury {
  return {
    id: 1,
    label: "right shoulder",
    regions: ["Chest", "Shoulders"],
    muscles: [],
    status: "active",
    since: "2026-07-01",
    resolvedDate: null,
    notes: null,
    createdAt: "2026-07-01 00:00:00",
    laterality: null,
    movements: [],
    exercises: [],
    loadFactor: null,
    reviewDate: null,
    ...over,
  };
}

describe("scope precedence", () => {
  it("exercise beats movement beats region", () => {
    expect(injuryScope(["bench press"], ["push"])).toBe("exercise");
    expect(injuryScope([], ["push"])).toBe("movement");
    expect(injuryScope([], [])).toBe("region");
  });

  it("an injury with no declared precision is region-scoped, exactly as before", () => {
    const [c] = injuryConstraints([inj()]);
    expect(c.scope).toBe("region");
    expect(c.regions).toEqual(["Chest", "Shoulders"]);
    expect(c.movements).toEqual([]);
    expect(c.exercises).toEqual([]);
    expect(c.loadFactor).toBeNull();
  });

  it("resolved injuries still exert no effect at any scope", () => {
    expect(
      injuryConstraints([
        inj({
          status: "resolved",
          exercises: [exerciseHistoryKey("Bench Press")],
        }),
      ])
    ).toEqual([]);
  });
});

describe("a precise constraint does not delete its whole region", () => {
  const benchOnly: InjuryConstraint = {
    ...regionInjuryConstraint({
      id: 1,
      label: "right shoulder",
      status: "active",
      regions: ["Chest"],
    }),
    scope: "exercise",
    exercises: [exerciseHistoryKey("Bench Press")],
  };

  it("the region stays available", () => {
    expect(excludedRegions([benchOnly]).size).toBe(0);
    expect(excludedRegionDisclosures([benchOnly])).toEqual([]);
  });

  it("but the named lift is excluded", () => {
    expect(exerciseInjuryVerdict([benchOnly], "Bench Press").kind).toBe(
      "excluded"
    );
  });

  it("and an unrelated lift in the same region is untouched", () => {
    expect(exerciseInjuryVerdict([benchOnly], "Cable Fly").kind).toBe("clear");
  });

  it("identity is canonical, not the raw label", () => {
    const curl: InjuryConstraint = {
      ...benchOnly,
      exercises: parseInjuryExercises(JSON.stringify(["Curl"])),
    };
    // "Barbell Curl" merges to the same canonical identity as "Curl".
    expect(exerciseHistoryKey("Barbell Curl")).toBe(exerciseHistoryKey("Curl"));
    expect(constraintCoversExercise(curl, "Barbell Curl")).toBe(true);
  });

  it("a movement-scoped constraint covers its pattern and nothing else", () => {
    const pressing: InjuryConstraint = {
      ...regionInjuryConstraint({
        id: 2,
        label: "pressing",
        status: "active",
        regions: ["Chest", "Shoulders"],
      }),
      scope: "movement",
      movements: parseMovements(JSON.stringify(["push"])),
    };
    expect(excludedRegions([pressing]).size).toBe(0);
    expect(exerciseInjuryVerdict([pressing], "Bench Press").kind).toBe(
      "excluded"
    );
    expect(exerciseInjuryVerdict([pressing], "Barbell Row").kind).toBe("clear");
  });

  it("a region-scoped constraint still excludes its whole region", () => {
    const whole = regionInjuryConstraint({
      id: 3,
      label: "shoulder",
      status: "active",
      regions: ["Chest"],
    });
    expect([...excludedRegions([whole])]).toEqual(["Chest"]);
    expect(exerciseInjuryVerdict([whole], "Bench Press").kind).toBe("excluded");
    expect(exerciseInjuryVerdict([whole], "Cable Fly").kind).toBe("excluded");
  });
});

describe("overlapping constraints", () => {
  const recoveringRegion = regionInjuryConstraint({
    id: 1,
    label: "chest strain",
    status: "recovering",
    regions: ["Chest"],
  });
  const activeLift: InjuryConstraint = {
    ...regionInjuryConstraint({
      id: 2,
      label: "bench tweak",
      status: "active",
      regions: ["Chest"],
    }),
    scope: "exercise",
    exercises: [exerciseHistoryKey("Bench Press")],
  };

  it("active exclusion wins over recovering tempering on the same lift", () => {
    const v = exerciseInjuryVerdict(
      [recoveringRegion, activeLift],
      "Bench Press"
    );
    expect(v.kind).toBe("excluded");
    expect(v.labels).toEqual(["bench tweak"]);
  });

  it("a sibling lift in the tempered region is still only tempered", () => {
    expect(
      exerciseInjuryVerdict([recoveringRegion, activeLift], "Cable Fly").kind
    ).toBe("tempered");
  });

  it("the tightest declared preference wins across overlapping recovering constraints", () => {
    const a: InjuryConstraint = { ...recoveringRegion, loadFactor: 0.8 };
    const b: InjuryConstraint = {
      ...recoveringRegion,
      id: 9,
      label: "other",
      loadFactor: 0.5,
    };
    const v = exerciseInjuryVerdict([a, b], "Cable Fly");
    expect(v.factor).toBe(0.5);
    expect(v.fallback).toBe(false);
    expect(v.labels).toEqual(["chest strain", "other"]);
  });
});

describe("the 60% is a fallback, not a prescription", () => {
  const base = regionInjuryConstraint({
    id: 1,
    label: "knee",
    status: "recovering",
    regions: ["Legs"],
  });

  it("with no declared preference the app's default applies and says so", () => {
    const v = exerciseInjuryVerdict([base], "Back Squat");
    expect(v.kind).toBe("tempered");
    expect(v.factor).toBe(RECOVERING_LOAD_FACTOR);
    expect(v.fallback).toBe(true);
  });

  it("a user-declared preference wins and is not marked a fallback", () => {
    const v = exerciseInjuryVerdict(
      [{ ...base, loadFactor: 0.85 }],
      "Back Squat"
    );
    expect(v.factor).toBe(0.85);
    expect(v.fallback).toBe(false);
  });

  it("the disclosure names which one it is", () => {
    const fallback = temperedExerciseLabel({
      exercise: "Back Squat",
      injuryLabels: ["knee"],
      factor: RECOVERING_LOAD_FACTOR,
      fallback: true,
      limitations: [],
    });
    expect(fallback).toContain("60%");
    expect(fallback).toContain("default");
    const declared = temperedExerciseLabel({
      exercise: "Back Squat",
      injuryLabels: ["knee"],
      factor: 0.85,
      fallback: false,
      limitations: [],
    });
    expect(declared).toContain("85%");
    expect(declared).toContain("your setting");
  });

  it("a factor outside the documented range is refused, never clamped", () => {
    expect(parseLoadFactor(0.6)).toBe(0.6);
    expect(parseLoadFactor("0.85")).toBe(0.85);
    expect(parseLoadFactor(0)).toBeNull();
    expect(parseLoadFactor(3)).toBeNull();
    expect(parseLoadFactor("nonsense")).toBeNull();
  });
});

describe("laterality is disclosed, never pretended", () => {
  const leftKnee: InjuryConstraint = {
    ...regionInjuryConstraint({
      id: 1,
      label: "left knee",
      status: "recovering",
      regions: ["Legs"],
    }),
    laterality: "left",
  };

  it("a bilateral lift discloses that the side could not be honored", () => {
    const note = lateralityLimitation(leftKnee, "Back Squat");
    expect(note).toContain("both sides");
    expect(note).toContain("left");
  });

  it("a unilateral lift needs no such disclosure", () => {
    expect(lateralityLimitation(leftKnee, "Bulgarian Split Squat")).toBeNull();
  });

  it("a constraint with no declared side discloses nothing", () => {
    expect(
      lateralityLimitation({ ...leftKnee, laterality: null }, "Back Squat")
    ).toBeNull();
    expect(
      lateralityLimitation(
        { ...leftKnee, laterality: "bilateral" },
        "Back Squat"
      )
    ).toBeNull();
  });

  it("the verdict carries the limitation so every surface can render it", () => {
    expect(
      exerciseInjuryVerdict([leftKnee], "Back Squat").limitations.length
    ).toBe(1);
  });
});

describe("exercise disclosures name only what actually changed", () => {
  const benchOnly: InjuryConstraint = {
    ...regionInjuryConstraint({
      id: 1,
      label: "right shoulder",
      status: "active",
      regions: ["Chest"],
    }),
    scope: "exercise",
    exercises: [exerciseHistoryKey("Bench Press")],
  };

  it("lists the excluded lift and not its unaffected neighbours", () => {
    const d = exerciseDisclosures(
      [benchOnly],
      ["Bench Press", "Cable Fly", "Barbell Row"]
    );
    expect(d.excluded.map((x) => x.exercise)).toEqual(["Bench Press"]);
    expect(d.tempered).toEqual([]);
  });

  it("a region-scoped constraint keeps its region-level disclosure only", () => {
    const whole = regionInjuryConstraint({
      id: 2,
      label: "shoulder",
      status: "active",
      regions: ["Chest"],
    });
    const d = exerciseDisclosures([whole], ["Bench Press", "Cable Fly"]);
    expect(d.excluded).toEqual([]);
    expect(excludedRegionDisclosures([whole]).length).toBe(1);
  });

  it("a tempered lift carries its factor and its origin", () => {
    const easing: InjuryConstraint = {
      ...benchOnly,
      status: "recovering",
      loadFactor: 0.5,
    };
    const d = exerciseDisclosures([easing], ["Bench Press"]);
    expect(d.tempered[0]).toMatchObject({
      exercise: "Bench Press",
      factor: 0.5,
      fallback: false,
    });
  });

  it("does not list the same canonical lift twice under two spellings", () => {
    const curl: InjuryConstraint = {
      ...benchOnly,
      exercises: [exerciseHistoryKey("Curl")],
    };
    const d = exerciseDisclosures([curl], ["Curl", "Barbell Curl"]);
    expect(d.excluded.length).toBe(1);
  });
});

describe("region tempering still works for region-scoped constraints", () => {
  it("recovering regions temper, actively excluded ones do not", () => {
    const recovering = regionInjuryConstraint({
      id: 1,
      label: "chest",
      status: "recovering",
      regions: ["Chest", "Shoulders"],
    });
    const active = regionInjuryConstraint({
      id: 2,
      label: "shoulder",
      status: "active",
      regions: ["Shoulders"],
    });
    expect([...temperedRegions([recovering, active])]).toEqual(["Chest"]);
  });

  it("a finer constraint contributes no tempered REGION", () => {
    const fine: InjuryConstraint = {
      ...regionInjuryConstraint({
        id: 1,
        label: "pressing",
        status: "recovering",
        regions: ["Chest"],
      }),
      scope: "movement",
      movements: ["push"],
    };
    expect(temperedRegions([fine]).size).toBe(0);
    expect(exerciseInjuryVerdict([fine], "Bench Press").kind).toBe("tempered");
  });
});

// #2297 — a constraint is understood gradually, so it must be correctable. These pin the
// two pure pieces the edit form is built on: the summary the chip and the form share, and
// the CHANGE an edit would make, resolved through the same coverage rule the engine uses.
describe("the scope reads back at the level it was declared", () => {
  it("names lifts, then patterns, then regions — with the side when there is one", () => {
    expect(scopeSummary(inj({ regions: ["Chest"] }))).toBe("Chest");
    expect(scopeSummary(inj({ regions: ["Chest"], movements: ["push"] }))).toBe(
      "Pushing"
    );
    expect(
      scopeSummary(
        inj({
          regions: ["Chest"],
          movements: ["push"],
          exercises: ["bench press"],
        })
      )
      // The stored identity renders in the catalog's own casing, not the key's.
    ).toBe("Bench Press");
    expect(scopeSummary(inj({ regions: ["Chest"], laterality: "right" }))).toBe(
      "right side · Chest"
    );
    // "Both sides" is not a side qualifier worth saying.
    expect(
      scopeSummary(inj({ regions: ["Chest"], laterality: "bilateral" }))
    ).toBe("Chest");
  });
});

describe("what editing a scope would change", () => {
  const candidates = ["Bench Press", "Cable Fly", "Overhead Press", "Curl"];

  it("narrowing a region to lifts RELEASES the rest of the region", () => {
    const change = scopeChange(
      { regions: ["Chest"], movements: [], exercises: [], laterality: null },
      {
        regions: ["Chest"],
        movements: [],
        // The draft holds user-facing names; the saved row holds keys. Both resolve
        // through exerciseHistoryKey, so the preview compares like with like.
        exercises: ["Bench Press"],
        laterality: null,
      },
      candidates
    );
    expect(change.released).toEqual(["Cable Fly"]);
    expect(change.added).toEqual([]);
  });

  it("widening a lift back to its movement pattern ADDS what it now covers", () => {
    const change = scopeChange(
      {
        regions: ["Chest"],
        movements: [],
        exercises: ["bench press"],
        laterality: null,
      },
      {
        regions: ["Chest"],
        movements: ["push"],
        exercises: [],
        laterality: null,
      },
      candidates
    );
    // Overhead Press is a Shoulders lift, so only the pattern reaches it; Curl is a pull.
    expect(change.added).toEqual(["Cable Fly", "Overhead Press"]);
    expect(change.released).toEqual([]);
  });

  it("an unchanged declaration changes nothing", () => {
    const same = {
      regions: ["Chest" as const],
      movements: ["push" as const],
      exercises: [],
      laterality: null,
    };
    expect(scopeChange(same, same, candidates)).toEqual({
      released: [],
      added: [],
    });
  });

  it("a finer muscle still rolls up to its region on both sides", () => {
    // Declared by MUSCLE only (no region): the rollup is what the constraint covers, so
    // narrowing it to one lift releases the rest of that region and nothing else.
    const change = scopeChange(
      {
        regions: [],
        muscles: ["chest"],
        movements: [],
        exercises: [],
        laterality: null,
      },
      {
        regions: [],
        muscles: ["chest"],
        movements: [],
        exercises: ["Bench Press"],
        laterality: null,
      },
      candidates
    );
    expect(change.released).toEqual(["Cable Fly"]);
  });

  it("counts a lift once however many spellings the list holds", () => {
    const change = scopeChange(
      { regions: ["Chest"], movements: [], exercises: [], laterality: null },
      {
        regions: ["Chest"],
        movements: [],
        exercises: ["Cable Fly"],
        laterality: null,
      },
      ["Bench Press", "Barbell Bench Press"]
    );
    expect(change.released).toEqual(["Bench Press"]);
  });
});

describe("review dates only ever suggest", () => {
  const c: InjuryConstraint = {
    ...regionInjuryConstraint({
      id: 1,
      label: "knee",
      status: "active",
      regions: ["Legs"],
    }),
    reviewDate: "2026-08-01",
  };

  it("is due on and after the date the user set", () => {
    expect(injuryReviewDue(c, "2026-07-31")).toBe(false);
    expect(injuryReviewDue(c, "2026-08-01")).toBe(true);
    expect(injuryReviewDue(c, "2026-09-01")).toBe(true);
  });

  it("no review date means never prompted", () => {
    expect(injuryReviewDue({ ...c, reviewDate: null }, "2030-01-01")).toBe(
      false
    );
  });

  it("a due review changes NOTHING about the constraint itself", () => {
    const before = exerciseInjuryVerdict([c], "Back Squat");
    expect(constraintsToReview([c], "2026-09-01")).toEqual([c]);
    const after = exerciseInjuryVerdict([c], "Back Squat");
    expect(after).toEqual(before);
    expect(after.kind).toBe("excluded"); // still active, still excluded
    expect(c.status).toBe("active");
  });
});
