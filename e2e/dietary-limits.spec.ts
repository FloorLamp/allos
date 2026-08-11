import { test, expect } from "./fixtures";
// IntakeItem stack-total UL warning (issue #148). The seed gives profile 1 a
// two-product magnesium stack — Magnesium Glycinate 400 mg + Magnesium Citrate
// 200 mg = 600 mg elemental/day — which exceeds the 350 mg supplemental Tolerable
// Upper Intake Level. The Supplements tab must surface an informational warning row that
// sums the stack and names the UL. Read-only against seeded data (nothing to
// clean up); assertions are scoped to the page's main region.
//
// The 600 is PINNED, not incidental (#1505). Magnesium Citrate carries the `may`
// obligation, and the conservative-direction rule says obligation may never SHRINK a
// risk number: `may` is a statement about pushing, not about pharmacology, so its
// 200 mg still counts at full weight here and the total stays 600. What `may` earns is
// a LABEL on the line, not an exclusion from it — if this ever reads 400 mg, the UL
// math has started letting a user preference hide a chronic exposure.

test("shows a stack-total UL warning for an over-UL magnesium stack", async ({
  page,
}) => {
  await page.goto("/nutrition?tab=supplements");
  const main = page.getByRole("main");

  const warning = main.getByTestId("ul-warning-magnesium");
  await expect(warning).toBeVisible();
  // The summed total (600 mg), the UL (350 mg), and the informational framing.
  await expect(warning).toContainText("Magnesium above the upper limit");
  await expect(warning).toContainText("600 mg");
  await expect(warning).toContainText("350 mg");
  await expect(warning).toContainText("with your clinician");
  // The on-demand member is disclosed rather than dropped: the line says out loud
  // that an as-needed item is inside the 600.
  await expect(warning).toContainText(/including as-needed items/i);
  // Names both contributing products (the stack-total, not a single item).
  await expect(warning).toContainText("Magnesium Glycinate");
  await expect(warning).toContainText("Magnesium Citrate");
});
