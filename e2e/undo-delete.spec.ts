import { test, expect } from "@playwright/test";

// Issue #30: deleting a row keeps it in a short-lived holding table and offers an
// Undo toast. This drives the required end-to-end path — delete an activity in the
// UI, then Undo, and prove the row comes back — against the seeded DB. It exercises
// the whole chain: captureDelete (activity + its exercise_sets) → deleted_rows →
// restoreDeletedRow, plus the toast affordance and the RSC refresh.
test("delete an activity, then Undo restores it (#30)", async ({ page }) => {
  await page.goto("/training"); // default "Log" tab lists activities as cards

  const cards = page.locator('[id^="activity-"]');
  await expect(cards.first()).toBeVisible();
  const before = await cards.count();
  expect(before).toBeGreaterThan(0);

  // Target the first (most recent) activity card; remember its id so we can prove
  // that specific row disappears (restore re-inserts under a NEW id).
  const first = cards.first();
  const firstId = await first.getAttribute("id");
  expect(firstId).toBeTruthy();

  // Open the editor overlay from the card's title button, then Delete.
  await first.getByRole("button").first().click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  // Confirm in the type-safe confirm dialog.
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();

  // The specific card is gone and the total dropped by one.
  await expect(page.locator(`#${firstId}`)).toHaveCount(0);
  await expect(cards).toHaveCount(before - 1);

  // The Undo toast appears; click it.
  await expect(page.getByText("Activity deleted.")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();

  // Restored: a "Restored." toast and the activity count is back to the original.
  await expect(page.getByText("Restored.")).toBeVisible();
  await expect(cards).toHaveCount(before);
});
