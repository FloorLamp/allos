import { test, expect } from "@playwright/test";

// #474: a silent-return validation guard + a trusting form used to produce a false
// "Saved ✓" toast over lost data. The ImmunizationForm's vaccine Combobox has no
// client-side required check, so submitting it blank hit updateImmunization/
// addImmunization's `!vaccineRaw` guard — which used to `return;` (an undefined
// resolve the form read as success), toasting "Immunization saved" and resetting
// while nothing persisted. Now the action answers `{ ok:false, error }` and the form
// surfaces it inline WITHOUT the success toast.
test("submitting the immunization form with a blank vaccine shows an inline error, not a false 'saved' toast (#474)", async ({
  page,
}) => {
  await page.goto("/records#immunizations");

  const form = page
    .locator("form")
    .filter({ has: page.getByRole("heading", { name: "Add immunization" }) });
  await expect(form).toBeVisible();

  // The date field is pre-filled (defaultDate), so it passes; the vaccine combobox
  // starts empty and has no client-side required guard — submit hits the server
  // validation guard.
  await form.getByRole("button", { name: "Add", exact: true }).click();

  // The typed error is surfaced inline…
  await expect(form.getByRole("alert")).toBeVisible();
  await expect(form.getByRole("alert")).toContainText(/vaccine/i);

  // …and the false success toast NEVER appears.
  await expect(page.getByText("Immunization saved")).toHaveCount(0);
});
