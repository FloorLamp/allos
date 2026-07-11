import { test, expect } from "@playwright/test";

// #152: an estimated 1RM gains a bodyweight-band strength-standard from ONE model
// (lib/strength-standards.json) that now feeds every strength-level surface — the
// exercise-detail coaching line + level badge, the Analyze "Benchmarks" card, and
// the healthspan pillar. The seeded adult (profile 1) is male with a known
// bodyweight and a rich barbell history (squat/bench/deadlift), so both surfaces
// below must render for a core lift. The gate (hidden when sex/bodyweight unset, or
// for an uncovered lift) is covered exhaustively by the pure unit tests
// (lib/__tests__/strength-standards.test.ts) and the cross-surface agreement by
// lib/__tests__/strength-level-consistency.test.ts — driving the settings form to
// unset sex here would be brittle, so the e2e asserts the positive render only.

test("exercise detail shows the bodyweight-band strength standard line (#152)", async ({
  page,
}) => {
  // Trends → Fitness renders the Strength explorer + exercise detail panel.
  await page.goto("/trends?tab=fitness");

  const main = page.getByRole("main");
  // The detail panel opens on the strongest lift (highest est. 1RM) by default.
  const standard = main.getByTestId("strength-standard").first();
  await expect(standard).toBeVisible();
  await expect(standard).toContainText("Strength standard");
  // The coaching copy names a standard for the lifter's bodyweight.
  await expect(standard).toContainText("at your bodyweight");
});

test("the Analyze Benchmarks card renders the unified bodyweight-band tiers (#152)", async ({
  page,
}) => {
  // Training → Analyze (strength) renders the Benchmarks ladder, now driven by the
  // same strength-standard model as the detail line and pillar.
  await page.goto("/training?tab=analyze&kind=strength");

  const main = page.getByRole("main");
  await expect(main.getByText("Benchmarks", { exact: true })).toBeVisible();
  // The ladder is bodyweight-adjusted (× BW rungs) and labeled as such.
  await expect(
    main.getByText("for your bodyweight & sex").first()
  ).toBeVisible();
  await expect(main.getByText(/× BW/).first()).toBeVisible();
});
