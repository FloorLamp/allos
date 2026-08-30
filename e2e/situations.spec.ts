import { test, expect } from "./fixtures";

// Situation state still gates the schedule, but its controls live on the dashboard
// check-in/context surfaces rather than inside Nutrition → Supplements.
test("an active situation gates its supplement without rendering situation controls", async ({
  page,
}) => {
  await page.goto("/nutrition?tab=supplements");

  await expect(page.getByTestId("situations-bar")).toHaveCount(0);

  // The item is in the stack, because a situational item is one you keep.
  await expect(
    page
      .getByTestId("supplement-stack")
      .getByTestId("supplement-row")
      .filter({ hasText: "Zinc" })
  ).toHaveCount(1);

  // AND ITS DUENESS IS STATED WHERE THE DAY IS (#3987). The seed keeps Illness
  // active, so the situational Zinc dose is still OWED — which this page used to say
  // by placing the row under an "Evening" heading and no longer says at all. The Day
  // ledger's Evening due row is where that claim lives now; the gating is the point
  // of this test, so it is asserted there rather than dropped with the heading.
  await page.goto("/nutrition?tab=food");
  const evening = page.getByTestId("ledger-group-evening");
  await evening.locator('[data-testid^="ledger-due-group-"]').click();
  await expect(evening).toContainText("Zinc");
});
