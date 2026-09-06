import { test, expect } from "./fixtures";
import { closeEditor, openFact } from "./intake-form-helpers";
import { hydratedClick } from "./helpers";
// The web dose check-off is a TAKEN / SKIPPED / CLEAR tri-state (#232): a
// deliberate skip is a first-class decision, distinct from a silent miss, with
// its own control beside the ✅ take. This drives the whole cycle in the real app
// against a freshly-created, uniquely-named supplement so it never disturbs the
// seeded intake rows other specs rely on, and deletes it at the end.
//
// UNIQUE AGAINST THE SEED IS NOT UNIQUE AGAINST ITSELF (#4906): `e2e-changed` runs a
// changed file at `--repeat-each=3`, and copies of this spec sharing one worker DB
// each create a supplement called NAME — the `toHaveCount(1)` below then sees 2 or 3
// and the teardown deletes race. `testInfo.repeatEachIndex` is the same fix
// `medications-followups.spec.ts:320` already uses for the identical reason.

test("dose check-off cycles taken → skipped → clear as a tri-state", async ({
  page,
}, testInfo) => {
  const NAME = `Skip State Zinc ${testInfo.repeatEachIndex}`;
  await page.goto("/nutrition?tab=supplements");

  // ── Create a single daily Morning dose ──────────────────────────────────────
  await page.getByTestId("supplement-add-toggle").click();
  const addDialog = page.getByRole("dialog", { name: "Add supplement" });
  await addDialog.getByLabel("Name").fill(NAME);
  const doseEditor1 = await openFact(page, "dose", addDialog);
  await doseEditor1.getByLabel("Amount").first().fill("15 mg"); // eslint-disable-line no-restricted-properties -- first-ok: the add modal's first dose-row field
  await doseEditor1.getByLabel("Time of day").first().selectOption("Morning"); // eslint-disable-line no-restricted-properties -- first-ok: the add modal's first dose-row field
  await closeEditor(page, addDialog);
  await addDialog.getByRole("button", { name: "Add", exact: true }).click();

  // THE DAY MOVED (#3987): a dose's taken/skipped/clear state is the Day ledger's, on
  // the Food tab, where the day is. The Supplements tab is management now — it is
  // where this dose was CREATED, two steps up, and it states nothing about today.
  //
  // THE ROW IS ADDRESSED BY ITS DOSE, NOT BY ITS PLACE. A ledger separates what the
  // day still OWES from what it has RECORDED, so resolving this dose moves it from
  // the bucket's due row to a recorded row of its own — a different `<li>`, with the
  // same control on it. Re-deriving the locator after every transition is what makes
  // the tri-state assertions below claims about the DOSE rather than about an element that
  // is allowed to move.
  await page.goto("/nutrition?tab=food");
  const morning = page.getByTestId("ledger-group-morning");
  // hydratedClick, not click: the due row's disclosure is a controlled React button
  // and this is the first interaction after the goto, so a lost tap would surface as
  // the dose row below being absent rather than as a tap that never landed (#4835).
  await hydratedClick(
    page,
    morning.locator('[data-testid^="ledger-due-group-"]')
  );
  const row = page
    .getByTestId("day-ledger")
    .locator(
      'li[data-testid^="ledger-due-dose-"], li[data-testid^="ledger-dose-"]'
    )
    .filter({ hasText: NAME });
  await expect(row).toHaveCount(1);

  const take = row.getByRole("button", { name: "Take", exact: true });
  const skip = row.getByRole("button", { name: "Skip this dose" });
  await expect(take).toBeVisible();
  await expect(skip).toBeVisible();

  // ── Skip the dose: the skip control latches, take stays unmarked ─────────────
  await skip.click();
  const skipOn = row.getByRole("button", { name: "Undo skip" });
  await expect(skipOn).toBeVisible();
  await expect(skipOn).toHaveAttribute("aria-pressed", "true");
  // The dose is NOT counted as taken.
  await expect(
    row.getByRole("button", { name: "Take", exact: true })
  ).toHaveAttribute("aria-pressed", "false");

  // ── Undo the skip → back to clear ───────────────────────────────────────────
  await skipOn.click();
  await expect(
    row.getByRole("button", { name: "Skip this dose" })
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    row.getByRole("button", { name: "Take", exact: true })
  ).toHaveAttribute("aria-pressed", "false");

  // ── Take it, then flip taken → skipped (an explicit toggle) ──────────────────
  await row.getByRole("button", { name: "Take", exact: true }).click();
  await expect(
    row.getByRole("button", { name: "Undo take", exact: true })
  ).toHaveAttribute("aria-pressed", "true");

  await row.getByRole("button", { name: "Skip this dose" }).click();
  // Now skipped, and no longer taken.
  await expect(row.getByRole("button", { name: "Undo skip" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(
    row.getByRole("button", { name: "Take", exact: true })
  ).toHaveAttribute("aria-pressed", "false");

  // ── Clean up: delete the supplement so the fixture is left as found ──────────
  // Deleting an ITEM is a management act, on the tab that manages the stack.
  await page.goto("/nutrition?tab=supplements");
  await page
    .getByTestId("supplement-row")
    .filter({ hasText: NAME })
    .getByRole("button", { name: "Supplement actions" })
    .click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator("div.card").filter({ hasText: NAME })).toHaveCount(
    0
  );
});
