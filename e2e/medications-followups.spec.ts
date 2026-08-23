import { test, expect } from "./fixtures";
import { closeEditor, openFact } from "./intake-form-helpers";
import { type Page } from "@playwright/test";
import {
  comboboxRows,
  dismissToast,
  followLink,
  hydratedClick,
  settledBoxes,
  settledClick,
} from "./helpers";
import { openMedDetailViaHref } from "./med-card-helpers";

// #851 Medications follow-ups: the OTC-first add form (Rx/OTC flag with an on-demand
// prescription-fields disclosure, the "Generic"-led brand picker, the amount-only PRN
// dose row, the one-line redose copy), the shared Today-row primitive across scheduled
// + PRN rows, and PRN administration remove-with-undo + past-day history on the
// clinical-record detail page. Fixtures come from e2e/seed-events.ts:
// "Adherence Refill Med (e2e)" (scheduled, due) and "PRN Quicklog Med (e2e)" (PRN with
// two administrations logged today), plus history add/edit/delete with undo. The
// add-medication form is the "Add medication"
// card's intake form; its name combobox picks the collapsed catalog option.
const PRN_MED = "PRN Quicklog Med (e2e)";

async function openFullAdd(page: Page) {
  await page.getByTestId("medication-add-toggle").click();
  const panel = page.getByTestId("medication-add-panel");
  await expect(panel).toBeVisible();
  return panel;
}

test("add a generic OTC ibuprofen end-to-end (#851 acceptance)", async ({
  page,
}) => {
  await page.goto("/medications");

  const addCard = await openFullAdd(page);

  // Pick the collapsed catalog option (#851 item 14): "Ibuprofen (Advil, Motrin)".
  // Typing keeps a free-text "Use 'Ibuprofen'" row too, so target the catalog option
  // by its brands — not that fallback row.
  const nameInput = addCard.getByRole("combobox", { name: "Name" });
  await nameInput.click();
  await nameInput.fill("Ibuprofen");
  // The listbox is PORTALED to <body> (#3271) — resolved from the page, not the
  // panel that owns the field. One list is open at a time, so this is unambiguous.
  await comboboxRows(page)
    .filter({ hasText: "Advil" })
    .first() // first-ok: transient combobox list this spec just opened (Advil suggestion); first match is intended
    .click();
  await expect(nameInput).toHaveValue("Ibuprofen");

  // The Brand combobox offers "Generic" first (#851 item 3): open the identity fact,
  // assert the exact "Generic" option is offered, pick it, confirm it lands.
  const identity = await openFact(page, "identity", addCard);
  const brandInput = identity.getByRole("combobox", { name: "Brand" });
  await brandInput.click();
  // The option row lives in the PORTALED listbox (#3271), not inside the editor —
  // addressed through the listbox so it cannot be confused with a same-named
  // control elsewhere on the page.
  const brandOption = page
    .getByRole("listbox")
    .getByRole("option", { name: "Generic", exact: true });
  await expect(brandOption).toBeVisible();
  await brandOption.click();
  await expect(brandInput).toHaveValue("Generic");
  await closeEditor(page, addCard);

  // OTC by default (#851 items 1–2) — and the chip SAYS so, because "OTC" is a fact
  // and not an absence. Behind it: no prescriber field, no prescription block, and an
  // unchecked Rx toggle.
  await expect(addCard.getByTestId("intake-fact-prescription")).toContainText(
    "OTC"
  );
  const prescription = await openFact(page, "prescription", addCard);
  await expect(prescription.getByLabel("Prescriber")).toHaveCount(0);
  await expect(prescription.getByTestId("prescription-fields")).toHaveCount(0);
  const rxToggle = prescription.getByTestId("rx-toggle");
  await expect(rxToggle).toBeVisible();
  await expect(rxToggle).not.toBeChecked();
  await closeEditor(page, addCard);

  // The ibuprofen pick auto-marks it PRN via label-default prefill; if not, choose
  // May by hand — since #1505 `may` IS the as-needed shape, so selecting it is what
  // reveals the redose block and the amount-only dose row.
  const importance = await openFact(page, "importance", addCard);
  const obligation = importance.getByTestId("intake-obligation");
  if ((await obligation.inputValue()) !== "may")
    await obligation.selectOption("may");
  await closeEditor(page, addCard);

  // The one-line redose copy (#851 item 5): the terse explainer up front, the verbose
  // confirm-discipline text tucked behind a "How it works" disclosure.
  const timing = await openFact(page, "timing", addCard);
  const redose = timing.getByTestId("redose-block");
  await expect(redose).toBeVisible();
  await expect(
    redose.getByText("Reminds you when the minimum interval has passed")
  ).toBeVisible();
  await expect(redose.getByText("How it works")).toBeVisible();
  await closeEditor(page, addCard);

  // The PRN dose editor is the amount-only single row (#851 item 9): no "+ Add dose"
  // split affordance.
  const dose = await openFact(page, "dose", addCard);
  await expect(dose.getByTestId("prn-dose-row")).toBeVisible();
  await closeEditor(page, addCard);

  // Save. The new medication lands as a current row with the OTC badge and no Rx badge.
  await addCard.getByRole("button", { name: "Add", exact: true }).click();
  const row = page
    .getByTestId("medication-row")
    .filter({ hasText: "Ibuprofen" })
    .filter({ hasText: "Generic" });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("otc-badge")).toBeVisible();
  await expect(row.getByTestId("rx-badge")).toHaveCount(0);
});

