import { test, expect } from "@playwright/test";
import { settledFill } from "./helpers";

// Per-profile home location + sunrise/sunset daylight chips (issue #570). The seed
// sets a coarse home location (~NYC) for the default profile, so the timeline day
// headers show daylight chips, and Settings → Profile shows the coordinate fields
// prefilled. Everything is computed on the box from the stored coordinates — no
// external service, no map tiles.

test("timeline day headers show sunrise/sunset daylight chips", async ({
  page,
}) => {
  await page.goto("/timeline");
  const chip = page.getByTestId("daylight-chip").first();
  await expect(chip).toBeVisible();
  // Sunrise/sunset are rendered as HH:MM times.
  await expect(chip).toContainText(/\d{1,2}:\d{2}/);
});

test("Settings → Profile shows the coarse home location and can update it", async ({
  page,
}) => {
  await page.goto("/settings/profile");

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
  await expect(page.getByLabel("Saved").first()).toBeVisible();
  // Reload and confirm the coarse value persisted.
  await page.reload();
  await expect(page.getByTestId("home-lat")).toHaveValue("41.9");
  await expect(page.getByTestId("home-lng")).toHaveValue("-87.7");

  // Restore the seeded value so this spec is idempotent for retries.
  await settledFill(page, page.getByTestId("home-lat"), "40.7");
  await settledFill(page, page.getByTestId("home-lng"), "-74");
  await page.getByTestId("home-lng").blur();
  await expect(page.getByLabel("Saved").first()).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("home-lat")).toHaveValue("40.7");
});
