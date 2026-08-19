import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { E2E_LOGIN_CHILD, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { workerDbPath } from "./worker-env";
import {
  medicationRow,
  medicationRowLink,
  medicationDoseSummary,
  prnTodayItem,
} from "./med-card-helpers";
import { closeEditor, openFact, setObligation } from "./intake-form-helpers";

// #846 selection prefill, on the one intake form (#3216). The Medications page's form
// is medication-shaped by DERIVED KIND rather than by which file it is: its
// placeholders are medication-shaped, and picking a catalogued med PRE-FILLS
// every knowable field as an editable, marked suggestion (obligation, dose strength,
// interval/max, food timing) from the curated datasets — so a pick → save with ZERO
// edits produces a valid medication row. Naproxen (curated `typical` + OTC PRN
// defaults, not in the seed) drives the flow without colliding with the seeded
// Ibuprofen.

// #1677 fixture: a medication + brand this spec owns and deletes.
const RANK_MED = "Cetirizine";
const RANK_BRAND = "Zyrtec";

async function openFullAdd(page: Page) {
  await page.getByTestId("medication-add-toggle").click();
  const panel = page.getByTestId("medication-add-panel");
  await expect(panel).toBeVisible();
  return panel;
}

test("med form is medication-shaped and selection-prefills on pick (#846)", async ({
  page,
}) => {
  await page.goto("/medications");

  const addCard = await openFullAdd(page);

  // The name placeholder teaches medication semantics, not supplement ones (#846).
  await expect(addCard.getByPlaceholder("e.g. Ibuprofen")).toBeVisible();

  // Pick "Naproxen" from the name combobox (onPick fires the prefill; a bare fill
  // would not).
  await addCard.getByLabel("Name").fill("Naproxen");
  await addCard
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: "Naproxen" })
    .first() // first-ok: transient combobox list this spec just opened (Naproxen suggestion); first match is intended
    .click();

  // A kind-locked door answers the kind outright, so no chip and no question (#3216) —
  // but the form is still medication-shaped, and says which shape it is.
  await expect(addCard.getByTestId("intake-item-form")).toHaveAttribute(
    "data-kind",
    "medication"
  );
  await expect(addCard.getByTestId("intake-kind-chip")).toHaveCount(0);

  // Prefill, read off the SUMMARY the form will save: as-needed, interval 8h / max 3,
  // dose 220 mg — marked "from label defaults", because a prefilled value is an
  // editable suggestion and not a fact the person stated (#846).
  // #1505: the as-needed checkbox became the obligation, so "as needed" IS `may`.
  await expect(addCard.getByTestId("intake-fact-importance")).toContainText(
    "as needed"
  );
  await expect(addCard.getByTestId("intake-fact-timing")).toContainText("8");
  await expect(addCard.getByTestId("intake-fact-timing")).toContainText("3");
  await expect(addCard.getByTestId("intake-fact-dose")).toContainText("220 mg");
  await expect(addCard.getByTestId("prefill-badge").first()).toBeVisible(); // first-ok: asserts a prefill badge renders on the add card — order-agnostic presence

  // And the same values really are the fields behind those chips.
  const timing = await openFact(page, "timing", addCard);
  await expect(timing.getByTestId("redose-interval")).toHaveValue("8");
  await expect(timing.getByTestId("redose-max")).toHaveValue("3");
  await closeEditor(page, addCard);

  // Save with ZERO further edits — the prefilled suggestion is a complete medication.
  await addCard.getByRole("button", { name: "Add", exact: true }).click();

  // The new PRN medication lands as a current medication row that links to its
  // clinical-record detail page (the standard medication row shape).
  // This test adds a "Naproxen" med with no cleanup, so a --repeat-each run accumulates
  // same-named rows on the shared profile — narrow to the leading match.
  const row = medicationRow(page, "Naproxen").first(); // first-ok: accumulating fixture row
  await expect(row).toBeVisible();
  await expect(medicationRowLink(row)).toBeVisible();
  await expect(row.getByText("As needed", { exact: true })).toBeVisible();
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
    .first() // first-ok: transient combobox list this spec just opened (Dextromethorphan suggestion); first match is intended
    .click();

  // The curated `typical` PRN convention prefills the obligation as `may` (marked).
  await expect(addCard.getByTestId("intake-fact-importance")).toContainText(
    "as needed"
  );
  await expect(addCard.getByTestId("prefill-badge").first()).toBeVisible(); // first-ok: asserts a prefill badge renders on the add card — order-agnostic presence

  await addCard.getByRole("button", { name: "Add", exact: true }).click();

  // Added with no cleanup, so --repeat-each accumulates same-named rows.
  const row = medicationRow(page, "Dextromethorphan").first(); // first-ok: accumulating fixture row
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
  await setObligation(page, "may", addCard);
  await addCard.getByLabel("Name").fill("Naproxen");
  await addCard
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: "Naproxen" })
    .first() // first-ok: transient combobox list this spec just opened (Naproxen suggestion); first match is intended
    .click();

  // Still as-needed (the user's own choice), and the importance chip is NOT marked
  // "from label defaults" — the resolver skipped the touched field.
  const importance = addCard.getByTestId("intake-fact-importance");
  await expect(importance).toContainText("as needed");
  await expect(importance.getByTestId("prefill-badge")).toHaveCount(0);
  // Dose strength (untouched) still prefilled from the label, and marked as such.
  const dose = addCard.getByTestId("intake-fact-dose");
  await expect(dose).toContainText("220 mg");
  await expect(dose.getByTestId("prefill-badge")).toHaveCount(1);
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
    const quickAdd = panel.getByTestId("intake-item-form");

    // An unsupported medication says that its chart is unavailable rather than
    // silently looking like an adult/unknown profile.
    await quickAdd.getByLabel("Name").fill("Hydrocortisone");
    await expect(
      quickAdd.getByTestId("medication-pediatric-no-chart")
    ).toContainText("No pediatric label weight-band chart");

    await quickAdd.getByLabel("Name").fill("Acetaminophen");
    await quickAdd
      .getByRole("listbox")
      .getByRole("button")
      .filter({ hasText: "Acetaminophen" })
      .first() // first-ok: transient combobox list this spec just opened (Acetaminophen suggestion); first match is intended
      .click();

    // The pediatric label block is the dose fact's editor now; the caregiver opens the
    // dose to work the weight band, and the formulation is the chip row above it.
    await openFact(page, "dose", panel);

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
    await expect(quickAdd.getByTestId("pediatric-suggestion")).toContainText(
      "Recorded weight is 22 lb"
    );
    await expect(quickAdd.getByTestId("pediatric-suggestion")).toContainText(
      "chart starts at 24 lb"
    );
    await expect(
      quickAdd.getByTestId("pediatric-suggestion")
    ).not.toContainText("under 12 weeks");
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
    await expect(quickAdd.getByLabel("Amount").first()).toHaveValue(""); // first-ok: the single dose row of this add form
    await belowBandPicker.getByRole("radio").first().check(); // first-ok: the first option in this spec's own below-band picker
    await expect(belowBandPicker.getByRole("radio").first()).toBeChecked(); // first-ok: the same first below-band-picker option, asserted checked
    await expect(quickAdd.getByLabel("Amount").first()).toHaveValue("160 mg"); // first-ok: the single dose row of this add form

    // Move to an in-chart weight so the remainder of the band/formulation flow can
    // exercise the resolved state as before.
    await quickAdd.getByTestId("pediatric-weight-update-open").click();
    const secondWeightUpdate = quickAdd.getByTestId("pediatric-weight-update");
    await secondWeightUpdate.getByLabel("Weight (kg)").fill("16.8");
    await secondWeightUpdate.getByRole("button", { name: "Save" }).click();
    await expect(secondWeightUpdate).toHaveCount(0);

    // The formulation is a derived CHIP ROW beside the kind, not a select buried in
    // the band picker — one datum, one control.
    const formulation = quickAdd.getByTestId("intake-formulation-row");
    await expect(formulation).toBeVisible();
    await expect(quickAdd).not.toContainText("Saved with this medication.");
    expect(
      await quickAdd
        .locator(
          '[data-testid="pediatric-suggestion"], [data-testid="pediatric-band-picker"]'
        )
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-testid"))
        )
    ).toEqual(["pediatric-suggestion", "pediatric-band-picker"]);
    await formulation
      .getByTestId("intake-formulation-choice")
      .filter({ hasText: "Children's oral suspension" })
      .click();
    // The formulation row sits ABOVE the facts and never closes the open editor, so
    // the band picker is still on screen — the switch re-derives inside it.
    const bands = quickAdd.getByTestId("pediatric-band-option");
    await expect(bands).toHaveCount(5);
    await expect(bands.filter({ hasText: "Recorded weight" })).toContainText(
      /Recorded weight · 37 lb · .+ \(.+\)/
    );
    await bands.filter({ hasText: "36–47 lb" }).click();
    await expect(quickAdd.getByLabel("Amount").first()).toHaveValue("240 mg"); // first-ok: the single dose row of this add form
    await expect(bands.filter({ hasText: "36–47 lb" })).toContainText("7.5 mL");
    await closeEditor(page, panel);
    await quickAdd.getByRole("button", { name: "Add", exact: true }).click();

    // The child fixture profile accumulates "Acetaminophen" rows across a --repeat-each
    // run (no cleanup), so narrow to the leading match on both surfaces.
    const row = medicationRow(page, "Acetaminophen").first(); // first-ok: accumulating fixture row
    // The shared compact formatter must show the SELECTED band's dose, not replace
    // every band with the product's fixed 160 mg / 5 mL concentration.
    await expect(
      prnTodayItem(page, "Acetaminophen").first() // first-ok: see the row narrowing above
    ).toContainText("240 mg / 7.5 mL");
    await expect(row).toContainText("240 mg / 7.5 mL");
  } finally {
    await page.context().close();
  }
});

