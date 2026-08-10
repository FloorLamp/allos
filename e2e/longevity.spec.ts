import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_EMPTY_TRAINING,
} from "./fixture-logins";

// The Longevity page (#1042 phase 4): the expanded formatter over the SAME
// healthspan-pillar model the dashboard widget compact-renders.
//   1. Every section renders for seeded profile 1 (it owns a complete PhenoAge
//      panel, a VO2 Max reading, nightly sleep sessions, labs with curated
//      ranges, and two guided fitness checks) — including the absorbed
//      #protocols hub (collapsed add form).
//   2. The dashboard widget's pillar cards deep-link to /longevity#<anchor>.
//   3. Absent pillars don't render: the activity-free EMPTY_TRAINING fixture
//      (#809 — nothing logged at all) gets NO pillar sections, only the
//      always-present interventions section. Read-only on that fixture, so it
//      never perturbs the training-first-run spec's empty contract.
// All reads — no mutations — so the spec is repeat-safe and contention-free.

test("every section renders for the seeded profile (#1042 phase 4)", async ({
  page,
}) => {
  test.slow(); // next dev compiles the route on first hit
  await page.goto("/longevity");
  const main = page.getByRole("main");

  // §1 BioAge — the hero, which since #2367 renders HERE and nowhere else (value +
  // delta + estimate note), plus the #2366 per-input breakdown.
  const bioAge = main.getByTestId("longevity-bio-age");
  await expect(bioAge).toBeVisible();
  const hero = bioAge.getByTestId("bio-age-hero");
  await expect(hero).toBeVisible();
  await expect(hero.getByTestId("bio-age-value")).toBeVisible();

  // What moves the number (#2366): the nine analytes PLUS chronological age, each
  // with an effect in years against a stated reference, ranked by magnitude. Age is
  // in the list rather than hidden — it is usually the largest term, and seeing that
  // is what stops the number reading as a verdict on the labs alone.
  const inputs = hero.getByTestId("bio-age-input");
  await expect(inputs).toHaveCount(10);
  await expect(inputs.filter({ hasText: "Chronological age" })).toHaveCount(1);
  // Every row states an effect; the first one is the largest by construction.
  await expect(hero.getByTestId("bio-age-effect")).toHaveCount(10);
  await expect(inputs.first()).toContainText(/[+−±]\d+\.\d yr/); // first-ok: the ranked list's leading row IS the assertion
  // The copy frames it as a property of the MODEL, never as advice.
  await expect(hero).toContainText("re-runs the whole model");
  await expect(hero).toContainText("not predictions about you");

  // §2 Fitness — pillar stat(s) + the read view over fitness_assessments with
  // the "run a check" deep link into Training.
  const fitness = main.getByTestId("longevity-fitness");
  await expect(fitness).toBeVisible();
  await expect(fitness.getByTestId("longevity-pillar-vo2max")).toBeVisible();
  await expect(main.getByTestId("longevity-run-check")).toHaveAttribute(
    "href",
    "/training?tab=fitness"
  );
  // The seeded guided checks give per-domain percentile bars.
  await expect(
    fitness.getByTestId("longevity-fitness-domain-endurance")
  ).toBeVisible();

  // §3 Sleep regularity — the SRI pillar expanded.
  const sleep = main.getByTestId("longevity-sleep");
  await expect(sleep).toBeVisible();
  await expect(
    sleep.getByTestId("longevity-pillar-sleep-regularity")
  ).toBeVisible();

  // §4 Optimal-share biomarkers — the pillar plus the judged-marker breakdown.
  const biomarkers = main.getByTestId("longevity-biomarkers");
  await expect(biomarkers).toBeVisible();
  await expect(
    biomarkers.getByTestId("longevity-pillar-optimal-biomarkers")
  ).toBeVisible();
  await expect(
    biomarkers.getByTestId("longevity-biomarker-row").first() // first-ok: asserts a biomarker row renders in the scoped longevity section — order-agnostic presence
  ).toBeVisible();

  // §5 Protocols — the absorbed hub: rare-cadence creation stays collapsed.
  const protocols = main.getByTestId("longevity-protocols");
  await expect(protocols).toBeVisible();
  await expect(protocols.getByTestId("protocol-templates")).toHaveCount(0);
  await expect(protocols.getByTestId("protocol-form")).toHaveCount(0);
  await expect(protocols.getByTestId("new-protocol-toggle")).toBeVisible();
  await expect(
    protocols.getByTestId("longevity-wellness-link")
  ).toHaveAttribute("href", "/wellness");
});

test("dashboard pillar cards deep-link to the Longevity anchors", async ({
  page,
}) => {
  await page.goto("/");
  const widget = page
    .getByRole("main")
    .getByTestId("healthspan-pillars-widget");
  await expect(widget).toBeVisible();
  // Seed profile 1 has labs, so the optimal-biomarkers pillar is available; its
  // card must land on the page section that expands it (pillarHref).
  await expect(widget.getByTestId("pillar-optimal-biomarkers")).toHaveAttribute(
    "href",
    "/longevity#biomarkers"
  );
});

test("absent pillars drop their sections; the interventions section always renders", async ({
  browser,
}) => {
  // The nothing-logged fixture (#809): no labs, no sleep, no fitness data — so
  // NO pillar is in the model and no pillar section may render (the membership
  // stance: a section belongs iff it's a pillar in the model or an intervention
  // against one). Read-only here.
  const page = await loginAs(browser, {
    username: E2E_LOGIN_EMPTY_TRAINING,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/longevity");
    const main = page.getByRole("main");
    // The interventions section (and its collapsed creation entry) is constant.
    await expect(main.getByTestId("longevity-protocols")).toBeVisible();
    await expect(main.getByTestId("longevity-empty")).toBeVisible();
    await expect(main.getByTestId("longevity-bio-age")).toHaveCount(0);
    await expect(main.getByTestId("longevity-fitness")).toHaveCount(0);
    await expect(main.getByTestId("longevity-sleep")).toHaveCount(0);
    await expect(main.getByTestId("longevity-biomarkers")).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});
