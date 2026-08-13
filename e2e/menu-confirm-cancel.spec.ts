import { test, expect } from "./fixtures";
import {
  hydratedClick,
  settledClick,
  settledFill,
  settledSelect,
} from "./helpers";

// A cancelled confirm must not leave the page unable to act (#2599, sighting 1).
//
// THE DEFECT, in the user's words: open a card's ⋯ menu, tap Delete, change your
// mind, tap Cancel — and your next tap anywhere on the page does nothing, with no
// error. `OverflowMenu` renders a full-screen `fixed inset-0` click-away backdrop
// while it is open; every call site closed the menu on the CONFIRM branch and
// most `return`ed early on CANCEL, so the backdrop outlived the interaction that
// opened the dialog and silently ate the next click.
//
// It surfaced as a TEST failure first, which is why it is worth pinning here: the
// swallowed tap made a Server Action form look like it fired no POST at all
// (settledClick's "NO same-origin POST was seen at all" diagnosis), 3/3 on this
// exact surface, cleared only by a fresh `page.goto`.
//
// The fix is the primitive's, not the call sites': a transient popover is stale
// the moment a decision opens over it, so `OverflowMenu` closes itself while a
// confirm is on screen. Both halves are asserted below — the menu is gone while
// the dialog is up (the RULE), and the next submit lands (the CONSEQUENCE, which
// is what a user would actually notice).
//
// Fixture (#868 hygiene): SPEC-OWNED throughout — a uniquely-named supplement and
// the bottle made from it, through the shipped item → bottle flow. The cancel
// writes nothing, and the submit it then proves is `switchProfileAction` for the
// profile already acting (a no-op that redirects), so the case is repeat-safe and
// perturbs no neighbour.

test("cancelling a confirm opened from an overflow menu leaves the page able to submit", async ({
  page,
}, testInfo) => {
  const suffix = `${testInfo.repeatEachIndex}-${testInfo.retry}`;
  const itemName = `Cancel guard item ${suffix}`;
  const bottleName = `Cancel guard bottle ${suffix}`;

  // A shared bottle to own: created through the item → bottle flow, so every row
  // this spec later reads is its own.
  await page.goto("/nutrition?tab=supplements");
  await page.getByTestId("supplement-add-toggle").click();
  const addDialog = page.getByRole("dialog", { name: "Add supplement" });
  await settledFill(page, addDialog.getByLabel("Name"), itemName);
  await settledFill(page, addDialog.getByLabel("Amount"), "10 mg");
  await addDialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(addDialog).toHaveCount(0);

  const row = page.getByTestId("supplement-row").filter({ hasText: itemName });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Supplement actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const editDialog = page.getByRole("dialog", { name: `Edit ${itemName}` });
  const picker = editDialog.getByTestId("shared-supply-picker");
  await settledSelect(page, picker.getByLabel("Shared supply"), "__new__");
  await settledFill(
    page,
    picker.getByLabel("New shared bottle name"),
    bottleName
  );
  await picker.getByTestId("shared-supply-apply").click();
  await expect(picker.getByTestId("shared-supply-success")).toContainText(
    bottleName
  );

  await page.goto("/supplies");
  const bottle = page
    .getByTestId("shared-supply-card")
    .filter({ hasText: bottleName });
  await expect(bottle).toHaveCount(1);

  // Open the ⋯ menu (a pure client toggle: hydratedClick, never a retry loop) and
  // ask for the delete, which opens the app-wide confirm.
  await hydratedClick(page, bottle.getByTestId("overflow-menu-trigger"));
  await page.getByTestId("shared-supply-delete").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();

  // THE RULE: the decision replaced the menu. Nothing of the popover — including
  // the click-away backdrop nobody can see — is left behind it.
  await expect(page.getByRole("menu")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  // THE CONSEQUENCE: an ordinary Server Action form on the same page still
  // submits. Before the fix this timed out with "NO same-origin POST was seen at
  // all", because the click never reached the button.
  await settledClick(page, bottle.getByTestId("shared-supply-add-for-submit"));
  await expect(page).toHaveURL(/\/nutrition\?tab=supplements&supply=\d+/);

  // …and the cancel really did cancel: the bottle is still in the cabinet.
  await page.goto("/supplies");
  await expect(
    page.getByTestId("shared-supply-card").filter({ hasText: bottleName })
  ).toHaveCount(1);
});
