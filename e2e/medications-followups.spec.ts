import { test, expect } from "@playwright/test";

// #851 Medications follow-ups: the OTC-first add form (Rx/OTC flag with an on-demand
// prescription-fields disclosure, the "Generic"-led brand picker, the amount-only PRN
// dose row, the one-line redose copy), the shared Today-row primitive across scheduled
// + PRN rows, and PRN administration remove-with-undo + past-day history on the
// clinical-record detail page. Fixtures come from e2e/seed-events.ts:
// "Adherence Refill Med (e2e)" (scheduled, due) and "PRN Quicklog Med (e2e)" (PRN with
// two administrations logged today). The add-medication form is the "Add medication"
// card's MedicationForm; its name combobox picks the collapsed catalog option.
const PRN_MED = "PRN Quicklog Med (e2e)";

test("add a generic OTC ibuprofen end-to-end (#851 acceptance)", async ({
  page,
}) => {
  await page.goto("/medications");

  // The full med-specific form (the long-tail path); the OTC quick-add card is above it.
  const addCard = page
    .locator("div.card")
    .filter({ hasText: "Add medication" });
  await expect(addCard).toBeVisible();

  // Pick the collapsed catalog option (#851 item 14): "Ibuprofen (Advil, Motrin)".
  // Typing keeps a free-text "Use 'Ibuprofen'" row too, so target the catalog option
  // by its brands — not that fallback row.
  const nameInput = addCard.getByRole("combobox", { name: "Name" });
  await nameInput.click();
  await nameInput.fill("Ibuprofen");
  await addCard
    .locator('ul[role="listbox"] button', { hasText: "Advil" })
    .first()
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
    .first();
  await expect(row).toBeVisible();
  await expect(row.getByTestId("otc-badge")).toBeVisible();
  await expect(row.getByTestId("rx-badge")).toHaveCount(0);
});

test("Rx toggle reveals and hides the prescription fields (#851 items 1–2)", async ({
  page,
}) => {
  await page.goto("/medications");
  const addCard = page
    .locator("div.card")
    .filter({ hasText: "Add medication" });
  await expect(addCard).toBeVisible();

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
});

test("PRN administration removes with an Undo toast that restores it (#851 item 11)", async ({
  page,
}) => {
  // Open the seeded PRN med's clinical-record detail page via a DIRECT goto to its href
  // (not a Link click): on the heavier list page a client-side transition to the detail
  // can be interrupted/reverted under load, detaching the administration chips mid-click
  // (the settle race the coordinator flagged). A full navigation lands on a settled page.
  await page.goto("/medications");
  const link = page
    .getByTestId("medication-row")
    .filter({ hasText: PRN_MED })
    .getByTestId("medication-row-link");
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  expect(href).toMatch(/\/medications\/\d+/);
  await page.goto(href!);

  const detail = page.getByTestId("medication-detail");
  await expect(detail).toBeVisible();
  const chips = detail.getByTestId("prn-administration-chip");
  await expect(chips.first()).toBeVisible();
  // Capture the count dynamically so a CI retry (persisted DB) still balances.
  const before = await chips.count();
  expect(before).toBeGreaterThanOrEqual(1);

  // Remove the first administration → "Dose removed." toast + Undo, count drops by one.
  await chips.first().getByTestId("prn-administration-remove").click();
  await expect(page.getByText("Dose removed.")).toBeVisible();
  await expect(chips).toHaveCount(before - 1);

  // Undo → "Restored." toast, the chip comes back.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Restored.")).toBeVisible();
  await expect(chips).toHaveCount(before);
});

test("detail page shows past-administration history (#851 item 13)", async ({
  page,
}) => {
  await page.goto("/medications");

  const link = page
    .getByTestId("medication-row")
    .filter({ hasText: PRN_MED })
    .getByTestId("medication-row-link");
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  expect(href).toMatch(/\/medications\/\d+/);
  await page.goto(href!);
  const detail = page.getByTestId("medication-detail");
  await expect(detail).toBeVisible();

  // The seeded PRN med has administrations logged today, so the "Recent doses" roll-up
  // renders inside the (detail-open) History disclosure.
  const history = detail.getByTestId("prn-history");
  await expect(history).toBeVisible();
  await expect(history.getByText("Recent doses")).toBeVisible();
});
