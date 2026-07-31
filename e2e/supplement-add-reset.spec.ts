import { test, expect } from "./fixtures";

// The add-mode SupplementForm now lives in a modal. Saving unmounts it; reopening
// must start from a clean form so the `critical` checkbox can never leak into the
// next item and silently enroll it in missed-dose escalation.

const CRITICAL_NAME = "Reset Guard Critical Med";

test("add-mode form clears the critical flag for the next item (issue #627)", async ({
  page,
}) => {
  await page.goto("/nutrition?tab=supplements");

  await page.getByTestId("supplement-add-toggle").click();
  let addDialog = page.getByRole("dialog", { name: "Add supplement" });
  await addDialog
    .getByTestId("supplement-more-options")
    .locator("summary")
    .click();

  let critical = addDialog.getByTestId("supp-critical-new");

  // ── Add a CRITICAL medication ───────────────────────────────────────────────
  await addDialog.getByLabel("Name").fill(CRITICAL_NAME);
  await critical.check();
  await expect(critical).toBeChecked();
  await addDialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(addDialog).toHaveCount(0);

  // The item lands (confirming the add succeeded and the form reset ran).
  await expect(
    page.locator("div.card").filter({ hasText: CRITICAL_NAME }).first() // first-ok: the card for CRITICAL_NAME, a supplement THIS spec created (unique name)
  ).toBeVisible();

  // ── Reopening gives the next item a clean form. ─────────────────────────────
  await page.getByTestId("supplement-add-toggle").click();
  addDialog = page.getByRole("dialog", { name: "Add supplement" });
  await addDialog
    .getByTestId("supplement-more-options")
    .locator("summary")
    .click();
  critical = addDialog.getByTestId("supp-critical-new");
  await expect(critical).not.toBeChecked();
  await expect(addDialog.getByLabel("Name")).toHaveValue("");
});
