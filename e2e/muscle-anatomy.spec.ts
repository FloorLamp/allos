import { test, expect } from "./fixtures";
import { followLink, hydratedClick } from "./helpers";
// #737 — the hand-authored MuscleAnatomy SVG figure, in its two wired hosts:
// per-exercise mode inside the ExerciseDetailPanel guide section, and weekly
// coverage mode on Training → Overview beside the #736 list (which stays — the
// figure is additive, never replacing the accessible list). Assertions are
// structural (stable data-testid / per-muscle data-muscle + data-state
// attributes). Read-only against the shared seeded DB.

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

test("activity detail reuses muscle coverage scoped to that workout and omits untagged sessions (#789)", async ({
  page,
}) => {
  await page.goto("/training?tab=log");

  const pushRow = page
    .getByTestId("training-log-row")
    .filter({ hasText: "Push day" })
    .first(); // first-ok: the newest seeded Push day session — order-agnostic
  await pushRow
    .getByTestId("training-log-strength-row")
    .filter({ hasText: "Barbell Bench Press" })
    .getByRole("button", { name: "Chest", exact: true })
    .click();
  await expect(page.getByTestId("training-log-tag-filter")).toHaveText("Chest");
  await expect(pushRow).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await followLink(
    page,
    pushRow.getByRole("link", { name: "Push day", exact: true }),
    /\/training\/activity\/\d+$/
  );
  const pushCard = page.getByTestId("training-activity-page");
  await expect(pushCard).toBeVisible();

  // The detail host promotes the same coverage card used by Overview instead
  // of leaving a second compact diagram beside the exercise rows.
  const coverage = pushCard.getByTestId("activity-muscle-coverage");
  await expect(coverage).toBeVisible();
  await expect(coverage).toContainText("Muscles worked");
  const coverageInfo = coverage.getByTestId("muscle-coverage-info");
  await coverageInfo.click();
  await expect(page.getByRole("tooltip")).toContainText(
    /Working sets from this workout/
  );
  await page.keyboard.press("Escape");
  await expect(
    pushCard.getByTestId("activity-record-body").getByTestId("activity-visuals")
  ).toHaveCount(0);

  const figure = coverage.getByTestId("muscle-anatomy");
  await expect(figure).toBeVisible();
  await expect(figure).toHaveAttribute("data-mode", "coverage");
  await expect(figure).toHaveAttribute(
    "aria-label",
    /muscles worked in this workout/
  );
  await expect(figure.locator("text")).toHaveCount(2);
  await expect(figure.locator('[data-muscle="chest"]')).toHaveAttribute(
    "data-state",
    "trained"
  );
  await expect(figure.locator('[data-muscle="calves"]')).toHaveAttribute(
    "data-state",
    "untrained"
  );
  await expect(coverage.getByTestId("muscle-coverage-verdict")).toHaveCount(0);
  await expect(coverage.getByText("What counts?", { exact: true })).toHaveCount(
    0
  );
  await expect(
    coverage.locator("summary").first() // first-ok: asserts any workout-scoped muscle disclosure exposes its accessible toggle label
  ).toHaveAttribute("aria-label", /Show or hide what counts for/);

  const benchRow = pushCard.getByTestId("training-log-strength-row").filter({
    has: page.getByRole("link", {
      name: "Barbell Bench Press",
      exact: true,
    }),
  });
  const chest = figure.locator('[data-muscle-target="coverage-chest"]');
  await chest.locator("path").first().hover(); // first-ok: either bilateral chest path bubbles to the same muscle highlight target
  await expect(benchRow).toHaveAttribute("data-highlighted", "true");

  await benchRow.hover();
  await expect(chest).toHaveAttribute("data-highlighted", "true");
  // Highlighting stays visual: the row keeps its stable category text instead
  // of swapping in a longer muscle list and reflowing under the pointer.
  await expect(benchRow.getByText("Chest", { exact: true })).toBeVisible();
  await expect(
    pushCard
      .getByTestId("training-log-strength-row")
      .filter({ hasText: "Overhead Press" })
  ).not.toHaveAttribute("data-highlighted", "true");

  await page.goto("/training?tab=log");
  const customRow = page
    .getByTestId("training-log-row")
    .filter({ hasText: "Custom-only lift day (e2e)" })
    .first(); // first-ok: the session row THIS spec created (unique name)
  await customRow
    .getByRole("link", { name: "Custom-only lift day (e2e)", exact: true })
    .click();
  const customCard = page
    .getByTestId("training-activity-page")
    .filter({ hasText: "Custom-only lift day (e2e)" });
  await expect(customCard).toBeVisible();
  await expect(customCard.getByTestId("activity-muscle-coverage")).toHaveCount(
    0
  );
});

test("coverage anatomy renders beside the list on Training → Overview (#737)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
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
  // Use the final evidence row: unlike the first row, it is genuinely below the
  // phone viewport when the diagram is at the top of the screen.
  const furthestRow = coverage.locator('li[id^="coverage-"]').last(); // last-ok: the assertion is specifically about the row furthest from the diagram
  const furthestDisclosure = furthestRow.getByTestId("muscle-coverage-row");
  const targetId = (await furthestRow.getAttribute("id"))!;
  await expect(furthestDisclosure).not.toHaveAttribute("open");
  await figure.evaluate((element) =>
    element.scrollIntoView({ block: "start" })
  );
  await expect(furthestRow).not.toBeInViewport();
  await hydratedClick(
    page,
    figure.locator(`[data-muscle-target="${targetId}"] path`).first() // first-ok: either bilateral path bubbles to the same muscle disclosure target
  );
  await expect(furthestDisclosure).toHaveAttribute("open", "");
  await expect(furthestRow).toBeInViewport();
  // No catalog lift tags the neck, so it is always the neutral empty tint.
  await expect(figure.locator('[data-muscle="neck"]')).toHaveAttribute(
    "data-state",
    "untrained"
  );
});
