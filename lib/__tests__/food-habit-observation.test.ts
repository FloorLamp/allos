// PURE TIER — the monthly food-habit observation (#2397). No DB, no clock.
//
// Two halves are under test, and the second one is a DOCTRINE constraint rather than an
// arithmetic one. The first: the sentence states a SHARE of the days food was logged at
// all, with a rationale drawn from the curated nutrient map. The second: the observation
// cannot carry a biomarker, cannot reach one, and cannot be handed one — because
// "your pattern, your flagged result, draw your own conclusion" is an assertion the app
// has no standing to make however carefully it is worded, and a wording rule is not
// enforceable. A structure is.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FOOD_HABIT_MAX_NAMED,
  FOOD_HABIT_MAX_NUTRIENTS,
  foodHabitObservations,
  foodHabitRationale,
  foodHabitSentence,
} from "@/lib/food-habit-observation";
import { foodPeriodRegularity } from "@/lib/food-regularity";
import { shiftDateStr } from "@/lib/date";

const FROM = "2026-07-01";
const TO = "2026-07-30";
const on = (d: number) => shiftDateStr(FROM, d);
const dayEvents = (groupKey: string, days: readonly number[]) =>
  days.map((d) => ({ groupKey, date: on(d) }));
const period = (events: readonly { groupKey: string; date: string }[]) =>
  foodPeriodRegularity(events, { from: FROM, to: TO });

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

describe("the curated rationale (#2397)", () => {
  it("names the nutrients the CATALOG links the group to, through the map's labels", () => {
    // Nothing is inferred: the link is the food catalog's own `nutrients`, and the noun
    // is the #577 map entry's label. Both are committed and human-reviewable.
    expect(foodHabitRationale("fatty_fish")).toBe(
      "a source of Omega-3 and Vitamin D"
    );
    expect(foodHabitRationale("leafy_greens")).toBe(
      "a source of Folate and Potassium"
    );
  });

  it("drops the label's lab-panel parenthetical", () => {
    // "Omega-3 (EPA/DHA)" is precision a panel needs and a sentence does not — and a
    // parenthetical nested inside another annotation is exactly what #2391's grammar
    // exists to prevent.
    expect(foodHabitRationale("fatty_fish")).not.toContain("(");
  });

  it("names at most two nutrients — a reason, not a cereal box", () => {
    // Legumes carry four; the sentence takes the first two.
    const rationale = foodHabitRationale("legumes")!;
    expect(rationale.split(" and ").length).toBeLessThanOrEqual(
      FOOD_HABIT_MAX_NUTRIENTS
    );
  });

  it("answers null for a group the catalog links to no tracked nutrient", () => {
    // Water, sweets, and alcohol (which has no nutrient entry at all). A bare frequency
    // count with no rationale is the half of #2397 that was never the point.
    for (const slug of ["water", "added_sugar", "alcohol", "not_a_group"])
      expect(foodHabitRationale(slug), slug).toBeNull();
  });
});