test("Rx toggle reveals and hides the prescription fields (#851 items 1–2)", async ({
  page,
}) => {
  await page.goto("/medications");
  const addCard = await openFullAdd(page);

  const prescription = await openFact(page, "prescription", addCard);
  const rxToggle = prescription.getByTestId("rx-toggle");
  const fields = prescription.getByTestId("prescription-fields");

  // Hidden by default (OTC), revealed on toggle, hidden again on untoggle.
  await expect(fields).toHaveCount(0);
  await rxToggle.check();
  await expect(fields).toBeVisible();
  await expect(addCard.getByLabel("Prescriber")).toBeVisible();
  await rxToggle.uncheck();
  await expect(fields).toHaveCount(0);
});

test("scheduled and PRN rows share the one Today-row primitive (#851 item 10)", async ({
  page,
}) => {
  await page.goto("/medications");
  await expect(page.getByTestId("medications-today")).toBeVisible();

  // Both a scheduled check-off row and a PRN administration row are the SAME
  // TodayMedRow primitive, marked with data-today-row="1".
  await expect(
    page.locator('[data-testid="today-scheduled-med"][data-today-row="1"]')
  ).not.toHaveCount(0);
  await expect(
    page.locator('[data-testid="quick-log-prn-item"][data-today-row="1"]')
  ).not.toHaveCount(0);

  // The administration summary belongs directly under the PRN medication name;
  // the right-side actions must not reserve an empty row between them.
  const prnRow = page
    .locator('[data-testid="quick-log-prn-item"][data-today-row="1"]')
    .first(); // first-ok: a today-PRN row — asserts the name/summary layout, order-agnostic
  const [nameBox, summaryBox] = await settledBoxes([
    prnRow.getByRole("link"),
    prnRow.getByTestId("prn-day-label"),
  ]);
  expect(summaryBox.y - (nameBox.y + nameBox.height)).toBeLessThanOrEqual(4);

  const scheduledRow = page.getByTestId("today-scheduled-med").first(); // first-ok: asserts a scheduled-med row renders today — order-agnostic presence
  const actionButtons = [
    scheduledRow.getByTestId("dose-take"),
    scheduledRow.getByTestId("dose-skip"),
    prnRow.getByTestId("prn-log-now"),
    prnRow.getByTestId("prn-log-more"),
  ];
  const actionWidths = await Promise.all(
    actionButtons.map(async (button) => (await button.boundingBox())!.width)
  );
  expect(
    Math.max(...actionWidths) - Math.min(...actionWidths)
  ).toBeLessThanOrEqual(1);
  expect(Math.max(...actionWidths)).toBeLessThanOrEqual(36);
  for (const button of actionButtons) {
    await expect(button).toHaveAttribute("title", /\S+/);
  }
});

