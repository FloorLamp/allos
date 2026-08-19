import { test, expect } from "./fixtures";
import { followLink } from "./helpers";
// Issue #64, Part 2: the Training Log's manual pair-merge. The e2e seed (e2e/seed-events)
// plants two same-day MANUAL activities with non-overlapping clock windows — "Training
// Log merge keeper" and "Training Log merge dupe". This drives the required manual
// repair path that duplicate detection intentionally leaves alone: open the keeper's
// canonical record, use its overflow menu, pick the sibling to absorb, and prove
// the discarded row is folded away, plus the Undo toast restores it.
test("merge two same-day activities from the Training Log, then Undo (#64)", async ({
  page,
}) => {
  await page.goto("/training?tab=log"); // default "Log" tab renders the Training Log feed

  // The row owns the #activity-N anchor now; it is the keeper's feed presence.
  const keeperRow = page
    .locator('[id^="activity-"]')
    .filter({ hasText: "Training Log merge keeper" });
  await expect(keeperRow).toHaveCount(1);
  // Both same-day rows are present before the merge.
  await expect(page.getByText("Training Log merge dupe")).toBeVisible();

  // Open the keeper, then use the record's overflow (⋯) menu → "Merge with…"
  // → pick the dupe.
  await followLink(
    page,
    keeperRow.getByRole("link", {
      name: "Training Log merge keeper",
      exact: true,
    }),
    /\/training\/activity\/\d+$/
  );
  const keeperCard = page.getByTestId("training-activity-page");
  await expect(keeperCard).toBeVisible();
  await keeperCard.getByRole("button", { name: "Activity actions" }).click();
  await page.getByTestId("merge-with").click();
  await page
    .getByTestId("merge-target")
    .filter({ hasText: "Training Log merge dupe" })
    .click();
  // Non-overlapping clock windows disagree by definition, so keep the keeper's
  // values in the conflict preview and complete the user-directed merge.
  const dialog = page.getByTestId("merge-conflict-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("merge-conflict-confirm").click();

  // The discarded row is merged away; the canonical keeper record survives.
  await expect(page.getByText("Training Log merge dupe")).toHaveCount(0);
  await expect(keeperCard).toBeVisible();

  // The Undo toast appears; clicking it restores the discarded row.
  await expect(page.getByText("Activities merged.")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();

  await expect(page.getByText("Restored.")).toBeVisible();
  // Return to the log for a deterministic server render: the discarded row is
  // back (under a new id), proving the merge's delete was genuinely undoable.
  await page.goto("/training?tab=log");
  await expect(page.getByText("Training Log merge dupe")).toBeVisible();
});