describe("the observation and its sentence (#2397)", () => {
  it("reports a share of the LOGGED days, with the denominator named", () => {
    const observations = foodHabitObservations(
      period([
        ...dayEvents("oats", EVERY_DAY),
        ...dayEvents("fatty_fish", [0, 2, 4, 6]),
      ])
    );
    const fish = observations.find((o) => o.groupKey === "fatty_fish")!;
    expect(fish).toMatchObject({
      label: "Fatty fish",
      days: 4,
      observedDays: 10,
    });
    expect(foodHabitSentence(fish)).toBe(
      "Fatty fish 4 of 10 logged days, a source of Omega-3 and Vitamin D"
    );
  });

  it("says LOGGED days, so the line cannot congratulate record-keeping as eating", () => {
    // #1955's caveat, restated by #2397. Someone who eats fish without logging it is not
    // ranked below someone who logs everything: the days they logged nothing are not in
    // the denominator either.
    const observations = foodHabitObservations(
      period([...dayEvents("fatty_fish", EVERY_DAY)])
    );
    expect(foodHabitSentence(observations[0])).toContain("logged days");
  });

  it("never reports a run, in the type or in the words", () => {
    const observations = foodHabitObservations(
      period([
        // Consecutive by construction — and reported as a count all the same.
        ...dayEvents("fatty_fish", EVERY_DAY),
      ])
    );
    const sentence = foodHabitSentence(observations[0]);
    expect(sentence).not.toMatch(/in a row|straight|streak|consecutive|day \d+/i);
    expect(Object.keys(observations[0]).sort()).toEqual([
      "days",
      "groupKey",
      "label",
      "observedDays",
      "rationale",
    ]);
  });

  it("names at most three groups, share-descending", () => {
    const observations = foodHabitObservations(
      period([
        ...dayEvents("oats", EVERY_DAY),
        ...dayEvents("leafy_greens", [0, 1, 2, 3, 4, 5, 6, 7, 8]),
        ...dayEvents("legumes", [0, 1, 2, 3, 4, 5, 6, 7]),
        ...dayEvents("fatty_fish", [0, 1, 2, 3, 4, 5, 6]),
        ...dayEvents("eggs", [0, 1, 2, 3, 4, 5]),
      ])
    );
    expect(observations).toHaveLength(FOOD_HABIT_MAX_NAMED);
    // `oats` has no curated nutrient link, so the leading SHARE is not automatically the
    // leading sentence — a group with no rationale is not stated at all.
    expect(observations.map((o) => o.groupKey)).toEqual([
      "leafy_greens",
      "legumes",
      "fatty_fish",
    ]);
  });

  it("states nothing for a period under the measure's gate", () => {
    expect(foodHabitObservations(period(dayEvents("fatty_fish", [0, 1])))).toEqual(
      []
    );
    expect(foodHabitObservations(null)).toEqual([]);
  });

  it("never states a cap-direction group, whatever its share", () => {
    // The exclusion is the caller's fact about the profile's targets and its substance
    // catalog (#2380), and it is applied before anything is worded.
    const observations = foodHabitObservations(
      period([
        ...dayEvents("fatty_fish", EVERY_DAY),
        ...dayEvents("alcohol", EVERY_DAY),
      ]),
      { excluded: new Set(["alcohol"]) }
    );
    expect(observations.map((o) => o.groupKey)).toEqual(["fatty_fish"]);
  });
});

// ── THE RULE THIS MODULE EXISTS TO KEEP ─────────────────────────────────────────
//
// #2397 forbids the app observing YOUR pattern, observing YOUR result, and implying the
// first explains the second. The curated map that supplies the rationale ALSO carries,
// on the very same entry, the biomarker families that nutrient is read from — so the
// forbidden sentence is one property access away, and a reviewer's memory is the only
// thing that would stop it. These pins are what replaces that memory.

describe("a pattern is never joined to a biomarker (#2397)", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "lib/food-habit-observation.ts"),
    "utf8"
  );
  // Comments discuss the rule at length; only CODE is under test.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("reads the map's nutrient label and never its biomarker families", () => {
    expect(code).not.toMatch(/\bbiomarkers?\b/i);
  });

  it("imports nothing that could supply a reading, a flag or a range", () => {
    const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual([
      "./datasets/nutrient-food-map",
      "./food-groups",
      "./food-regularity",
    ]);
  });

  it("has no field an observation could carry a result in", () => {
    // The structural half: a renderer downstream cannot pair a pattern with a result by
    // choosing to, because the observation it is handed has nowhere to put one.
    const observations = foodHabitObservations(
      period(dayEvents("fatty_fish", EVERY_DAY))
    );
    const keys = Object.keys(observations[0]);
    for (const forbidden of ["biomarker", "flag", "result", "value", "reading"])
      expect(keys.some((k) => k.toLowerCase().includes(forbidden))).toBe(false);
  });
});
