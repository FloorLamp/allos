import { test, expect } from "@playwright/test";

// Issue #736 — the list-first weekly muscle-coverage surface on Training →
// Overview. The SAME `coverageFromSets` attribution (one computation, #482) that
// will later feed the SVG figure (#737) and volume-band verdict (#742) renders
// here as a permanent, accessible per-muscle set-count list. The seed ships a PPL
// program whose most recent Push/Pull/Leg sessions land inside the trailing 7-day
// window, so the coverage list has content on the seeded DB. Read-only — asserts
// rendering only, adds no rows, so it's safe against the shared seeded DB.

test("weekly muscle coverage renders list-first on Training → Overview (#736)", async ({
  page,
}) => {
  await page.goto("/training?tab=overview");

  const coverage = page.getByRole("main").getByTestId("muscle-coverage");
  await expect(coverage).toBeVisible();
  await expect(coverage).toContainText("Muscle coverage");

  // The seeded recent Leg day (Back Squat, daysAgo 1) credits quads, so at least
  // one per-muscle row renders with a set count.
  const rows = coverage.getByTestId("muscle-coverage-row");
  await expect(rows.first()).toBeVisible(); // first-ok: asserts a muscle-coverage row renders — order-agnostic presence
  await expect(coverage).toContainText("Quads");
  // Every row states a set count (whole or half credit).
  await expect(rows.first()).toContainText(/\bsets?\b/); // first-ok: asserts any coverage row shows a set count — order-agnostic structure check
});
