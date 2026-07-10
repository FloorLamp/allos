import { test, expect } from "@playwright/test";

// Issues #199/#200: merging must never destroy the discarded row's logged sets — they
// are re-parented onto the keeper — and the conflict preview surfaces how many sets
// are moving. The e2e seed (e2e/seed-events) plants two same-day MANUAL strength rows
// on 2026-07-04 that conflict on duration (30 vs 45 min): "Set merge keeper" (one set:
// Bench Press) and "Set merge dupe" (two sets: Back Squat, Deadlift). This drives the
// flow: open the merge, confirm the dialog shows the "2 logged sets" line, merge, and
// prove all three sets end up on the keeper (nothing lost to the FK cascade).
test("merging re-parents the discarded row's sets onto the keeper, shown in the preview (#199)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  const keeperCard = page
    .locator('[id^="activity-"]')
    .filter({ hasText: "Set merge keeper" });
  await expect(keeperCard).toHaveCount(1);
  await expect(page.getByText("Set merge dupe")).toBeVisible();
  // Before the merge the keeper shows only its own exercise.
  await expect(keeperCard.getByText("Bench Press")).toBeVisible();

  // Open the keeper card's overflow (⋯) menu → "Merge with…" → pick the dupe.
  await keeperCard.getByRole("button", { name: "Activity actions" }).click();
  await page.getByTestId("merge-with").click();
  await page
    .getByTestId("merge-target")
    .filter({ hasText: "Set merge dupe" })
    .click();

  // Because the durations disagree, the conflict preview opens — and it now spells
  // out how many logged sets will move onto the keeper (#199).
  const dialog = page.getByTestId("merge-conflict-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("merge-set-count")).toContainText(
    "2 logged sets"
  );

  // Confirm the merge (keeper-wins on the duration conflict — no override).
  await dialog.getByTestId("merge-conflict-confirm").click();

  // The discarded row is merged away; the keeper survives.
  await expect(page.getByText("Set merge dupe")).toHaveCount(0);

  // Reload for a deterministic server render: the keeper now carries ALL three sets —
  // its own plus the two re-parented from the discarded row (none lost).
  await page.reload();
  const merged = page
    .locator('[id^="activity-"]')
    .filter({ hasText: "Set merge keeper" });
  await expect(merged.getByText("Bench Press")).toBeVisible();
  await expect(merged.getByText("Back Squat")).toBeVisible();
  await expect(merged.getByText("Deadlift")).toBeVisible();
});
