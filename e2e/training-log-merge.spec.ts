import { test, expect } from "./fixtures";
import { hydratedClick } from "./helpers";
// Issue #64, Part 2: the Training Log's manual pair-merge. The e2e seed (e2e/seed-events)
// plants two same-day MANUAL activities on 2026-07-05 — "Training Log merge keeper" and
// "Training Log merge dupe" — a duplicate no heuristic catches (two manual rows). This
// drives the required flow: select the keeper's row (#2897 slim feed), open the full
// record's overflow menu in the reading pane, pick the sibling to absorb, and prove
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

  // Select the keeper's row (a pure client toggle — hydratedClick closes the
  // pre-hydration window), then open the pane card's overflow (⋯) menu →
  // "Merge with…" → pick the dupe.
  await hydratedClick(page, keeperRow);
  const keeperCard = page
    .getByTestId("training-log-reading-pane")
    .locator(".card", { hasText: "Training Log merge keeper" });
  await expect(keeperCard).toBeVisible();
  await keeperCard.getByRole("button", { name: "Activity actions" }).click();
  await page.getByTestId("merge-with").click();
  await page
    .getByTestId("merge-target")
    .filter({ hasText: "Training Log merge dupe" })
    .click();

  // The discarded row is merged away; the keeper survives (row and pane card —
  // scope to the row, since the keeper's title now renders in both).
  await expect(page.getByText("Training Log merge dupe")).toHaveCount(0);
  await expect(keeperRow).toBeVisible();

  // The Undo toast appears; clicking it restores the discarded row.
  await expect(page.getByText("Activities merged.")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();

  await expect(page.getByText("Restored.")).toBeVisible();
  // Reload for a deterministic server render: the discarded row is back on the feed
  // (restored under a new id), proving the merge's delete was genuinely undoable.
  await page.reload();
  await expect(page.getByText("Training Log merge dupe")).toBeVisible();
});
