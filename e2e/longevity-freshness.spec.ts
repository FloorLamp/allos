import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_LONGEVITY_STALE,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

// Issue #2023 — the optimal-biomarker pillar states what its ratio actually describes.
// Two presentations, on two profiles that own their own data:
//   • the shared seeded profile 1, whose labs are recent → a CURRENT panel that names
//     its size and its freshness, with per-row dates in the expanded breakdown;
//   • the dedicated old-only fixture, whose favorable readings are all past their retest
//     window → NEUTRAL "all based on older results", never a current-looking green.
// All reads — no mutations — so the spec is repeat-safe and contention-free.

test("a current panel names its size and freshness, and its rows carry dates (#2023)", async ({
  page,
}) => {
  test.slow(); // next dev compiles the route on first hit
  await page.goto("/longevity");
  const biomarkers = page.getByRole("main").getByTestId("longevity-biomarkers");
  await expect(biomarkers).toBeVisible();

  // The coverage line is the SAME model the pillar consumed, so it always renders
  // alongside a pillar with a non-zero denominator.
  const coverage = biomarkers.getByTestId("longevity-biomarker-coverage");
  await expect(coverage).toBeVisible();
  await expect(coverage).toContainText(/marker/);
  // It says something about currency — either all current, or how many are older.
  await expect(coverage).toContainText(/current|older results/);

  // Every judged row shows the reading's own date, so the breakdown reconciles with
  // whatever the line above claimed rather than asking the reader to trust it.
  const firstDate = biomarkers.getByTestId("longevity-biomarker-date").first(); // first-ok: asserts a date renders on a row in the scoped section — order-agnostic presence
  await expect(firstDate).toBeVisible();
  await expect(firstDate).toContainText(/^\d{4}-\d{2}-\d{2}/);
});

test("an old-only panel reads as older results, not a current green result (#2023)", async ({
  browser,
}) => {
  test.slow();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_LONGEVITY_STALE,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/longevity");

  const biomarkers = page.getByRole("main").getByTestId("longevity-biomarkers");
  await expect(biomarkers).toBeVisible();

  // Both readings are favorable, so the RATIO is a clean sweep — the honesty fix is in
  // what the card claims about it, not in hiding the number.
  const pillar = biomarkers.getByTestId("longevity-pillar-optimal-biomarkers");
  await expect(pillar).toBeVisible();
  await expect(pillar).toContainText("2 of 2");
  await expect(pillar).toContainText("older results");

  // Neutral makes no judgment, so it carries NO tone badge — a favorable share that is
  // years old must not wear the "Good" label the same share would earn today.
  await expect(pillar).not.toContainText("Good");

  // The coverage line agrees, and names the latest draw rather than implying currency.
  const coverage = biomarkers.getByTestId("longevity-biomarker-coverage");
  await expect(coverage).toContainText("all based on older results");
  await expect(coverage).toContainText("2 markers");

  // Every row is marked older, and still shows its value and date — visible, not hidden.
  const rows = biomarkers.getByTestId("longevity-biomarker-date");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("older"); // first-ok: both rows are stale; asserting one is enough to pin the marking

  await page.close();
});
