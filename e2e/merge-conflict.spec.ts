import { test, expect } from "./fixtures";
import { followLink } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_MERGE_CONFLICT,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
// Issue #100: conflict-aware merge preview. The e2e seed (e2e/seed-events) plants two
// same-day MANUAL cardio rows on 2026-07-06 that genuinely DISAGREE on duration
// ("Conflict merge keeper" 42 min vs "Conflict merge dupe" 51 min) but agree on
// distance. Merging them must raise the per-field conflict preview (not a silent
// one-click fold); this drives the required flow: open the preview, override the one
// conflicting field to the DISCARDED row's value, confirm, and prove the merged
// keeper carries the override (51 min).
// THE MERGE IS THE POINT, so this row cannot be restored. Its fixture and login
// own a dedicated profile (#3965/#868), which keeps consuming the discarded row
// from changing profile 1 for any later reader on the worker.
test("merge preview lets you override a conflicting field to the discarded value (#100)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_MERGE_CONFLICT,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
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
    await expect(
      dialog.getByTestId("conflict-duration_min-keep")
    ).toContainText("42 min");
    await expect(
      dialog.getByTestId("conflict-duration_min-drop")
    ).toContainText("51 min");

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
  } finally {
    await page.context().close();
  }
});
