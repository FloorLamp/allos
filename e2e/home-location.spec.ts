import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { settledFill } from "./helpers";

// Per-profile home location + sunrise/sunset daylight chips (issue #570). The seed
// sets a coarse home location (~NYC) for the default profile, so the record's day
// view shows daylight chips, and Settings → Profile shows the coordinate fields
// prefilled. Everything is computed on the box from the stored coordinates — no
// external service, no map tiles.

// The record's newest day, read off the page rather than recomputed from the run's
// frozen clock. The day CONTEXT (daylight, UV, weather, cycle phase) lives on the day
// view since #3958 phase 2 — the scrolling record's day header is one line and a
// count — so every chip assertion below opens that day first.
async function newestDay(page: Page): Promise<string> {
  await page.goto("/history");
  const id = await page
    .locator("[id^='timeline-day-']")
    .first() // first-ok: the newest day group; the assertion is about position
    .getAttribute("id");
  expect(id, "the record rendered no day group to open").not.toBeNull();
  return id!.replace("timeline-day-", "");
}

test("the day view shows sunrise/sunset daylight chips", async ({ page }) => {
  await page.goto(`/history?day=${await newestDay(page)}`);
  // #4918 ruling 3: the chip lives INSIDE the chart card now, not a standalone
  // strip — scoped here rather than page-wide, so a regression that moved it back
  // out (or dropped it entirely) would be caught rather than passed by a looser
  // page-wide match.
  const panel = page.getByTestId("intraday-panel");
  await expect(panel).toBeVisible();
  const chip = panel.getByTestId("daylight-chip").first(); // first-ok: asserts a daylight chip renders — order-agnostic presence
  await expect(chip).toBeVisible();
  // Sunrise/sunset are rendered as HH:MM times.
  await expect(chip).toContainText(/\d{1,2}:\d{2}/);
});

test("Settings → Health profile shows the coarse home location and can update it", async ({
  page,
}) => {
  await page.goto("/settings/health");
  // Home location is a one-time setting, so it lives behind the group's stateless
  // "Advanced" fold (#1462 §3) — a native <details>, opened by clicking its summary.
  const openAdvanced = async () => {
    const fold = page.getByTestId("health-advanced");
    await expect(fold).toBeVisible();
    if (!(await fold.evaluate((el) => (el as HTMLDetailsElement).open))) {
      await fold.getByText("Advanced").click();
    }
    await expect(page.getByTestId("home-lat")).toBeVisible();
  };
  await openAdvanced();

  const lat = page.getByTestId("home-lat");
  const lng = page.getByTestId("home-lng");
  await expect(lat).toBeVisible();
  // Seeded coarse coordinates are prefilled (rounded to ~11 km).
  await expect(lat).toHaveValue("40.7");
  await expect(lng).toHaveValue("-74");

  // Updating a coordinate auto-saves (rounded to 0.1° server-side).
  // Note: keep fills OFF the .05 rounding boundary — JS Math.round takes half
  // toward +inf, so "-87.65" coarsens to -87.6 (not -87.7 as half-away-from-zero
  // would give). Deterministic either way; the boundary just makes a confusing
  // fixture.
  // settledFill: land the value in React state (a pre-hydration fill of a controlled
  // input reverts, the autosave never fires, and the reload below flakes — #1188).
  await settledFill(page, lat, "41.85");
  await settledFill(page, lng, "-87.68");
  await lng.blur();
  // Wait for the autosave to COMMIT before reloading — a reload aborts the
  // in-flight server-action POST and silently loses the save (the ai-settings
  // race class, PR #586). SaveStatus renders aria-label="Saved" on success.
  await expect(page.getByLabel("Saved").first()).toBeVisible(); // first-ok: asserts a Saved autosave indicator appears — order-agnostic
  // Reload and confirm the coarse value persisted (the fold is stateless, so it
  // starts closed again).
  await page.reload();
  await openAdvanced();
  await expect(page.getByTestId("home-lat")).toHaveValue("41.9");
  await expect(page.getByTestId("home-lng")).toHaveValue("-87.7");

  // Restore the seeded value so this spec is idempotent for retries.
  await settledFill(page, page.getByTestId("home-lat"), "40.7");
  await settledFill(page, page.getByTestId("home-lng"), "-74");
  await page.getByTestId("home-lng").blur();
  await expect(page.getByLabel("Saved").first()).toBeVisible(); // first-ok: asserts a Saved autosave indicator appears — order-agnostic
  await page.reload();
  await expect(page.getByTestId("home-lat")).toHaveValue("40.7");
});
