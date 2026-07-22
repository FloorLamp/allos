import { test, expect } from "@playwright/test";

// Issue #160 / #1066: the Trends → Body section surfaces a COMPACT sleep summary
// tile (the SRI + last-night duration) once enough nights of sleep sessions exist;
// the detailed regularity caption/trend moved to the dedicated /sleep page (#1066).
// e2e/seed-events.ts seeds 28 nightly sleep sessions for profile 1 (the default
// authed profile), so the rolling 28-night window clears the minimum-nights gate
// and both the tile and the SRI figure render.
//
// Isolation: everything is scoped to getByRole("main") and reads only the seeded
// SRI fixture; it mutates no rows, so it can't disturb other specs.

test("Trends → Body renders the compact sleep tile with the SRI (#160/#1066)", async ({
  page,
}) => {
  await page.goto("/trends?tab=body");
  await expect(page.getByRole("tab", { name: "Body" })).toHaveAttribute(
    "aria-selected",
    "true"
  );

  const main = page.getByRole("main");
  const tile = main.getByTestId("sleep-summary-tile");
  await expect(tile).toBeVisible();

  // The SRI headline value is an integer in −100..100. The seeded schedule is
  // highly regular, so it renders a high positive number.
  const value = tile.getByTestId("sri-value");
  await expect(value).toBeVisible();
  await expect(value).toHaveText(/^SRI (?:−)?\d+$/);
  const sri = Number(
    (await value.innerText()).trim().replace("SRI ", "").replace("−", "-")
  );
  expect(Number.isFinite(sri)).toBe(true);
  expect(sri).toBeGreaterThan(0);
  expect(sri).toBeLessThanOrEqual(100);

  // The tile is the deep-link to the full Sleep page (#1066).
  await expect(tile).toHaveAttribute("href", "/sleep");
});
