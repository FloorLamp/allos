import { test, expect } from "@playwright/test";

// The add-mode SupplementForm is a single long-lived instance (soft router.refresh
// after each add keeps it mounted). Its post-add reset must clear EVERY field — not
// just the ones in the reset list. Before the fix (issue #627) the `critical`
// checkbox (which sits outside the medication-only block, so it applies to every
// item) kept its checked state after an add, silently saving the NEXT item as a
// critical medication and enrolling it in the missed-dose escalation path the user
// never asked for. This drives the real form: add a critical med, then assert the
// checkbox is cleared for the next item without a reload.

const CRITICAL_NAME = "Reset Guard Critical Med";

test("add-mode form clears the critical flag for the next item (issue #627)", async ({
  page,
}) => {
  await page.goto("/nutrition?tab=supplements");

  const addCard = page
    .locator("div.card")
    .filter({ hasText: "Add supplement" });

  const critical = addCard.getByTestId("supp-critical-new");

  // ── Add a CRITICAL medication ───────────────────────────────────────────────
  await addCard.getByLabel("Name").fill(CRITICAL_NAME);
  await critical.check();
  await expect(critical).toBeChecked();
  await addCard.getByRole("button", { name: "Add", exact: true }).click();

  // The item lands (confirming the add succeeded and the form reset ran).
  await expect(
    page.locator("div.card").filter({ hasText: CRITICAL_NAME }).first()
  ).toBeVisible();

  // ── The critical checkbox is cleared — a second item won't be silently
  //    saved critical. The name field also cleared (the reset is total). ────────
  await expect(critical).not.toBeChecked();
  await expect(addCard.getByLabel("Name")).toHaveValue("");
});
