import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_CHILD, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import {
  medicationRow,
  medicationRowLink,
  medicationDoseSummary,
  prnTodayItem,
} from "./med-card-helpers";

// #846 medication form split + selection prefill. The Medications page renders the
// real MedicationForm (not a supplement-shaped shared body): its placeholders are
// medication-shaped, and picking a catalogued med from the name combobox PRE-FILLS
// every knowable field as an editable, marked suggestion (PRN toggle, dose strength,
// interval/max, food timing) from the curated datasets — so a pick → save with ZERO
// edits produces a valid medication row. Naproxen (curated `typical` + OTC PRN
// defaults, not in the seed) drives the flow without colliding with the seeded
// Ibuprofen.

async function openFullAdd(page: Page) {
  await page.getByTestId("medication-add-toggle").click();
  await page.getByTestId("medication-add-full").click();
  const panel = page.getByTestId("medication-add-panel");
  await expect(panel).toBeVisible();
  return panel;
}

test("med form is medication-shaped and selection-prefills on pick (#846)", async ({
  page,
}) => {
  await page.goto("/medications");

  const addCard = await openFullAdd(page);

  // Placeholders teach medication semantics, not supplement ones.
  await expect(addCard.getByPlaceholder("e.g. Ibuprofen")).toBeVisible();
  await expect(addCard.getByPlaceholder("e.g. Advil")).toBeVisible();

  // Pick "Naproxen" from the name combobox (onPick fires the prefill; a bare fill
  // would not).
  await addCard.getByLabel("Name").fill("Naproxen");
  await addCard
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: "Naproxen" })
    .first()
    .click();

  // Prefill: PRN on (reveals the redose block), interval 8h / max 3, dose 220 mg —
  // each marked "from label defaults".
  const asNeeded = addCard.getByRole("checkbox", { name: /As needed/ });
  await expect(asNeeded).toBeChecked();
  await expect(addCard.getByTestId("prefill-badge").first()).toBeVisible();
  await expect(addCard.getByTestId("redose-interval")).toHaveValue("8");
  await expect(addCard.getByTestId("redose-max")).toHaveValue("3");
  await expect(addCard.getByLabel("Amount")).toHaveValue("220 mg");

  // Save with ZERO edits — the prefilled suggestion is a complete, valid medication.
  await addCard.getByRole("button", { name: "Add", exact: true }).click();

  // The new PRN medication lands as a current medication row that links to its
  // clinical-record detail page (the standard medication row shape).
  const row = medicationRow(page, "Naproxen");
  await expect(row).toBeVisible();
  await expect(medicationRowLink(page, "Naproxen")).toBeVisible();
  await expect(row.getByText("As Needed", { exact: true })).toBeVisible();
  await expect(medicationDoseSummary(row)).toHaveText("220 mg");
});

test("a newly catalogued med (#881) is pickable and prefills with zero code change", async ({
  page,
}) => {
  // Dextromethorphan is one of the systematic top-300 fills (issue #881, the #843
  // cough/cold aisle). It reaches the combobox + selection-prefill purely through the
  // data — no UI change — proving the #817/#846 data-driven design absorbs catalog
  // additions. Its `typical` block is PRN, so the pick flips As-needed on.
  await page.goto("/medications");
  const addCard = await openFullAdd(page);

  await addCard.getByLabel("Name").fill("Dextromethorphan");
  await addCard
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: "Dextromethorphan" })
    .first()
    .click();

  // The curated `typical` PRN convention prefills the As-needed toggle (marked).
  await expect(
    addCard.getByRole("checkbox", { name: /As needed/ })
  ).toBeChecked();
  await expect(addCard.getByTestId("prefill-badge").first()).toBeVisible();

  await addCard.getByRole("button", { name: "Add", exact: true }).click();

  const row = medicationRow(page, "Dextromethorphan");
  await expect(row).toBeVisible();
});

test("a user edit is never clobbered by a later pick (#846)", async ({
  page,
}) => {
  await page.goto("/medications");
  const addCard = await openFullAdd(page);

  // Turn PRN ON by hand first (touches the field), then pick a med whose label
  // convention is also PRN — the pick must not re-drive/override the touched toggle,
  // and (proving "touched") leaving it as the user set it.
  await addCard.getByRole("checkbox", { name: /As needed/ }).check();
  await addCard.getByLabel("Name").fill("Naproxen");
  await addCard
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: "Naproxen" })
    .first()
    .click();

  // Still checked (the user's own choice), and NOT marked "from label defaults" — the
  // resolver skipped the touched field.
  const asNeeded = addCard.getByRole("checkbox", { name: /As needed/ });
  await expect(asNeeded).toBeChecked();
  // Dose strength (untouched) still prefilled from the label.
  await expect(addCard.getByLabel("Amount")).toHaveValue("220 mg");
});