test("PRN administration removes with an Undo toast that restores it (#851 item 11)", async ({
  page,
}) => {
  // Open the seeded PRN med's clinical-record detail page via a DIRECT goto to its href
  // (not a Link click): on the heavier list page a client-side transition to the detail
  // can be interrupted/reverted under load, detaching the administration chips mid-click
  // (the settle race the coordinator flagged). A full navigation lands on a settled page.
  await page.goto("/medications");
  // The row→detail href nav (the #852 settle-race fix) is owned by the shared med-card
  // driver (#868 class-2).
  const detail = await openMedDetailViaHref(page, PRN_MED);
  await expect(detail).toBeVisible();
  const rows = detail.getByTestId("prn-administration-row");
  await expect(rows.first()).toBeVisible(); // first-ok: the administration rows this spec logged on its own med — order-agnostic
  // Capture the count dynamically so a CI retry (persisted DB) still balances.
  const before = await rows.count();
  expect(before).toBeGreaterThanOrEqual(1);

  // Remove the first administration → "Dose removed." toast + Undo, count drops by one.
  await rows.first().getByTestId("prn-administration-remove").click(); // first-ok: removes an administration row this spec logged — order-agnostic
  await expect(page.getByText("Dose removed.")).toBeVisible();
  await expect(rows).toHaveCount(before - 1);

  // Undo → "Restored." toast, the chip comes back.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Restored.")).toBeVisible();
  await expect(rows).toHaveCount(before);
});

test("detail page shows past-administration history (#851 item 13)", async ({
  page,
}) => {
  await page.goto("/medications");

  // Row→detail href nav owned by the shared med-card driver (#868 class-2).
  const detail = await openMedDetailViaHref(page, PRN_MED);
  await expect(detail).toBeVisible();

  // The seeded PRN med has administrations logged today, so the History section
  // renders its complete dose-history roll-up.
  const history = detail.getByTestId("dose-history");
  await expect(history).toBeVisible();
  await expect(history.getByText("Dose history")).toBeVisible();
});

