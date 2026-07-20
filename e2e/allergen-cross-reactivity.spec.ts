import { test, expect } from "@playwright/test";

// Allergen cross-reactivity notes (issue #153). The seeded profile carries a
// synthetic allergen-specific IgE result ("Birch IgE", RAST class 3), which the
// allergies view surfaces as a Birch sensitization. The shared pure matcher
// (lib/allergen-cross-reactivity) then places it in the birch oral-allergy-
// syndrome family, so both the Allergies page and the passport allergy view show
// the same informational cross-reactivity note. Uses the shared authenticated
// storageState.

test("Allergies page shows the birch cross-reactivity note (#153)", async ({
  page,
}) => {
  await page.goto("/records#allergies");

  const panel = page.getByTestId("cross-reactivity");
  await expect(panel).toBeVisible();

  const item = page.getByTestId("cross-reactivity-item").first();
  await expect(item).toContainText("Birch");
  await expect(item).toContainText("commonly cross-reacts with");
  // Well-known oral-allergy-syndrome cross-reactants from the curated dataset.
  await expect(item).toContainText("apple");
  await expect(item).toContainText("hazelnut");
});

test("Passport allergy view shows the same cross-reactivity note (#153)", async ({
  page,
}) => {
  await page.goto("/profile");

  const panel = page.getByTestId("cross-reactivity");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Birch");
  await expect(panel).toContainText("commonly cross-reacts with");
  await expect(panel).toContainText("apple");
});
