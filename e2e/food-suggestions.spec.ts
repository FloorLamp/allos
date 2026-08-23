import { test, expect } from "./fixtures";
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
    `/results/clinical-results/view?name=${encodeURIComponent("Omega-3 Total (OmegaCheck)")}`
  );

  const card = page.getByTestId("biomarker-food-suggestions");
  await expect(card).toBeVisible();

  const suggestion = page.getByTestId("food-suggestion-omega-3");
  await expect(suggestion).toBeVisible();
  // Allergy screen: the fish source is withheld and the alternative surfaces.
  await expect(suggestion).toContainText("alternative");
  await expect(suggestion).toContainText(/walnut|flax|algae/i);
  await expect(suggestion).not.toContainText("salmon");
  // Framing: no disclaimer boilerplate on the suggestion (moved to /disclaimer, #1049).
  await expect(suggestion).not.toContainText(
    "Informational, not medical advice"
  );
});

test("folate detail page suggests leafy greens with the warfarin vitamin-K note (#577)", async ({
  page,
}) => {
  await page.goto(
    `/results/clinical-results/view?name=${encodeURIComponent("Folate")}`
  );

  const suggestion = page.getByTestId("food-suggestion-folate");
  await expect(suggestion).toBeVisible();
  await expect(suggestion).toContainText(/leafy greens|legumes/i);
  // Medication screen (food–drug inverse): the warfarin stack pins the vitamin-K note.
  await expect(suggestion).toContainText(/vitamin k/i);
});

test("selenium detail page suggests brazil nuts — expanded low-nutrient coverage (#774)", async ({
  page,
}) => {
  await page.goto(
    `/results/clinical-results/view?name=${encodeURIComponent("Selenium")}`
  );

  const suggestion = page.getByTestId("food-suggestion-selenium");
  await expect(suggestion).toBeVisible();
  await expect(suggestion).toContainText(/brazil/i);
  await expect(suggestion).toContainText("Selenium is low — eat more:");
});

test("high LDL detail page shows a REDUCE suggestion (cut back on limit-tier foods) (#775)", async ({
  page,
}) => {
  await page.goto(
    `/results/clinical-results/view?name=${encodeURIComponent("LDL Cholesterol")}`
  );

  const suggestion = page.getByTestId("food-suggestion-ldl-apob");
  await expect(suggestion).toBeVisible();
  // Reduce framing (the other direction of the ONE engine): one reason + action line.
  await expect(suggestion).toHaveAttribute("data-direction", "reduce");
  await expect(suggestion).toContainText(/ is high — eat less:/);
  await expect(suggestion).toContainText(/fried|processed/i);
  await expect(suggestion).not.toContainText(
    "Informational, not medical advice"
  );

  // The #2754 add-on-high twin on the same page: the same high LDL also earns an ADD
  // (soluble fiber), rendered as its own card whose copy names the flag's real side.
  const add = page.getByTestId("food-suggestion-soluble-fiber");
  await expect(add).toBeVisible();
  await expect(add).toHaveAttribute("data-direction", "add");
  await expect(add).toContainText(/is high — eat more:/);
  await expect(add).toContainText(/oats/i);
});

test("the mechanism paragraph and its regulatory cite sit behind 'Why this works' (#3497)", async ({
  page,
}) => {
  // Two full screens of prose on a lab page is what the phone review met. The
  // provenance stays FINDABLE — a native <details>, so this asserts the fold, not a
  // deletion — and the parts that are about the reader stay open.
  await page.goto(
    `/results/clinical-results/view?name=${encodeURIComponent("Selenium")}`
  );

  const suggestion = page.getByTestId("food-suggestion-selenium");
  await expect(suggestion).toBeVisible();

  const why = page.getByTestId("food-suggestion-why-selenium");
  await expect(why).toBeVisible();
  // Closed on arrival: the source cite is in the DOM (find-in-page reaches it) and
  // not on screen.
  const cite = why.locator("p");
  await expect(cite).toContainText("Source:");
  await expect(cite).toBeHidden();

  // The headline, the foods and the advisory never fold.
  await expect(suggestion).toContainText("Selenium is low — eat more:");
  await expect(
    suggestion.getByTestId("food-suggestion-foods-selenium")
  ).toBeVisible();

  await page.getByTestId("food-suggestion-why-toggle-selenium").click();
  await expect(cite).toBeVisible();
});

test("the headline names each trigger once and never shouts the side (#3497)", async ({
  page,
}) => {
  await page.goto(
    `/results/clinical-results/view?name=${encodeURIComponent("LDL Cholesterol")}`
  );
  const headline = page.getByTestId("food-suggestion-headline-ldl-apob");
  await expect(headline).toBeVisible();
  // The verdict is carried by the card's amber tone; the words stop repeating it in
  // capitals. (The trigger names themselves keep their stored casing — a display
  // casing pass over a clinical name is what copy.md §9 rules out.)
  await expect(headline).not.toContainText("HIGH");
  await expect(headline).toContainText(
    / is high — eat less:$| are high — eat less:$/
  );
});
