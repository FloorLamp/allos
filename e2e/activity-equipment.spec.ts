import { test, expect } from "@playwright/test";

// Issue #342: the ACTIVITY-level equipment link. The seed links its "Zone 2 bike"
// ride to a "Road Bike" (category Bike), so the Journal renders a session-level gear
// chip and opening the editor preloads the reusable activity-equipment picker with
// that gear — proving the link renders and round-trips on the real page.
test("a cardio session shows its gear chip and preloads the equipment picker (#342)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  const card = page
    .locator('[id^="activity-"]')
    .filter({ hasText: "Zone 2 bike" });
  await expect(card.first()).toBeVisible();

  // The session-level gear chip carries the linked equipment name.
  const gear = card.first().getByTestId("activity-gear");
  await expect(gear).toBeVisible();
  await expect(gear).toContainText("Road Bike");

  // Opening the editor (via the card title) preloads the activity-level picker with
  // the linked gear — a real equipment id is selected, labelled "Road Bike".
  await card.first().getByRole("button", { name: "Zone 2 bike" }).click();
  const select = page.getByTestId("activity-equipment-select");
  await expect(select).toBeVisible();
  await expect(select).toHaveValue(/\d+/);
  await expect(select.locator("option:checked")).toHaveText("Road Bike");
});
