import { test, expect, type Page } from "@playwright/test";
import { settledClick } from "./helpers";
import { openMedDetailViaHref } from "./med-card-helpers";

// #851 Medications follow-ups: the OTC-first add form (Rx/OTC flag with an on-demand
// prescription-fields disclosure, the "Generic"-led brand picker, the amount-only PRN
// dose row, the one-line redose copy), the shared Today-row primitive across scheduled
// + PRN rows, and PRN administration remove-with-undo + past-day history on the
// clinical-record detail page. Fixtures come from e2e/seed-events.ts:
// "Adherence Refill Med (e2e)" (scheduled, due) and "PRN Quicklog Med (e2e)" (PRN with
// two administrations logged today), plus history add/edit/delete with undo. The
// add-medication form is the "Add medication"
// card's MedicationForm; its name combobox picks the collapsed catalog option.
const PRN_MED = "PRN Quicklog Med (e2e)";

async function openFullAdd(page: Page) {
  await page.getByTestId("medication-add-toggle").click();
  await page.getByTestId("medication-add-full").click();
  const panel = page.getByTestId("medication-add-panel");
  await expect(panel).toBeVisible();
  return panel;
}

test("add a generic OTC ibuprofen end-to-end (#851 acceptance)", async ({
  page,
}) => {
  await page.goto("/medications");

  // Open the long-tail full-details path from the single inline add workspace.
  const addCard = await openFullAdd(page);

  // Pick the collapsed catalog option (#851 item 14): "Ibuprofen (Advil, Motrin)".
  // Typing keeps a free-text "Use 'Ibuprofen'" row too, so target the catalog option
  // by its brands — not that fallback row.
  const nameInput = addCard.getByRole("combobox", { name: "Name" });
  await nameInput.click();
  await nameInput.fill("Ibuprofen");
  await addCard
    .locator('ul[role="listbox"] button', { hasText: "Advil" })
    .first() // first-ok: transient combobox list this spec just opened (Advil suggestion); first match is intended
    .click();
  await expect(nameInput).toHaveValue("Ibuprofen");

  // The Brand combobox offers "Generic" first (#851 item 3): open it, assert the
  // exact "Generic" option is offered, pick it, and confirm it lands in the field.
  const brandInput = addCard.getByRole("combobox", { name: "Brand" });
  await brandInput.click();
  await expect(
    addCard.getByRole("button", { name: "Generic", exact: true })
  ).toBeVisible();
  await addCard.getByRole("button", { name: "Generic", exact: true }).click();
  await expect(brandInput).toHaveValue("Generic");

  // OTC by default (#851 items 1–2): NO prescriber field, the prescription-fields block
  // isn't rendered, and the Rx toggle is present + unchecked.
  await expect(addCard.getByLabel("Prescriber")).toHaveCount(0);
  await expect(addCard.getByTestId("prescription-fields")).toHaveCount(0);
  const rxToggle = addCard.getByTestId("rx-toggle");
  await expect(rxToggle).toBeVisible();
  await expect(rxToggle).not.toBeChecked();

  // The ibuprofen pick auto-marks it PRN via label-default prefill; if not, check the
  // "As needed (PRN)" box so the redose block + amount-only dose row render.
  const prn = addCard.getByRole("checkbox", { name: /As needed/ });
  if (!(await prn.isChecked())) await prn.check();

  // The one-line redose copy (#851 item 5): the terse explainer up front, the verbose
  // confirm-discipline text tucked behind a "How it works" disclosure.
  const redose = addCard.getByTestId("redose-block");
  await expect(redose).toBeVisible();
  await expect(
    redose.getByText("Reminds you when the minimum interval has passed")
  ).toBeVisible();
  await expect(redose.getByText("How it works")).toBeVisible();

  // The PRN dose editor is the amount-only single row (#851 item 9): no "+ Add dose"
  // split affordance.
  await expect(addCard.getByTestId("prn-dose-row")).toBeVisible();

  // Save. The new medication lands as a current row with the OTC badge and no Rx badge.
  await addCard.getByRole("button", { name: "Add", exact: true }).click();
  const row = page
    .getByTestId("medication-row")
    .filter({ hasText: "Ibuprofen" })
    .first(); // first-ok: filtered to the Ibuprofen med this spec just added — one match
  await expect(row).toBeVisible();
  await expect(row.getByTestId("otc-badge")).toBeVisible();
  await expect(row.getByTestId("rx-badge")).toHaveCount(0);
});

test("Rx toggle reveals and hides the prescription fields (#851 items 1–2)", async ({
  page,
}) => {
  await page.goto("/medications");
  const addCard = await openFullAdd(page);

  const rxToggle = addCard.getByTestId("rx-toggle");
  const fields = addCard.getByTestId("prescription-fields");

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
  const [nameBox, summaryBox] = await Promise.all([
    prnRow.getByRole("link").boundingBox(),
    prnRow.getByTestId("prn-day-label").boundingBox(),
  ]);
  expect(nameBox).not.toBeNull();
  expect(summaryBox).not.toBeNull();
  expect(summaryBox!.y - (nameBox!.y + nameBox!.height)).toBeLessThanOrEqual(4);

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
  const editForm = loggedRow.getByTestId("historical-dose-form");
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
  await settledClick(page, page.getByRole("menuitem", { name: "Delete" }));
  await expect(page.getByText("Dose deleted.")).toBeVisible();
  await expect(updatedRow).toHaveCount(0);
  await settledClick(page, page.getByRole("button", { name: "Undo" }));
  const restoredRow = history
    .getByTestId("dose-history-row")
    .filter({ hasText: updatedAmount });
  await expect(restoredRow).toBeVisible();

  // Undo is part of the behavior under test; remove the restored fixture again
  // so --repeat-each starts from the same dose history instead of accumulating
  // duplicate rows with identical timestamps.
  await restoredRow.getByRole("button", { name: "Dose actions" }).click();
  await settledClick(page, page.getByRole("menuitem", { name: "Delete" }));
  await expect(restoredRow).toHaveCount(0);

  // The administration and course correction are one write: editing immediately
  // afterward must show the selected dose date as the new PRN start.
  await page.getByRole("button", { name: "Medication actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(
    page.locator('input[type="hidden"][name="started_on"]')
  ).toHaveValue(beforeStart);
});
