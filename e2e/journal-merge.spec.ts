import { test, expect } from "@playwright/test";

// Issue #64, Part 2: the Journal's manual pair-merge. The e2e seed (e2e/seed-events)
// plants two same-day MANUAL activities on 2026-07-05 — "Journal merge keeper" and
// "Journal merge dupe" — a duplicate no heuristic catches (two manual rows). This
// drives the required flow: open a card's overflow menu, pick the sibling to absorb,
// and prove the discarded row is folded away, plus the Undo toast restores it.
test("merge two same-day activities from the Journal, then Undo (#64)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  const keeperCard = page
    .locator('[id^="activity-"]')
    .filter({ hasText: "Journal merge keeper" });
  await expect(keeperCard).toHaveCount(1);
  // Both same-day rows are present before the merge.
  await expect(page.getByText("Journal merge dupe")).toBeVisible();

  // Open the keeper card's overflow (⋯) menu → "Merge with…" → pick the dupe.
  await keeperCard.getByRole("button", { name: "Activity actions" }).click();
  await page.getByTestId("merge-with").click();
  await page
    .getByTestId("merge-target")
    .filter({ hasText: "Journal merge dupe" })
    .click();

  // The discarded row is merged away; the keeper survives.
  await expect(page.getByText("Journal merge dupe")).toHaveCount(0);
  await expect(page.getByText("Journal merge keeper")).toBeVisible();

  // The Undo toast appears; clicking it restores the discarded row.
  await expect(page.getByText("Activities merged.")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();

  await expect(page.getByText("Restored.")).toBeVisible();
  // Reload for a deterministic server render: the discarded row is back on the feed
  // (restored under a new id), proving the merge's delete was genuinely undoable.
  await page.reload();
  await expect(page.getByText("Journal merge dupe")).toBeVisible();
});
