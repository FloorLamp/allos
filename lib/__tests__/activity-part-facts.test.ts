import { describe, it, expect } from "vitest";
import {
  moreFactsLabel,
  partFactSummary,
  partOptionsOffered,
  type PartFactKey,
} from "@/lib/activity-part-facts";
import type { PartEntry } from "@/lib/activity-form-model";

function part(over: Partial<PartEntry> = {}): PartEntry {
  return {
    name: "Barbell Bench Press",
    custom: false,
    customType: null,
    sets: [],
    perSide: false,
    equipmentId: null,
    distance: "",
    durationMin: "",
    targetReps: "",
    toFailure: false,
    ...over,
  };
}

describe("partOptionsOffered", () => {
  // THE REACHABILITY TABLE (#3367). Row 2 is the one that matters and the one an
  // `a || b || c` visibility condition loses: a lift whose NAME is not unilateral but
  // whose loaded sets carried right-side values, so `groupEditSets` marked it perSide.
  // `sides` is name-based and false, `intent` is perSide-based and false — and the
  // effort opt-in must STILL be offered, because it is `!timed` and nothing else.
  it.each([
    [
      "a plain bilateral lift",
      "Barbell Bench Press",
      false,
      [false, true, true],
    ],
    [
      "#3367: bilateral NAME, perSide STATE",
      "Barbell Bench Press",
      true,
      [false, false, true],
    ],
    ["a unilateral lift", "Hammer Curl", false, [true, true, true]],
    [
      "a unilateral lift tracking sides",
      "Hammer Curl",
      true,
      [true, false, true],
    ],
    ["a timed hold", "Plank", false, [false, false, false]],
    ["a unilateral timed hold", "Side Plank", false, [true, false, false]],
  ] as [string, string, boolean, [boolean, boolean, boolean]][])(
    "%s",
    (_name, lift, perSide, [sides, intent, effort]) => {
      expect(partOptionsOffered(part({ name: lift, perSide }))).toEqual({
        sides,
        intent,
        effort,
      });
    }
  );

  it("offers effort on every rep-based part, whatever the other two answer", () => {
    // The converse of row 2, asserted as the property rather than as a third example:
    // there is no rep-based part where the effort opt-in is unreachable. This is what
    // a conversion could quietly break while every row above still passed.
    for (const name of [
      "Barbell Bench Press",
      "Hammer Curl",
      "Curl",
      "Back Squat",
    ])
      for (const perSide of [false, true])
        for (const toFailure of [false, true])
          expect(
            partOptionsOffered(part({ name, perSide, toFailure })).effort
          ).toBe(true);
  });
});

describe("partFactSummary", () => {
  // Each row: what the chips STATE, and which offered facts have nothing to state and
  // therefore sit behind the trailing affordance.
  it.each([
    [
      "a lift with gear and nothing declared",
      part(),
      "Barbell",
      false,
      [["equipment", "Barbell", "stated"]],
      ["intent", "effort"],
    ],
    [
      "a bare variant base with no implement is a MISSING essential",
      part({ name: "Curl" }),
      null,
      false,
      [["equipment", "pick equipment", "missing"]],
      ["intent", "effort"],
    ],
    [
      "a lift with a normal implement and no gear on file states nothing and goes behind the affordance",
      part({ name: "Back Squat" }),
      null,
      false,
      [],
      ["equipment", "intent", "effort"],
    ],
    [
      "a declared rep target states itself",
      part({ targetReps: "5" }),
      "Barbell",
      false,
      [
        ["equipment", "Barbell", "stated"],
        ["intent", "target 5 reps", "stated"],
      ],
      ["effort"],
    ],
    [
      "a single-rep target is not pluralised",
      part({ targetReps: "1" }),
      "Barbell",
      false,
      [
        ["equipment", "Barbell", "stated"],
        ["intent", "target 1 rep", "stated"],
      ],
      ["effort"],
    ],
    [
      "AMRAP beats a target that is also set",
      part({ targetReps: "5", toFailure: true }),
      "Barbell",
      false,
      [
        ["equipment", "Barbell", "stated"],
        ["intent", "to failure", "stated"],
      ],
      ["effort"],
    ],
    [
      "a unilateral lift tracking sides states that, and loses its intent",
      part({ name: "Hammer Curl", perSide: true, targetReps: "8" }),
      "Dumbbell",
      true,
      [
        ["equipment", "Dumbbell", "stated"],
        ["sides", "sides tracked separately", "stated"],
        ["effort", "rating effort", "stated"],
      ],
      [],
    ],
    [
      "a timed hold offers none of the three, and its gear is behind the affordance",
      part({ name: "Plank" }),
      null,
      true,
      [],
      ["equipment"],
    ],
    [
      "#3367: a perSide bilateral lift still offers effort and nothing else",
      part({ perSide: true }),
      "Barbell",
      false,
      [["equipment", "Barbell", "stated"]],
      ["effort"],
    ],
  ] as [
    string,
    PartEntry,
    string | null,
    boolean,
    [PartFactKey, string, string][],
    PartFactKey[],
  ][])("%s", (_name, p, gearName, effortOn, chips, absent) => {
    const summary = partFactSummary({ part: p, gearName, effortOn });
    expect(summary.chips.map((c) => [c.key, c.label, c.state])).toEqual(chips);
    expect(summary.absent).toEqual(absent);
  });

  it("keeps a MISSING implement in the row and never behind the affordance", () => {
    // The one asymmetry left in this module, asserted so it is a decision rather than a
    // drift. An optional fact with nothing to state goes behind "more" — equipment
    // included, since #4046. A fact the form is WAITING for does not: a bare variant
    // base blocks the save, and a dashed essential tucked inside a trailing affordance
    // would be the form asking for something without showing that it is asking.
    const bare = partFactSummary({
      part: part({ name: "Curl" }),
      gearName: null,
      effortOn: false,
    });
    expect(bare.absent).not.toContain("equipment");
    expect(bare.chips[0]).toEqual({
      key: "equipment",
      label: "pick equipment",
      state: "missing",
    });

    // And the converse, in the same test so neither direction can drift alone: the
    // OPTIONAL absence really is behind the affordance now.
    expect(
      partFactSummary({
        part: part({ name: "Back Squat" }),
        gearName: null,
        effortOn: false,
      }).absent
    ).toContain("equipment");
  });
});

describe("moreFactsLabel", () => {
  it.each([
    [[], null],
    [["effort"], "Add effort"],
    [["intent", "effort"], "Add a target or effort"],
    [["sides", "intent", "effort"], "Add sides, a target or effort"],
    [
      ["equipment", "intent", "effort"],
      "Add equipment, a target or effort",
    ],
  ] as [PartFactKey[], string | null][])("%s", (absent, label) => {
    expect(moreFactsLabel(absent)).toBe(label);
  });
});
