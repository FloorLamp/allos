import { test, expect } from "./fixtures";
// RDA-adequacy view (issue #578). The seeded stack (scripts/seed.ts) includes Calcium
// 500 mg/day — below the ~1000 mg adult RDA — so the Supplements tab must render an adequacy row
// stating the SHARE the supplements provide, with the load-bearing framing "supplements
// alone provide X% of the RDA" and never "deficient" (food intake is unknown). Uses the
// shared authenticated storageState.
//
// Value->presence (one-question-one-computation): the RDA reference values — and thus
// the computed "% of the RDA" share — are pinned by lib/__tests__/dri.test.ts. This
// spec asserts the % framing + the load-bearing safety wording (never "deficient",
// "not medical advice"), never the exact computed percentage.
//
// Obligation cuts the OPPOSITE way here from the UL check (#1505), which is why both
// specs exist side by side. Adequacy is a REASSURANCE number, so obligation may never
// INFLATE it: the seeded Calcium is `may`, so its 500 mg is excluded from the share
// itself and reported as a labelled aside instead. The row must still APPEAR — a
// nutrient the user supplements must never go silent just because they asked not to be
// nudged about it — so this spec pins presence plus the disclosure, and the dietary-limit
// spec pins full-weight inclusion. Same obligation, opposite direction, both cautious.

test("Supplements tab shows the RDA-adequacy share for an under-RDA stack nutrient (#578)", async ({
  page,
}) => {
  await page.goto("/nutrition?tab=supplements");

  const section = page.getByTestId("rda-adequacy");
  await expect(section).toBeVisible();

  const calcium = page.getByTestId("rda-adequacy-calcium");
  await expect(calcium).toBeVisible();
  await expect(calcium).toContainText("% of the RDA");
  await expect(calcium).toContainText(/supplements alone provide/i);
  // The on-demand aside: named, and explicitly outside the share.
  await expect(calcium).toContainText(/as-needed items/i);
  await expect(calcium).toContainText(/aren.t counted toward this share/i);
  // The load-bearing wording contract: never implies a deficiency.
  await expect(calcium).not.toContainText(/deficient|deficiency/i);
  await expect(calcium).not.toContainText(/not medical advice/i);
});
