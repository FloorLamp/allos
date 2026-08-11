import { test, expect } from "./fixtures";
import { followLink, hydratedClick, settledClick } from "./helpers";

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
  await page.goto("/results/readings/view?name=VO2%20Max");

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
  // Log a grip-strength reading through the guided Fitness check on /training — the
  // ASSESSMENT-cadence entry surface these three markers moved to in #1486 (they
  // left the daily measurements form; canonical storage is unchanged, which
  // lib/__action_tests__/measurements.actions.test.ts pins). The date defaults to
  // today, so a wide biomarkers window includes it.
  await page.goto("/training?tab=fitness");
  await hydratedClick(page, page.getByTestId("fitness-tile-grip"));
  const modal = page.getByTestId("fitness-entry-grip");
  await expect(modal).toBeVisible();
  await modal.getByTestId("fitness-value-grip").fill("48");
  await settledClick(page, modal.getByTestId("fitness-submit-grip"));

  // The reading surfaces on its canonical detail page WITH the percentile card
  // (profile 1 is an adult with a known sex + age).
  await page.goto("/results/readings/view?name=Grip%20Strength");
  const main = page.getByRole("main");
  await expect(
    main.getByRole("heading", { name: "Grip Strength" })
  ).toBeVisible();
  await expect(main.getByTestId("fitness-percentile")).toBeVisible();
  await expect(main.getByTestId("fitness-percentile")).toContainText(
    "percentile"
  );
});

// #2086: a judged quantity needs a declared knowledge source AND a surface its
// readings actually reach. VO₂ max had both — the FRIEND percentile and the reading
// detail page above — but the surface was reachable only by knowing to search the
// biomarkers list, while the value is MEASURED in the Fitness check. This is the
// reach: the check links a measured clinical test to the surface that interprets it,
// through `readingDetailHref` (the one #1932 cadence-routing rule).
test("the Fitness check reaches the surface that judges a measured test (#2086)", async ({
  page,
}) => {
  await page.goto("/training?tab=fitness");
  await hydratedClick(page, page.getByTestId("fitness-tile-vo2max"));

  const modal = page.getByTestId("fitness-entry-vo2max");
  await expect(modal).toBeVisible();
  await followLink(
    page,
    modal.getByTestId("fitness-history-vo2max"),
    /\/biomarkers\/view/
  );

  // The destination is the declared surface, with the age/sex percentile on it.
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "VO2 Max" })).toBeVisible();
  await expect(main.getByTestId("fitness-percentile")).toBeVisible();
});
