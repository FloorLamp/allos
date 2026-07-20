import { test, expect } from "@playwright/test";
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
//      #protocols hub (templates strip + add form).
//   2. The dashboard widget's pillar cards deep-link to /longevity#<anchor>.
//   3. Absent pillars don't render: the activity-free EMPTY_TRAINING fixture
//      (#809 — nothing logged at all) gets NO pillar sections, only the
//      always-present interventions section. Read-only on that fixture, so it
//      never perturbs the training-first-run spec's empty contract.
//   4. The old /protocols hub URL permanently redirects into #protocols.
// All reads — no mutations — so the spec is repeat-safe and contention-free.

test("every section renders for the seeded profile (#1042 phase 4)", async ({
  page,
}) => {
  test.slow(); // next dev compiles the route on first hit
  await page.goto("/longevity");
  const main = page.getByRole("main");

  // §1 BioAge — the reused hero (value + delta + estimate note).
  const bioAge = main.getByTestId("longevity-bio-age");
  await expect(bioAge).toBeVisible();
  await expect(bioAge.getByTestId("bio-age-hero")).toBeVisible();
  await expect(bioAge.getByTestId("bio-age-value")).toBeVisible();

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
    biomarkers.getByTestId("longevity-biomarker-row").first()
  ).toBeVisible();

  // §5 Protocols — the absorbed hub: templates strip + add form present.
  const protocols = main.getByTestId("longevity-protocols");
  await expect(protocols).toBeVisible();
  await expect(protocols.getByTestId("protocol-templates")).toBeVisible();
  await expect(protocols.getByTestId("protocol-form")).toBeVisible();
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
    // The interventions section (and its create form) is the one constant.
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

test("the old /protocols hub URL permanently redirects into #protocols", async ({
  page,
}) => {
  await page.goto("/protocols");
  await expect(page).toHaveURL(/\/longevity#protocols$/);
  await expect(
    page.getByRole("main").getByTestId("protocol-templates")
  ).toBeVisible();
});
