import { test, expect } from "./fixtures";
import { hydratedClick } from "./helpers";

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
  // hydratedClick, not click: the due row's disclosure is a CONTROLLED React button
  // (app/(app)/nutrition/DayLedger.tsx renders `<button type="button" onClick>` with
  // `aria-expanded`), so a tap that lands before the handler is live — or on a node the
  // #4815 re-render has replaced but not yet re-owned — is lost with no error and no
  // native fallback, and the assertion below then reports the gating as broken. Not the
  // `food-more-groups` case #4339 cleared: that one is an uncontrolled `<details>`.
  await hydratedClick(
    page,
    evening.locator('[data-testid^="ledger-due-group-"]')
  );
  await expect(evening).toContainText("Zinc");
});
