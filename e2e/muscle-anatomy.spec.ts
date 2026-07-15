import { test, expect } from "@playwright/test";

// #737 — the hand-authored MuscleAnatomy SVG figure, in its two wired hosts:
// per-exercise mode inside the ExerciseDetailPanel guide section, and weekly
// coverage mode on Training → Overview beside the #736 list (which stays — the
// figure is additive, never replacing the accessible list). Assertions are
// structural (stable data-testid / per-muscle data-muscle + data-state
// attributes), never pixel-based. Read-only against the shared seeded DB.

test("per-exercise anatomy renders in the detail panel guide section (#737)", async ({
  page,
}) => {
  // Same host exercise-guide.spec.ts drives: Trends → Fitness renders the
  // Strength explorer + detail panel; Back Squat is a seeded catalog lift
  // (primary quads; secondary glutes/hamstrings/lower-back).
  await page.goto("/trends?tab=fitness");
  const main = page.getByRole("main");
  await main.getByRole("cell", { name: /Back Squat/ }).click();

  const guide = main.getByTestId("exercise-guide").first();
  await expect(guide).toBeVisible();

  // The accompanying TEXT list (never color-only): primary/secondary muscles.
  const muscles = guide.getByTestId("guide-muscles");
  await expect(muscles).toBeVisible();
  await expect(muscles).toContainText("Primary:");
  await expect(muscles).toContainText("Quads");
  await expect(muscles).toContainText("Secondary:");
  await expect(muscles).toContainText("Glutes");

  // The figure, with structural per-muscle emphasis states.
  const figure = guide.getByTestId("muscle-anatomy");
  await expect(figure).toBeVisible();
  await expect(figure).toHaveAttribute("data-mode", "exercise");
  await expect(figure.locator('[data-muscle="quads"]')).toHaveAttribute(
    "data-state",
    "primary"
  );
  await expect(figure.locator('[data-muscle="glutes"]')).toHaveAttribute(
    "data-state",
    "secondary"
  );
  // An uninvolved muscle stays neutral.
  await expect(figure.locator('[data-muscle="chest"]')).toHaveAttribute(
    "data-state",
    "none"
  );
});

test("coverage anatomy renders beside the list on Training → Overview (#737)", async ({
  page,
}) => {
  await page.goto("/training?tab=overview");
  const coverage = page.getByRole("main").getByTestId("muscle-coverage");
  await expect(coverage).toBeVisible();

  // The #736 list-first rendering is permanent — still present with the figure.
  await expect(
    coverage.getByTestId("muscle-coverage-row").first()
  ).toBeVisible();

  const figure = coverage.getByTestId("muscle-anatomy");
  await expect(figure).toBeVisible();
  await expect(figure).toHaveAttribute("data-mode", "coverage");
  // The seeded recent Leg day (Back Squat, daysAgo 1 — the same fixture
  // muscle-coverage.spec.ts leans on) credits quads inside the 7-day window.
  await expect(figure.locator('[data-muscle="quads"]')).toHaveAttribute(
    "data-state",
    "trained"
  );
  // No catalog lift tags the neck, so it is always the neutral empty tint.
  await expect(figure.locator('[data-muscle="neck"]')).toHaveAttribute(
    "data-state",
    "untrained"
  );
});
