// SERVER-ACTION TIER — label composition of an intake item (issue #2856).
//
// The repeater's rows only mean anything if they survive the round trip and reach the
// engines. This tier covers the write boundary (what the form posts becomes stored
// rows, canonicalized once, never fabricated), the replace-on-save reconcile, the
// cascade, profile scoping, and the two consumer claims the issue names: a blend's
// zinc stacking against a standalone zinc, and a blend carrying St. John's Wort
// meeting an SSRI.
//
// SYNTHETIC ONLY: invented products, ordinary supplement-facts amounts, no PHI.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  addIntakeItem,
  updateIntakeItem,
  deleteIntakeItem,
} from "@/app/(app)/nutrition/intake-actions";
import {
  getIntakeItems,
  getIntakeIngredients,
  getIntakeIngredientsByItem,
  getDietaryLimitWarnings,
  getInteractionWarnings,
} from "@/lib/queries";
import { setStoredAge } from "@/lib/settings";
import { seedActor, createProfile, fd } from "./harness";

// The form posts the repeater as JSON: the label's own words, nothing canonical.
function ingredientsField(rows: { name: string; amount?: string }[]): string {
  return JSON.stringify(
    rows.map((r) => ({ name: r.name, amount: r.amount ?? "" }))
  );
}

describe("the write boundary", () => {
  it("stores the label text and the canonical reading beside it", async () => {
    const { profile } = seedActor();
    await addIntakeItem(
      fd({
        name: "Eye Health+",
        condition: "daily",
        doses: JSON.stringify([{ amount: "1 cap", food_timing: "any" }]),
        ingredients: ingredientsField([
          { name: "Lutein", amount: "10 mg" },
          { name: "Vitamin E", amount: "200 IU" },
          { name: "Astaxanthin", amount: "2 g" },
          { name: "Marigold extract" },
        ]),
      })
    );
    const rows = getIntakeIngredients(profile.id);
    expect(rows.map((r) => [r.name, r.amount_text, r.amount, r.unit])).toEqual([
      ["Lutein", "10 mg", 10, "mg"],
      ["Vitamin E", "200 IU", 200, "iu"],
      // Grams fold to milligrams at the boundary; the label text is untouched.
      ["Astaxanthin", "2 g", 2000, "mg"],
      // A named ingredient with no amount is kept — it still names a substance.
      ["Marigold extract", null, null, null],
    ]);
  });

  it("writes nothing when the form posts no ingredients", async () => {
    const { profile } = seedActor();
    await addIntakeItem(fd({ name: "Zinc", condition: "daily" }));
    expect(getIntakeIngredients(profile.id)).toEqual([]);
  });

  it("replaces the whole set on save, in the order the label was entered", async () => {
    const { profile } = seedActor();
    await addIntakeItem(
      fd({
        name: "Mood Support",
        condition: "daily",
        ingredients: ingredientsField([{ name: "Zinc", amount: "5 mg" }]),
      })
    );
    const id = getIntakeItems(profile.id)[0].id;
    await updateIntakeItem(
      fd({
        id: String(id),
        name: "Mood Support",
        condition: "daily",
        ingredients: ingredientsField([
          { name: "Saffron", amount: "28 mg" },
          { name: "Zinc", amount: "11 mg" },
        ]),
      })
    );
    const rows = getIntakeIngredients(profile.id);
    expect(rows.map((r) => r.name)).toEqual(["Saffron", "Zinc"]);
    expect(rows.map((r) => r.sort)).toEqual([0, 1]);
    expect(rows[1].amount).toBe(11);
  });

  it("clears the rows when the person empties the repeater", async () => {
    const { profile } = seedActor();
    await addIntakeItem(
      fd({
        name: "Mood Support",
        condition: "daily",
        ingredients: ingredientsField([{ name: "Zinc", amount: "5 mg" }]),
      })
    );
    const id = getIntakeItems(profile.id)[0].id;
    await updateIntakeItem(
      fd({
        id: String(id),
        name: "Mood Support",
        condition: "daily",
        ingredients: "[]",
      })
    );
    expect(getIntakeIngredients(profile.id)).toEqual([]);
  });

  it("drops the rows when the item is deleted", async () => {
    const { profile } = seedActor();
    await addIntakeItem(
      fd({
        name: "Mood Support",
        condition: "daily",
        ingredients: ingredientsField([{ name: "Zinc", amount: "5 mg" }]),
      })
    );
    const id = getIntakeItems(profile.id)[0].id;
    await deleteIntakeItem(fd({ id: String(id) }));
    expect(getIntakeIngredients(profile.id)).toEqual([]);
    // And gone from the table, not merely unreachable through the parent JOIN — the
    // cascade is what keeps composition from outliving the item it describes.
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM intake_item_ingredients WHERE item_id = ?"
        )
        .get(id)
    ).toEqual({ n: 0 });
  });

  it("reads only this profile's composition", async () => {
    const { profile } = seedActor();
    const other = createProfile("Second person");
    await addIntakeItem(
      fd({
        name: "Mood Support",
        condition: "daily",
        ingredients: ingredientsField([{ name: "Zinc", amount: "5 mg" }]),
      })
    );
    expect(getIntakeIngredients(profile.id)).toHaveLength(1);
    expect(getIntakeIngredients(other.id)).toEqual([]);
    expect([...getIntakeIngredientsByItem(other.id).keys()]).toEqual([]);
  });
});

describe("what the engines now see", () => {
  it("stacks a blend's zinc against a standalone zinc, over the upper limit", async () => {
    const { profile } = seedActor();
    setStoredAge(profile.id, 40);

    // Standalone zinc alone is under the 40 mg adult UL and says nothing.
    await addIntakeItem(
      fd({
        name: "Zinc",
        condition: "daily",
        doses: JSON.stringify([{ amount: "30 mg", food_timing: "any" }]),
      })
    );
    expect(getDietaryLimitWarnings(profile.id)).toEqual([]);

    // The blend's name mentions no mineral; only its label does.
    await addIntakeItem(
      fd({
        name: "Eye Health+",
        condition: "daily",
        doses: JSON.stringify([{ amount: "1 cap", food_timing: "any" }]),
        ingredients: ingredientsField([
          { name: "Lutein", amount: "10 mg" },
          { name: "Zinc", amount: "11 mg" },
          { name: "Copper", amount: "2 mg" },
        ]),
      })
    );
    const [warning] = getDietaryLimitWarnings(profile.id);
    expect(warning.key).toBe("zinc");
    expect(warning.total).toBeCloseTo(41, 5);
    expect(warning.contributors.map((c) => c.name).sort()).toEqual([
      "Eye Health+",
      "Zinc",
    ]);
  });

  it("catches St. John's Wort inside a blend against an SSRI", async () => {
    const { profile } = seedActor();
    await addIntakeItem(
      fd({ name: "Sertraline", kind: "medication", started_on: "2025-02-03" })
    );
    // Without composition the pair is silent — that is the defect this closes.
    await addIntakeItem(fd({ name: "Mood Support", condition: "daily" }));
    expect(getInteractionWarnings(profile.id)).toEqual([]);

    const blendId = getIntakeItems(profile.id).find(
      (i) => i.name === "Mood Support"
    )!.id;
    await updateIntakeItem(
      fd({
        id: String(blendId),
        name: "Mood Support",
        condition: "daily",
        ingredients: ingredientsField([
          { name: "St. John's Wort", amount: "300 mg" },
          { name: "Saffron", amount: "28 mg" },
        ]),
      })
    );
    const hits = getInteractionWarnings(profile.id);
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("major");
  });
});
