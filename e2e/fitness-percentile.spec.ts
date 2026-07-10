import { test, expect } from "@playwright/test";

// #158: VO2 Max (and the functional fitness markers) gain an age/sex PERCENTILE +
// FITNESS AGE context, computed from the baked FRIEND/Dodds/etc. norms in
// lib/fitness-norms.json. The seeded adult (profile 1) is male with a birthdate, so
// their seeded VO2 Max detail page must render the percentile card. The gate
// (hidden when sex/age unset, or for a child) is covered exhaustively by the pure
// unit tests (lib/__tests__/fitness-norms.test.ts) — driving the settings form to
// unset sex here would be brittle, so the e2e asserts the positive render only.

test("VO2 Max detail shows the age/sex percentile + fitness age (#158)", async ({
  page,
}) => {
  // The seed logs a VO2 Max series for the adult under the canonical name "VO2 Max".
  await page.goto("/biomarkers/view?name=VO2%20Max");

  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "VO2 Max" })).toBeVisible();

  const card = main.getByTestId("fitness-percentile");
  await expect(card).toBeVisible();
  // The percentile phrase ("Nth percentile") and the fitness-age label render.
  await expect(card).toContainText("percentile");
  await expect(card).toContainText("Fitness age");
});

test("the functional fitness markers are manually enterable and percentile-contextualized (#158)", async ({
  page,
}) => {
  // Log a grip-strength reading via the Trends → Body "Log vitals" quick-add (the
  // manual-entry machinery the three functional markers were wired into). The date
  // defaults to today, so a wide biomarkers window includes it.
  await page.goto("/trends?tab=body");
  const form = page.getByTestId("vitals-quick-add");
  await expect(form).toBeVisible();
  await form.getByLabel("Grip strength (kg)").fill("48");
  await form.getByRole("button", { name: "Save vitals" }).click();
  await expect(page.getByText("Vitals saved")).toBeVisible();

  // The reading surfaces on its canonical detail page WITH the percentile card
  // (profile 1 is an adult with a known sex + age).
  await page.goto("/biomarkers/view?name=Grip%20Strength");
  const main = page.getByRole("main");
  await expect(
    main.getByRole("heading", { name: "Grip Strength" })
  ).toBeVisible();
  await expect(main.getByTestId("fitness-percentile")).toBeVisible();
  await expect(main.getByTestId("fitness-percentile")).toContainText(
    "percentile"
  );
});
