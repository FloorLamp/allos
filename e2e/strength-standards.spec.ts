import { test, expect } from "./fixtures";
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
  // Training → Log: clicking a lift on a journal card opens the per-exercise
  // detail panel, which carries the coaching STANDING line. (#1492 moved this
  // host: Trends → Fitness became the WINDOWED analytics lens — four sections of
  // trend charts — so the full-history explorer that used to carry the panel is
  // gone from it; /training owns the "do" surfaces. Analyze renders the SAME panel
  // with showLevel=false, because there the standing is the Benchmarks card the
  // second test drives — one standing per surface, never both.)
  await page.goto("/training");

  const main = page.getByRole("main");
  // A COVERED core lift (a dataset barbell lift). The seeded Leg day card carries
  // Back Squat; the drill-in button names the lift it opens.
  const squatDrillIn = main
    .getByRole("button", { name: "Back Squat", exact: true })
    .first(); // first-ok: the seeded Back Squat drill-in — the lift is logged on several days and EVERY button opens the same panel
  await squatDrillIn.click();
  const standard = main.getByTestId("strength-standard").first(); // first-ok: asserts a strength-standard row renders — order-agnostic presence
  await expect(standard).toBeVisible();
  await expect(standard).toContainText("Strength standard");
  // The coaching copy names a standard for the lifter's bodyweight.
  await expect(standard).toContainText("at your bodyweight");
});

test("the Analyze Benchmarks card renders the unified bodyweight-band tiers (#152)", async ({
  page,
}) => {
  // Training → Analyze (strength) renders the Benchmarks ladder, now driven by the
  // same strength-standard model as the detail line and pillar. Pin a COVERED core
  // lift via ?item — the default item is the strongest lift (an accessory like Leg
  // Press) with no barbell standard, so it would show no Benchmarks card.
  await page.goto("/training?tab=analyze&kind=strength&item=Back%20Squat");

  const main = page.getByRole("main");
  await expect(main.getByText("Benchmarks", { exact: true })).toBeVisible();
  // The ladder is bodyweight-adjusted (× BW rungs) and labeled as such.
  await expect(
    main.getByText("for your bodyweight & sex").first() // first-ok: asserts the bodyweight-adjusted label renders — order-agnostic presence
  ).toBeVisible();
  await expect(main.getByText(/× BW/).first()).toBeVisible(); // first-ok: asserts a × BW rung renders — order-agnostic presence
});
