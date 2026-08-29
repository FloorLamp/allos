import { test, expect } from "./fixtures";
import { followLink } from "./helpers";
// Issue #100: conflict-aware merge preview. The e2e seed (e2e/seed-events) plants two
// same-day MANUAL cardio rows on 2026-07-06 that genuinely DISAGREE on duration
// ("Conflict merge keeper" 42 min vs "Conflict merge dupe" 51 min) but agree on
// distance. Merging them must raise the per-field conflict preview (not a silent
// one-click fold); this drives the required flow: open the preview, override the one
// conflicting field to the DISCARDED row's value, confirm, and prove the merged
// keeper carries the override (51 min).
// THE MERGE IS THE POINT, so this row cannot be restored (#3946). "Conflict merge dupe" is
// seeded on the SHARED profile for this test alone (e2e/seed/merge.ts) and
// merging consumes it; putting it back by hand would be a second producer of a
// row the seed owns. The keeper survives with the overridden duration, so the Log keeps a row on that day.
// Declared here rather than exempted by name: nothing anywhere holds a list of
// specs this guard skips, and #3260's caveat stands — nothing checks that this
// `why` is still true.
test.use({
  sharedProfileLeftovers: {
    why:
      "The merge under test consumes this seeded row; restoring it would " +
      "re-seed rather than clean up, and no other spec addresses it.",
    titles: ["Conflict merge dupe"],
  },
});

test("merge preview lets you override a conflicting field to the discarded value (#100)", async ({
  page,
}) => {
  await page.goto("/training?tab=log"); // default "Log" tab renders the Training Log feed

  const keeperRow = page
    .locator('[id^="activity-"]')
    .filter({ hasText: "Conflict merge keeper" });
  await expect(keeperRow).toHaveCount(1);
  // Before the merge the keeper's row summary shows its own 42 min, and both
  // rows are present.
  await expect(keeperRow.getByText("42 min")).toBeVisible();
  await expect(page.getByText("Conflict merge dupe")).toBeVisible();

  // Open the keeper's canonical record, then use its overflow (⋯) menu →
  // "Merge with…" → pick the dupe.
  await followLink(
    page,
    keeperRow.getByRole("link", {
      name: "Conflict merge keeper",
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
  const merged = page.getByTestId("training-activity-page");
  await expect(merged.getByText("51 min")).toBeVisible();
  await expect(merged.getByText("42 min")).toHaveCount(0);
});
