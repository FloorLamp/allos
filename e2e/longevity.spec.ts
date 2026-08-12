import { test, expect } from "./fixtures";
import { followLink } from "./helpers";
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
//   2. The dashboard widget's pillar cards deep-link to /longevity#<anchor> —
//      except the strength pillar, whose destination is DATA (#1921): it names a
//      lift, so its tap lands on the Analyze panel for THAT lift.
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
  // #1921 — the strength pillar names the lift it judges you on, so this section
  // links onward to THAT lift's evidence. The vo2max pillar beside it is expanded
  // here and carries no such link.
  const strength = fitness.getByTestId("longevity-pillar-strength");
  await expect(strength).toBeVisible();
  await expect(strength).toContainText("Deadlift"); // the lift the claim names
  await expect(
    fitness.getByTestId("longevity-pillar-strength-link")
  ).toHaveAttribute(
    "href",
    "/training?tab=analyze&kind=strength&item=Deadlift"
  );
  await expect(fitness.getByTestId("longevity-pillar-vo2max-link")).toHaveCount(
    0
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

// #1921 — the strength pillar is the one whose destination is DATA: it names a lift, and
// the tap has to produce the EVIDENCE for that claim rather than the pillar's own
// explainer anchor. Landing on a generic index the reader then searches would be the
// defect restated, so this drives the whole hop and asserts what arrives.
test("the strength pillar card lands on the panel for the lift it names", async ({
  page,
}) => {
  await page.goto("/");
  const card = page
    .getByRole("main")
    .getByTestId("healthspan-pillars-widget")
    .getByTestId("pillar-strength");
  await expect(card).toBeVisible();
  // The claim: a level, for a named lift. Both come off one computation.
  await expect(card).toContainText("Intermediate");
  await expect(card).toContainText("Deadlift");
  await expect(card).toHaveAttribute(
    "href",
    "/training?tab=analyze&kind=strength&item=Deadlift"
  );

  // followLink, not hydratedClick: this click NAVIGATES, and the two helpers guard
  // different races. hydratedClick waits for React's markers on the node and clicks
  // ONCE, which is exactly right for a toggle a retry would undo — a link has no such
  // hazard and a different one instead. Playwright reports a click on a link a prior
  // attempt already navigated away from as "detached", and a click that lands before
  // the router is ready leaves the URL assertion to time out with no trace of why.
  // followLink is the blessed helper for that, and it asserts the destination as it
  // goes, so the separate toHaveURL is redundant.
  await followLink(
    page,
    card,
    /\/training\?tab=analyze&kind=strength&item=Deadlift$/
  );
  const main = page.getByRole("main");
  // The Benchmarks ladder for THAT lift, at the level the pillar claimed.
  await expect(main.getByText("Benchmarks", { exact: true })).toBeVisible();
  await expect(
    main.getByText("Deadlift estimated 1RM progression", { exact: false })
  ).toBeVisible();
  await expect(main.getByText("Intermediate").first()).toBeVisible(); // first-ok: the level appears on the ladder and in its header — either proves the standing arrived
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
