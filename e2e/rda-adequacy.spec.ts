import { test, expect } from "@playwright/test";

// RDA-adequacy view (issue #578). The seeded stack (scripts/seed.ts) includes Calcium
// 500 mg/day — below the ~1000 mg adult RDA — so /medicine must render an adequacy row
// stating the SHARE the supplements provide, with the load-bearing framing "supplements
// alone provide X% of the RDA" and never "deficient" (food intake is unknown). Uses the
// shared authenticated storageState.

test("/medicine shows the RDA-adequacy share for an under-RDA stack nutrient (#578)", async ({
  page,
}) => {
  await page.goto("/medicine");

  const section = page.getByTestId("rda-adequacy");
  await expect(section).toBeVisible();

  const calcium = page.getByTestId("rda-adequacy-calcium");
  await expect(calcium).toBeVisible();
  await expect(calcium).toContainText("% of the RDA");
  await expect(calcium).toContainText(/supplements alone provide/i);
  // The load-bearing wording contract: never implies a deficiency.
  await expect(calcium).not.toContainText(/deficient|deficiency/i);
  await expect(calcium).toContainText(/not medical advice/i);
});
