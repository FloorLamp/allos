import { test, expect } from "./fixtures";
import { hydratedClick, settledBoxes } from "./helpers";
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
  // Same host exercise-guide.spec.ts drives: Training → Analyze renders the
  // per-exercise detail panel (its home since #1492 turned Trends → Fitness into
  // the windowed lens); Back Squat is a seeded catalog lift (primary quads;
  // secondary glutes/hamstrings/lower-back).
  await page.goto("/training?tab=analyze&kind=strength&item=Back%20Squat");
  const main = page.getByRole("main");

  // Back Squat has logged sessions, so the guide sits behind the collapsed
  // "How to" disclosure (#2895) — open it before asserting its content.
  const disclosure = main.getByTestId("exercise-guide-disclosure").first(); // first-ok: asserts a guide disclosure renders — order-agnostic presence
  await disclosure.locator("summary").click();
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

test("per-session anatomy renders on a strength session's training log card, absent for a custom-only session (#789)", async ({
  page,
}) => {
  // /training defaults to the Log tab — slim rows since #2897, with the full
  // record card in the desktop reading pane once its row is selected. The seeded
  // "Push day" strength session (Bench Press, Overhead Press, Lateral Raise,
  // Tricep Pushdown — all catalog lifts) resolves to tagged muscles, so its card
  // carries the per-session figure. Multiple weeks exist; the newest is on page one.
  await page.goto("/training?tab=log");

  const pushRow = page
    .getByTestId("training-log-row")
    .filter({ hasText: "Push day" })
    .first(); // first-ok: the newest seeded Push day session — order-agnostic
  // The row is a pure client toggle; hydratedClick closes the pre-hydration window.
  await hydratedClick(page, pushRow);
  const pane = page.getByTestId("training-log-reading-pane");
  const pushCard = pane.locator(".card", { hasText: "Push day" });
  await expect(pushCard).toBeVisible();

  const visualBox = pushCard.getByTestId("activity-visuals");
  await expect(visualBox).toBeVisible();
  await expect(visualBox).toHaveClass(/rounded-lg/);
  await expect(visualBox).toHaveClass(/border/);
  const [visualBounds, detailBounds] = await settledBoxes([
    visualBox,
    pushCard.getByTestId("activity-parts"),
  ]);
  expect(visualBounds.x).toBeGreaterThan(detailBounds.x);
  expect(visualBounds.width).toBeLessThan(detailBounds.width);
  expect(detailBounds.y).toBeLessThan(visualBounds.y + visualBounds.height);

  // The shared right-hand slot starts at the same card-top baseline for a
  // muscle figure and for a richer Strava card whose summary wraps differently —
  // both render in the pane's one slot, so swap the pane and compare offsets.
  // Each pair is read via settledBoxes (one settled layout per snapshot — a
  // relative-layout assertion built from separate boundingBox round-trips can
  // describe a layout that never existed, per the e2e-hygiene doctrine).
  const [pushBounds, pushVisualBounds] = await settledBoxes([
    pushCard,
    visualBox,
  ]);
  const stravaRow = page
    .getByTestId("training-log-row")
    .filter({ hasText: "Strava morning ride" });
  await stravaRow.click();
  const stravaCard = pane.locator(".card", {
    hasText: "Strava morning ride",
  });
  await expect(stravaCard).toBeVisible();
  const [stravaBounds, stravaVisualBounds] = await settledBoxes([
    stravaCard,
    stravaCard.getByTestId("activity-visuals"),
  ]);
  expect(pushVisualBounds.y - pushBounds.y).toBeCloseTo(
    stravaVisualBounds.y - stravaBounds.y,
    0
  );

  // Back to the push session for its figure.
  await pushRow.click();
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

  // On a phone the pane doesn't exist — tapping the row expands the full card
  // in place, where the same visual box renders as a shallow strip.
  await page.setViewportSize({ width: 390, height: 844 });
  // Wait for the width mode to settle: the row advertises aria-expanded only
  // once expand-in-place is its live affordance (a click landing before the
  // settle hits the desktop branch and deselects instead).
  await expect(pushRow).toHaveAttribute("aria-expanded", "false");
  await pushRow.click();
  const mobileCard = page.locator(".card", { hasText: "Push day" }).first(); // first-ok: the one Push day card expanded in place (rows are not .card)
  await expect(mobileCard).toBeVisible();
  const mobileVisualBounds = await mobileCard
    .getByTestId("activity-visuals")
    .boundingBox();
  const mobileFigureBounds = await mobileCard
    .getByTestId("muscle-anatomy")
    .boundingBox();
  expect(mobileVisualBounds).not.toBeNull();
  expect(mobileFigureBounds).not.toBeNull();
  expect(mobileVisualBounds!.height).toBeCloseTo(128, 0);
  expect(mobileFigureBounds!.height).toBeLessThanOrEqual(112);

  // The custom-only strength session (its only lift is a made-up, non-catalog
  // name) resolves to no tagged muscles, so its card renders NO session figure —
  // the gate degrades to nothing rather than an empty diagram.
  const customRow = page
    .getByTestId("training-log-row")
    .filter({ hasText: "Custom-only lift day (e2e)" })
    .first(); // first-ok: the session row THIS spec created (unique name)
  await customRow.click();
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