test("a pediatric formulation persists from quick add to the medication list", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_CHILD,
    password: E2E_MEMBER_PASSWORD,
  });

  try {
    await page.goto("/medications");
    await page.getByTestId("medication-add-toggle").click();
    const panel = page.getByTestId("medication-add-panel");
    const quickAdd = panel.getByTestId("quick-add-medication");

    // An unsupported medication says that its chart is unavailable rather than
    // silently looking like an adult/unknown profile.
    await panel.getByTestId("medication-add-full").click();
    const fullAdd = panel.getByRole("tabpanel");
    await fullAdd.getByLabel("Name").fill("Hydrocortisone");
    await expect(
      fullAdd.getByTestId("medication-pediatric-no-chart")
    ).toContainText("No pediatric label weight-band chart");
    await panel.getByTestId("medication-add-quick").click();

    await quickAdd.getByLabel("Medication").fill("Acetaminophen");
    await quickAdd
      .getByRole("listbox")
      .getByRole("button")
      .filter({ hasText: "Acetaminophen" })
      .first()
      .click();

    // The label lookup can record a fresh measurement in place. It writes through
    // the normal Body metric action in this login's preferred unit (kg for this
    // fixture), then immediately moves the recorded marker to the new label band.
    await quickAdd.getByTestId("pediatric-weight-update-open").click();
    const weightUpdate = quickAdd.getByTestId("pediatric-weight-update");
    await expect(weightUpdate.getByLabel("Weight (kg)")).toBeVisible();
    await expect(weightUpdate.getByLabel("Measured on")).not.toHaveValue("");
    await weightUpdate.getByLabel("Weight (kg)").fill("10");
    await weightUpdate.getByRole("button", { name: "Save" }).click();
    await expect(
      page.getByText("Weight updated", { exact: true })
    ).toBeVisible();
    await expect(weightUpdate).toHaveCount(0);

    // 10 kg ≈22 lb, below this committed label chart's first 24-lb band. This is a
    // weight-boundary refusal, not the medication's infant age-gate copy.
    await expect(quickAdd.getByTestId("quick-add-pediatric")).toContainText(
      "Recorded weight is 22 lb"
    );
    await expect(quickAdd.getByTestId("quick-add-pediatric")).toContainText(
      "chart starts at 24 lb"
    );
    await expect(quickAdd.getByTestId("quick-add-pediatric")).not.toContainText(
      "under 12 weeks"
    );
    // Refusing to infer a band does not hide the package-label chart. No band is
    // selected automatically for the below-chart weight, but every option remains
    // available for an explicit caregiver selection.
    const belowBandPicker = quickAdd.getByTestId("pediatric-band-picker");
    await expect(belowBandPicker).toBeVisible();
    await expect(
      belowBandPicker.getByTestId("pediatric-band-option")
    ).toHaveCount(5);
    await expect(
      belowBandPicker.getByRole("radio", { checked: true })
    ).toHaveCount(0);
    await expect(quickAdd.getByTestId("quick-add-amount")).toHaveValue("");
    await belowBandPicker.getByRole("radio").first().check();
    await expect(belowBandPicker.getByRole("radio").first()).toBeChecked();
    await expect(quickAdd.getByTestId("quick-add-amount")).toHaveValue(
      "160 mg"
    );

    // Move to an in-chart weight so the remainder of the band/formulation flow can
    // exercise the resolved state as before.
    await quickAdd.getByTestId("pediatric-weight-update-open").click();
    const secondWeightUpdate = quickAdd.getByTestId("pediatric-weight-update");
    await secondWeightUpdate.getByLabel("Weight (kg)").fill("16.8");
    await secondWeightUpdate.getByRole("button", { name: "Save" }).click();
    await expect(secondWeightUpdate).toHaveCount(0);

    const formulation = quickAdd.getByTestId("pediatric-formulation");
    await expect(formulation).toBeVisible();
    await expect(quickAdd).not.toContainText("Saved with this medication.");
    expect(
      await quickAdd
        .locator(
          '[data-testid="quick-add-pediatric"], [data-testid="quick-add-amount"]'
        )
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-testid"))
        )
    ).toEqual(["quick-add-pediatric", "quick-add-amount"]);
    await formulation.selectOption("childrens_susp_160_5");
    const bands = quickAdd.getByTestId("pediatric-band-option");
    await expect(bands).toHaveCount(5);
    await expect(bands.filter({ hasText: "Recorded weight" })).toContainText(
      /Recorded weight · 37 lb · .+ \(.+\)/
    );
    await bands.filter({ hasText: "36–47 lb" }).click();
    await expect(quickAdd.getByTestId("quick-add-amount")).toHaveValue(
      "240 mg"
    );
    await expect(bands.filter({ hasText: "36–47 lb" })).toContainText("7.5 mL");
    await quickAdd.getByRole("button", { name: "Quick add" }).click();

    const row = medicationRow(page, "Acetaminophen");
    // The shared compact formatter must show the SELECTED band's dose, not replace
    // every band with the product's fixed 160 mg / 5 mL concentration.
    await expect(prnTodayItem(page, "Acetaminophen")).toContainText(
      "240 mg / 7.5 mL"
    );
    await expect(row).toContainText("240 mg / 7.5 mL");
  } finally {
    await page.context().close();
  }
});
