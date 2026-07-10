import { test, expect } from "@playwright/test";

// #152: an estimated 1RM gains a bodyweight-band strength-standard COACHING line on
// the exercise detail panel, computed from the baked derived thresholds in
// lib/strength-standards.json. The seeded adult (profile 1) is male with a known
// bodyweight and a rich barbell history (squat/bench/deadlift), so the Strength
// analytics view (Trends → Fitness) must render the "Strength standard" context
// line for a core lift. The gate (hidden when sex/bodyweight unset, or for a
// non-core lift) is covered exhaustively by the pure unit tests
// (lib/__tests__/strength-standards.test.ts) — driving the settings form to unset
// sex here would be brittle, so the e2e asserts the positive render only, mirroring
// the fitness-percentile spec.

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
