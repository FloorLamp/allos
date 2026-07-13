import { test, expect } from "@playwright/test";

// Deterministic biomarker→food suggestions (issue #577). The e2e fixture
// (e2e/seed-events.ts) plants two currently-flagged-LOW diet-responsive readings on the
// seeded profile — Omega-3 Total and Folate — plus a synthetic "fish" allergy; the
// seed's Warfarin med supplies the medication screen. So the biomarker detail page's
// "Food sources" card must render, the omega-3 suggestion must SWAP to its algae/ALA
// alternative (allergy screen), and the folate suggestion must carry the vitamin-K
// consistency note (medication screen). Uses the shared authenticated storageState.

test("omega-3 detail page suggests fatty fish, swapped to the alternative for the fish allergy (#577)", async ({
  page,
}) => {
  await page.goto(
    `/biomarkers/view?name=${encodeURIComponent("Omega-3 Total (OmegaCheck)")}`
  );

  const card = page.getByTestId("biomarker-food-suggestions");
  await expect(card).toBeVisible();

  const suggestion = page.getByTestId("food-suggestion-omega-3");
  await expect(suggestion).toBeVisible();
  // Allergy screen: the fish source is withheld and the alternative surfaces.
  await expect(suggestion).toContainText("alternative");
  await expect(suggestion).toContainText(/walnut|flax|algae/i);
  await expect(suggestion).not.toContainText("salmon");
  // Framing.
  await expect(suggestion).toContainText("Informational, not medical advice");
});

test("folate detail page suggests leafy greens with the warfarin vitamin-K note (#577)", async ({
  page,
}) => {
  await page.goto(`/biomarkers/view?name=${encodeURIComponent("Folate")}`);

  const suggestion = page.getByTestId("food-suggestion-folate");
  await expect(suggestion).toBeVisible();
  await expect(suggestion).toContainText(/leafy greens|legumes/i);
  // Medication screen (food–drug inverse): the warfarin stack pins the vitamin-K note.
  await expect(suggestion).toContainText(/vitamin k/i);
});
