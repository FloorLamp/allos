import { test, expect } from "@playwright/test";

// Issue #100: conflict-aware merge preview. The e2e seed (e2e/seed-events) plants two
// same-day MANUAL cardio rows on 2026-07-06 that genuinely DISAGREE on duration
// ("Conflict merge keeper" 42 min vs "Conflict merge dupe" 51 min) but agree on
// distance. Merging them must raise the per-field conflict preview (not a silent
// one-click fold); this drives the required flow: open the preview, override the one
// conflicting field to the DISCARDED row's value, confirm, and prove the merged
// keeper carries the override (51 min).
test("merge preview lets you override a conflicting field to the discarded value (#100)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  const keeperCard = page
    .locator('[id^="activity-"]')
    .filter({ hasText: "Conflict merge keeper" });
  await expect(keeperCard).toHaveCount(1);
  // Before the merge the keeper shows its own 42 min, and both rows are present.
  await expect(keeperCard.getByText("42 min")).toBeVisible();
  await expect(page.getByText("Conflict merge dupe")).toBeVisible();

  // Open the keeper card's overflow (⋯) menu → "Merge with…" → pick the dupe.
  await keeperCard.getByRole("button", { name: "Activity actions" }).click();
  await page.getByTestId("merge-with").click();
  await page
    .getByTestId("merge-target")
    .filter({ hasText: "Conflict merge dupe" })
    .click();

  // Because the two rows disagree on duration, the conflict preview opens instead of
  // an immediate merge. It lists exactly the duration conflict as two options.
  const dialog = page.getByTestId("merge-conflict-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("conflict-duration_min")).toBeVisible();
  await expect(dialog.getByTestId("conflict-duration_min-keep")).toContainText(
    "42 min"
  );
  await expect(dialog.getByTestId("conflict-duration_min-drop")).toContainText(
    "51 min"
  );

  // Override: take the DISCARDED row's duration (51 min), then confirm the merge.
  await dialog.getByTestId("conflict-duration_min-drop").click();
  await dialog.getByTestId("merge-conflict-confirm").click();

  // The discarded row is merged away; the keeper survives.
  await expect(page.getByText("Conflict merge dupe")).toHaveCount(0);

  // Reload for a deterministic server render: the merged keeper now carries the
  // overridden duration (51 min), proving the override reached the DB — not the
  // keeper's original 42 min.
  await page.reload();
  const merged = page
    .locator('[id^="activity-"]')
    .filter({ hasText: "Conflict merge keeper" });
  await expect(merged.getByText("51 min")).toBeVisible();
  await expect(merged.getByText("42 min")).toHaveCount(0);
});
