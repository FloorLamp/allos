import { test, expect } from "@playwright/test";

// #737 — the hand-authored MuscleAnatomy SVG figure, in its two wired hosts:
// per-exercise mode inside the ExerciseDetailPanel guide section, and weekly
// coverage mode on Training → Overview beside the #736 list (which stays — the
// figure is additive, never replacing the accessible list). Assertions are
// structural (stable data-testid / per-muscle data-muscle + data-state
// attributes), with bounding-box checks only for the activity-card layout this
// spec owns. Read-only against the shared seeded DB.

test("per-exercise anatomy renders in the detail panel guide section (#737)", async ({
  page,
}) => {
  // Same host exercise-guide.spec.ts drives: Trends → Fitness renders the
  // Strength explorer + detail panel; Back Squat is a seeded catalog lift
  // (primary quads; secondary glutes/hamstrings/lower-back).
  await page.goto("/trends?tab=fitness");
  const main = page.getByRole("main");
  await main.getByRole("cell", { name: /Back Squat/ }).click();

  const guide = main.getByTestId("exercise-guide").first(); // first-ok: asserts an exercise guide renders — order-agnostic presence
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

test("per-session anatomy renders on a strength session's journal card, absent for a custom-only session (#789)", async ({
  page,
}) => {
  // /training defaults to the Log tab, which renders the journal feed. The seeded
  // "Push day" strength session (Bench Press, Overhead Press, Lateral Raise,
  // Tricep Pushdown — all catalog lifts) resolves to tagged muscles, so its card
  // carries the per-session figure. Multiple weeks exist; the newest is on page one.
  await page.goto("/training");

  const pushCard = page.locator(".card", { hasText: "Push day" }).first(); // first-ok: the seeded Push day routine card — order-agnostic
  await expect(pushCard).toBeVisible();

  const visualBox = pushCard.getByTestId("activity-visuals");
  await expect(visualBox).toBeVisible();
  await expect(visualBox).toHaveClass(/rounded-lg/);
  await expect(visualBox).toHaveClass(/border/);
  const visualBounds = await visualBox.boundingBox();
  const detailBounds = await pushCard
    .getByTestId("activity-parts")
    .boundingBox();
  expect(visualBounds).not.toBeNull();
  expect(detailBounds).not.toBeNull();
  expect(visualBounds!.x).toBeGreaterThan(detailBounds!.x);
  expect(visualBounds!.width).toBeLessThan(detailBounds!.width);
  expect(detailBounds!.y).toBeLessThan(visualBounds!.y + visualBounds!.height);

  // The shared right-hand slot starts at the same card-top baseline for a
  // muscle figure and for a richer Strava card whose summary wraps differently.
  const stravaCard = page.locator(".card", {
    hasText: "Strava morning ride",
  });
  const [pushBounds, stravaBounds, stravaVisualBounds] = await Promise.all([
    pushCard.boundingBox(),
    stravaCard.boundingBox(),
    stravaCard.getByTestId("activity-visuals").boundingBox(),
  ]);
  expect(pushBounds).not.toBeNull();
  expect(stravaBounds).not.toBeNull();
  expect(stravaVisualBounds).not.toBeNull();
  expect(visualBounds!.y - pushBounds!.y).toBeCloseTo(
    stravaVisualBounds!.y - stravaBounds!.y,
    0
  );
  const session = visualBox.getByTestId("session-muscles");
  await expect(session).toBeVisible();

  const figure = session.getByTestId("muscle-anatomy");
  await expect(figure).toBeVisible();
  await expect(figure).toHaveAttribute("data-mode", "session");
  await expect(figure).toHaveAttribute(
    "aria-label",
    /muscles this session worked/
  );
  await expect(figure.locator("text")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileVisualBounds = await visualBox.boundingBox();
  const mobileFigureBounds = await figure.boundingBox();
  expect(mobileVisualBounds).not.toBeNull();
  expect(mobileFigureBounds).not.toBeNull();
  expect(mobileVisualBounds!.height).toBeCloseTo(128, 0);
  expect(mobileFigureBounds!.height).toBeLessThanOrEqual(112);
  // Bench Press works the chest; the figure marks it as worked this session.
  await expect(figure.locator('[data-muscle="chest"]')).toHaveAttribute(
    "data-state",
    "worked"
  );
  // A muscle no Push-day lift touches stays neutral.
  await expect(figure.locator('[data-muscle="calves"]')).toHaveAttribute(
    "data-state",
    "none"
  );

  // The custom-only strength session (its only lift is a made-up, non-catalog
  // name) resolves to no tagged muscles, so its card renders NO session figure —
  // the gate degrades to nothing rather than an empty diagram.
  const customCard = page
    .locator(".card", { hasText: "Custom-only lift day (e2e)" })
    .first(); // first-ok: the session card THIS spec created (unique name)
  await expect(customCard).toBeVisible();
  await expect(customCard.getByTestId("session-muscles")).toHaveCount(0);
});

test("coverage anatomy renders beside the list on Training → Overview (#737)", async ({
  page,
}) => {
  await page.goto("/training?tab=overview");
  const coverage = page.getByRole("main").getByTestId("muscle-coverage");
  await expect(coverage).toBeVisible();

  // The #736 list-first rendering is permanent — still present with the figure.
  await expect(
    coverage.getByTestId("muscle-coverage-row").first() // first-ok: asserts a muscle-coverage row renders — order-agnostic presence
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
