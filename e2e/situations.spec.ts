import { test, expect } from "./fixtures";

// Situation state still gates the schedule, but its controls live on the dashboard
// check-in/context surfaces rather than inside Nutrition → Supplements.
test("an active situation gates its supplement without rendering situation controls", async ({
  page,
}) => {
  await page.goto("/nutrition?tab=supplements");

  await expect(page.getByTestId("situations-bar")).toHaveCount(0);

  // The seed keeps Illness active, so its situational Zinc dose remains due even
  // though this page no longer owns the situation vocabulary controls.
  const zincDue = page
    .locator("section")
    .filter({ hasText: "Evening" })
    .locator("div.card")
    .filter({ hasText: "Zinc" });
  await expect(zincDue).toHaveCount(1);
});