test("logs, edits, and deletes a historical medication dose", async ({
  page,
}, testInfo) => {
  const loggedAmount = `${225 + testInfo.repeatEachIndex} mg`;
  const updatedAmount = `${250 + testInfo.repeatEachIndex} mg`;
  await page.goto("/medications");
  // Row→detail href nav owned by the shared med-card driver (#868 class-2).
  await openMedDetailViaHref(page, PRN_MED);

  const history = page.getByTestId("dose-history");
  await history.getByRole("button", { name: "Log past dose" }).click();
  const form = history.getByTestId("historical-dose-form");
  await expect(form).toContainText(
    "records a separate administration in dose history"
  );
  await expect(form).toContainText("start date will move back to match");
  const maxDate = await form
    .locator('input[type="hidden"][name="date"]')
    .inputValue();
  const date = new Date(`${maxDate}T00:00:00Z`);
  // The fixture starts five days ago. Logging 45 days ago proves the former 30-day
  // cap is gone and moves the PRN course start backward atomically.
  date.setUTCDate(date.getUTCDate() - 45);
  const beforeStart = date.toISOString().slice(0, 10);
  await form.getByTestId("historical-dose-date").fill(beforeStart);
  await form.getByTestId("historical-dose-time").fill("03:17");
  await form.getByLabel("Amount").fill(loggedAmount);
  await settledClick(page, form.getByRole("button", { name: "Save dose" }));

  await expect(page.getByText(`Logged past dose of ${PRN_MED}.`)).toBeVisible();
  await expect(history).toContainText(loggedAmount);
  await expect(history).toContainText(/(?:3:17am|03:17)/);

  const loggedRow = history
    .getByTestId("dose-history-row")
    .filter({ hasText: loggedAmount });
  await loggedRow.getByRole("button", { name: "Dose actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  // The row swaps its cells for the edit form in place (the shared
  // EntryHistoryTable, #2417), so the amount text the row was FILTERED on is gone
  // while the editor is open — the form is scoped to the panel instead.
  const editForm = history.getByTestId("historical-dose-form");
  await editForm.getByLabel("Amount").fill(updatedAmount);
  await editForm.getByTestId("historical-dose-time").fill("04:18");
  await settledClick(
    page,
    editForm.getByRole("button", { name: "Save changes" })
  );
  await expect(page.getByText(`Updated dose of ${PRN_MED}.`)).toBeVisible();

  const updatedRow = history
    .getByTestId("dose-history-row")
    .filter({ hasText: updatedAmount });
  await expect(updatedRow).toContainText(/(?:4:18am|04:18)/);
  await updatedRow.getByRole("button", { name: "Dose actions" }).click();
  // Removing one logged event confirms first and undoes after — the shared delete
  // path every EntryHistoryTable row now goes through. The menu item only OPENS the
  // dialog; the write happens when the dialog is answered.
  await hydratedClick(page, page.getByRole("menuitem", { name: "Delete" }));
  await settledClick(
    page,
    page
      .getByTestId("confirm-dialog")
      .getByRole("button", { name: "Delete dose" })
  );
  await expect(page.getByText("Dose deleted.")).toBeVisible();
  await expect(updatedRow).toHaveCount(0);
  await settledClick(page, page.getByRole("button", { name: "Undo" }));
  const restoredRow = history
    .getByTestId("dose-history-row")
    .filter({ hasText: updatedAmount });
  await expect(restoredRow).toBeVisible();
  // The undo posts its own "Restored." toast into the bottom-right stack, and the
  // dose table is the BOTTOM section of this page — so the row menu re-opened below
  // sits under it for the full 6s auto-dismiss window (#2861).
  await dismissToast(page, "Restored.");

  // Undo is part of the behavior under test; remove the restored fixture again
  // so --repeat-each starts from the same dose history instead of accumulating
  // duplicate rows with identical timestamps.
  await restoredRow.getByRole("button", { name: "Dose actions" }).click();
  await hydratedClick(page, page.getByRole("menuitem", { name: "Delete" }));
  await settledClick(
    page,
    page
      .getByTestId("confirm-dialog")
      .getByRole("button", { name: "Delete dose" })
  );
  await expect(restoredRow).toHaveCount(0);
  // Second delete, second toast — and the Medication actions menu opened next is in
  // the same quadrant (#2861).
  await dismissToast(page, "Dose deleted.");

  // The administration and course correction are one write: editing immediately
  // afterward must show the selected dose date as the new PRN start. The course dates
  // are behind the stop-date fact now, so the assertion opens it.
  await page.getByRole("button", { name: "Medication actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const dates = await openFact(page, "stopDate");
  // The field renders the profile's own date format, so assert the DAY it holds
  // rather than the spelling of it.
  const shown = await dates.getByLabel("Using since").inputValue();
  expect(new Date(`${shown} UTC`).toISOString().slice(0, 10)).toBe(beforeStart);
});

// #2417: the medications surface carries the same one-click door onto the cross-item
// dose ledger the supplements tab does — one component, two doors — and it opens
// PRE-FILTERED to medications, with the kind filter as the thing that widens it.
test("the medications page reaches the dose ledger, pre-filtered to medications", async ({
  page,
}) => {
  await page.goto("/medications");
  const ledgerDoor = page.getByTestId("dose-ledger-link");
  // Both sides visible before the containment read — this page streams, and a node the
  // runtime has not yet relocated is attached but not yet inside its parent, which
  // answers FALSE about correct markup.
  await expect(ledgerDoor).toBeVisible();
  await expect(page.getByTestId("medications-today")).toBeVisible();
  // Since #3479 the door lives in the Today card rather than the page header — the
  // ledger is the record of exactly what that card checks off. The containment is the
  // half of the move a URL assertion cannot see.
  expect(
    await ledgerDoor.evaluate((node) =>
      Boolean(
        document
          .querySelector('[data-testid="medications-today"]')
          ?.contains(node)
      )
    )
  ).toBe(true);
  await followLink(page, ledgerDoor, /\/medications\/dose-history/);

  // The kind filter opens on this surface's own kind.
  const kinds = page.getByTestId("dose-ledger-kind-filter");
  await expect(
    kinds.getByRole("link", { name: "Medications" })
  ).toHaveAttribute("aria-current", "true");

  // The seeded PRN medication's own confirmed doses are in the ledger, named by item.
  const ledger = page.getByTestId("dose-ledger");
  await expect(
    ledger.getByTestId("dose-ledger-row").filter({ hasText: PRN_MED })
  ).not.toHaveCount(0);

  // Widening to All keeps the same table and reaches the other kind's items.
  await followLink(page, kinds.getByRole("link", { name: "All" }), /kind=all/);
  await expect(page.getByTestId("dose-ledger")).toBeVisible();

  // The chart half of the same question is one link away.
  await expect(page.getByTestId("dose-ledger-trends-link")).toHaveAttribute(
    "href",
    "/trends?tab=nutrition#dose-history"
  );
});
