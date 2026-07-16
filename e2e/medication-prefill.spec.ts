import { test, expect } from "@playwright/test";

// #846 medication form split + selection prefill. The Medications page renders the
// real MedicationForm (not a supplement-shaped shared body): its placeholders are
// medication-shaped, and picking a catalogued med from the name combobox PRE-FILLS
// every knowable field as an editable, marked suggestion (PRN toggle, dose strength,
// interval/max, food timing) from the curated datasets — so a pick → save with ZERO
// edits produces a valid medication row. Naproxen (curated `typical` + OTC PRN
// defaults, not in the seed) drives the flow without colliding with the seeded
// Ibuprofen.

test("med form is medication-shaped and selection-prefills on pick (#846)", async ({
  page,
}) => {
  await page.goto("/medications");

  const addCard = page
    .locator("div.card")
    .filter({ hasText: "Add medication" });
  await expect(addCard).toBeVisible();

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
  const row = page
    .getByTestId("medication-row")
    .filter({ hasText: "Naproxen" })
    .first();
  await expect(row).toBeVisible();
  await expect(row.getByTestId("medication-row-link")).toBeVisible();
});

test("a user edit is never clobbered by a later pick (#846)", async ({
  page,
}) => {
  await page.goto("/medications");
  const addCard = page
    .locator("div.card")
    .filter({ hasText: "Add medication" });

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
