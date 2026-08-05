import { describe, it, expect } from "vitest";
import { FOOD_DRUG_INTERACTIONS } from "@/lib/datasets/food-drug-interactions";
import { FOOD_GROUP_INTERACTION_KEYS } from "@/lib/food-habit";
import { isValidFoodGroup } from "@/lib/food-groups";

// The COMPLETENESS gate for the food-log ↔ food–drug catalog mapping (issue #2021).
//
// The rule the issue fixes is not "wire alcohol up": it is that every entry must DECIDE
// whether the 24-group food catalog can honestly express its food, and record that
// decision in the committed dataset. Roughly a third of the entries name foods the catalog
// cannot express — grapefruit collapses into the broad `fruit` group, tyramine hides
// inside `fermented`, potassium is not a group at all, and the dairy rules are separation
// WINDOWS that need an eating time the day-granular log does not carry — and those are
// excluded WITH A WRITTEN REASON rather than approximated. The generator refuses an entry
// that decides neither way; this test is the dataset-side half of the same gate.

describe("every food–drug entry declares a catalog mapping (#2021)", () => {
  it("is mapped with a firing rule, or excluded with a written reason", () => {
    for (const e of FOOD_DRUG_INTERACTIONS) {
      const c = e.catalog;
      expect(c, `${e.key} has no catalog mapping`).toBeDefined();
      if (c.rule === "none") {
        expect(
          (c.reason ?? "").trim().length,
          `${e.key} is excluded from the ledger findings but states no reason`
        ).toBeGreaterThan(20);
      } else {
        expect(
          c.groups.length,
          `${e.key} declares a ${c.rule} rule with no groups`
        ).toBeGreaterThan(0);
        expect(
          c.reason,
          `${e.key} has both a rule and an exclusion`
        ).toBeUndefined();
      }
    }
  });

  it("every mapped group is a real catalog group", () => {
    for (const e of FOOD_DRUG_INTERACTIONS) {
      for (const slug of e.catalog.groups) {
        expect(isValidFoodGroup(slug), `${e.key}: unknown group ${slug}`).toBe(
          true
        );
      }
    }
  });

  it("a tail is per-entry and event-only — never a hard-coded default", () => {
    for (const e of FOOD_DRUG_INTERACTIONS) {
      if (e.catalog.tailDays == null) continue;
      expect(e.catalog.rule, `${e.key} declares tailDays`).toBe("event");
      expect(Number.isInteger(e.catalog.tailDays)).toBe(true);
    }
    // The metronidazole label's own "and for 3 days after" — encoded, not assumed.
    const metro = FOOD_DRUG_INTERACTIONS.find(
      (e) => e.key === "alcohol-metronidazole"
    );
    expect(metro?.catalog).toMatchObject({
      groups: ["alcohol"],
      rule: "event",
      tailDays: 3,
    });
    // Its sibling alcohol rules state no tail, so they get none.
    expect(
      FOOD_DRUG_INTERACTIONS.find((e) => e.key === "alcohol-warfarin")?.catalog
        .tailDays
    ).toBeUndefined();
  });

  it("the honest mappings are exactly alcohol (event) and vitamin K (variance)", () => {
    const firing = FOOD_DRUG_INTERACTIONS.filter(
      (e) => e.catalog.rule !== "none"
    ).map((e) => [e.key, e.catalog.rule]);
    expect(firing).toEqual([
      ["vitamin-k-warfarin", "variance"],
      ["alcohol-warfarin", "event"],
      ["alcohol-metronidazole", "event"],
      ["alcohol-acetaminophen", "event"],
    ]);
  });

  it("the granularity gap is EXCLUDED, never approximated", () => {
    const excluded = (key: string) =>
      FOOD_DRUG_INTERACTIONS.find((e) => e.key === key)!.catalog;
    // Grapefruit would have to fire on every apple.
    for (const key of [
      "grapefruit-statin",
      "grapefruit-ccb",
      "grapefruit-immunosuppressant",
    ]) {
      expect(excluded(key).rule).toBe("none");
      expect(excluded(key).groups).toEqual([]);
      expect(excluded(key).reason).toMatch(/fruit/i);
    }
    // Tyramine is only partially reachable and its false-positive cost is a
    // hypertensive-crisis warning, so it stays out until the log can name the food.
    expect(excluded("tyramine-maoi").rule).toBe("none");
    // The dairy rules ARE mapped to a real group and still cannot fire: they are
    // separation windows, which need the eating time #2019 adds.
    for (const key of [
      "dairy-levothyroxine",
      "dairy-tetracycline",
      "dairy-fluoroquinolone",
    ]) {
      expect(excluded(key).groups).toEqual(["dairy"]);
      expect(excluded(key).rule).toBe("none");
      expect(excluded(key).reason).toMatch(/separation window/i);
    }
    // Potassium and "anything but water" have no expressible group at all.
    for (const key of [
      "potassium-ace-arb",
      "potassium-diuretic",
      "food-bisphosphonate",
    ]) {
      expect(excluded(key).rule).toBe("none");
      expect(excluded(key).groups).toEqual([]);
    }
  });

  it("a partial mapping that DID participate would have to state its coverage", () => {
    // The one mapping whose group is not the whole food: leafy greens carry vitamin K,
    // and so do cruciferous vegetables, which are logged under their own group. The
    // finding says so rather than implying it counted every source.
    const vitK = FOOD_DRUG_INTERACTIONS.find(
      (e) => e.key === "vitamin-k-warfarin"
    )!;
    expect(vitK.catalog.coverageNote).toMatch(/cruciferous/i);
  });

  it("the #661 habit screen is DERIVED from the same declarations", () => {
    // One source of truth: the static habit-vs-stack screen reads the entries' own
    // `catalog.groups` instead of a second hand-kept map that could drift from it.
    expect(FOOD_GROUP_INTERACTION_KEYS).toEqual({
      leafy_greens: ["vitamin-k-warfarin"],
      alcohol: [
        "alcohol-warfarin",
        "alcohol-metronidazole",
        "alcohol-acetaminophen",
      ],
      dairy: [
        "dairy-levothyroxine",
        "dairy-tetracycline",
        "dairy-fluoroquinolone",
      ],
    });
  });
});
