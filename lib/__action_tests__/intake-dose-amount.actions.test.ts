// SERVER-ACTION TIER — the DOSE amount write boundary (issue #3153).
//
// The sibling of intake-ingredients.actions.test.ts, which covers the same question
// for an ingredient row. The dose amount is the number the upper-limit warnings are
// computed from, and it used to be read by a pattern that could not span a thousands
// separator: "1,000 mg" matched the "000" and became a confident, schema-valid ZERO.
// Nothing threw, nothing was flagged, and a niacin dose 28x over the adult limit
// contributed nothing to the surface that exists to catch it.
//
// These assert END TO END — through the action to the stored row and on to
// getDietaryLimitWarnings — because the parser returning the right number is not the
// claim. The claim is that the warning fires.
//
// SYNTHETIC ONLY: invented products, ordinary label amounts, no PHI.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  addIntakeItem,
  updateIntakeItem,
} from "@/app/(app)/nutrition/intake-actions";
import { getIntakeItems, getDietaryLimitWarnings } from "@/lib/queries";
import { setStoredAge } from "@/lib/settings";
import { seedActor, fd } from "./harness";

const doses = (amounts: string[]): string =>
  JSON.stringify(amounts.map((amount) => ({ amount, food_timing: "any" })));

const storedAmounts = (itemId: number): string[] =>
  db
    .prepare(
      "SELECT amount FROM intake_item_doses WHERE item_id = ? ORDER BY sort"
    )
    .all(itemId)
    .map((r: any) => r.amount);

describe("a dose amount that reads unambiguously", () => {
  it("counts a thousands-separated dose toward the upper limit", () => {
    const { profile } = seedActor();
    setStoredAge(profile.id, 40);
    return addIntakeItem(
      fd({
        name: "Niacin",
        condition: "daily",
        doses: doses(["1,000 mg"]),
      })
    ).then(() => {
      // The label text is stored verbatim — the reading is derived, never a rewrite
      // of what the person typed.
      const [item] = getIntakeItems(profile.id);
      expect(storedAmounts(item.id)).toEqual(["1,000 mg"]);
      // And the warning fires. This is the whole issue: before, it did not.
      const [warning] = getDietaryLimitWarnings(profile.id);
      expect(warning.key).toBe("niacin");
      expect(warning.total).toBeCloseTo(1000, 5);
    });
  });

  it("still accepts an amount that states no quantity at all", async () => {
    // The refusal must not swallow the ordinary non-quantitative dose. "1 capsule"
    // has always been legitimate and carries no number to misread.
    const { profile } = seedActor();
    const result = await addIntakeItem(
      fd({
        name: "Eye Health+",
        condition: "daily",
        doses: doses(["1 capsule"]),
      })
    );
    expect(result.ok).toBe(true);
    expect(getIntakeItems(profile.id)).toHaveLength(1);
  });
});

describe("a dose amount that does not read unambiguously", () => {
  it("refuses the save and stores nothing", async () => {
    // "2,5 g" is 2.5 in Berlin and 25 in Boston, and the dose row has no
    // `amount_text` beside its reading to fall back on — so storing ANY number here,
    // or a silent null, is unrecoverable. The person is told which string to fix.
    const { profile } = seedActor();
    const result = await addIntakeItem(
      fd({
        name: "Magnesium Glycinate",
        condition: "daily",
        doses: doses(["2,5 g"]),
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("2,5 g");
    // Nothing was written — not the item, not the dose.
    expect(getIntakeItems(profile.id)).toEqual([]);
  });

  it("refuses an EDIT too, leaving the stored dose untouched", async () => {
    // Both write sites share the check. An edit that fails must not half-apply.
    const { profile } = seedActor();
    await addIntakeItem(
      fd({ name: "Vitamin D3", condition: "daily", doses: doses(["5,000 IU"]) })
    );
    const [item] = getIntakeItems(profile.id);
    const result = await updateIntakeItem(
      fd({
        id: String(item.id),
        name: "Vitamin D3",
        condition: "daily",
        doses: doses(["10.000 IU"]),
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("10.000 IU");
    expect(storedAmounts(item.id)).toEqual(["5,000 IU"]);
  });

  it("refuses when only ONE row of several cannot be read", async () => {
    const { profile } = seedActor();
    const result = await addIntakeItem(
      fd({
        name: "Magnesium Glycinate",
        condition: "daily",
        doses: doses(["200 mg", "2.500 mg"]),
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("2.500 mg");
    expect(getIntakeItems(profile.id)).toEqual([]);
  });
});