// ---------------------------------------------------------------------------
// #1677 — the picker's ORDER is the whole affordance. The Combobox shows 8 rows and
// an empty query keeps source order, so the option array's first eight entries ARE
// the medication picker. Alphabetical over 242 curated generics showed a household
// Adalimumab and Alendronate; ranked, it shows what this profile actually takes.
// ---------------------------------------------------------------------------

// The visible option labels of the combobox that is currently open, in DOM order.
async function openOptionLabels(scope: Locator, field: string) {
  await scope.getByLabel(field).click();
  const listbox = scope.page().getByRole("listbox");
  await expect(listbox).toBeVisible();
  return (await listbox.getByRole("button").allInnerTexts()).map((t) =>
    t.trim()
  );
}

test("the medication picker opens on this profile's own medications (#1677)", async ({
  page,
}) => {
  await page.goto("/medications");
  const addCard = await openFullAdd(page);

  const full = await openOptionLabels(addCard, "Name");

  // Ibuprofen is on the seeded regimen, so usage floats it into the visible eight —
  // the curated head can only put Acetaminophen ahead of it, whatever else this
  // worker's database has accumulated.
  expect(full.some((label) => label.startsWith("Ibuprofen"))).toBe(true);
  // Adalimumab led the alphabetical list purely by spelling. A household picker that
  // opens on a biologic is the bug.
  expect(full.some((label) => label.startsWith("Adalimumab"))).toBe(false);

  // The old "one options source, both call sites" half of this test (#221) is gone
  // with the second call site: #3216 leaves ONE form, so the quick head and the full
  // head cannot disagree — there is only one.
});

test("recording a medication promotes it and its brand into the pickers (#1677)", async ({
  page,
}) => {
  // Spec-owned fixture: Cetirizine/Zyrtec is nowhere near the head of either flat
  // list (Zyrtec is the LAST brand alphabetically), so seeing it proves usage ranking
  // rather than a coincidence of spelling.
  const db = new Database(workerDbPath());
  try {
    db.prepare(
      `INSERT INTO intake_items (profile_id, name, brand, kind, active, obligation,
                                 condition, source)
       VALUES (1, ?, ?, 'medication', 1, 'should', 'daily', 'manual')`
    ).run(RANK_MED, RANK_BRAND);
  } finally {
    db.close();
  }

  try {
    await page.goto("/medications");
    const addCard = await openFullAdd(page);

    const names = await openOptionLabels(addCard, "Name");
    expect(names.some((label) => label.startsWith(RANK_MED))).toBe(true);

    // The BRAND field before any name is picked: the profile's own brands lead, so
    // the person who reaches for Brand first is not stranded in the A's. It lives
    // behind the identity fact now.
    await page.keyboard.press("Escape");
    const identity = await openFact(page, "identity", addCard);
    // Still a MEDICATION brand list, whichever fact it sits behind (#846).
    await expect(identity.getByPlaceholder("e.g. Advil")).toBeVisible();
    const brands = await openOptionLabels(identity, "Brand");
    expect(brands[0]).toBe("Generic");
    expect(brands).toContain(RANK_BRAND);
  } finally {
    const cleanup = new Database(workerDbPath());
    try {
      cleanup
        .prepare("DELETE FROM intake_items WHERE profile_id = 1 AND name = ?")
        .run(RANK_MED);
    } finally {
      cleanup.close();
    }
  }
});
