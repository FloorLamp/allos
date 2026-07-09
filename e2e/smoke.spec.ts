import { test, expect } from "@playwright/test";

// Broad smoke coverage: each primary authenticated surface renders (real HTTP
// 200 + the app shell, not a Next error page) against the seeded DB. Catches
// server-component crashes / bad queries that a build alone won't.
const ROUTES = [
  "/", // dashboard
  "/training",
  "/trends",
  "/timeline",
  "/upcoming",
  "/data",
  "/biomarkers",
  "/medicine",
  "/settings",
];

for (const route of ROUTES) {
  test(`renders ${route}`, async ({ page }) => {
    const resp = await page.goto(route);
    expect(resp?.status(), `HTTP status for ${route}`).toBeLessThan(400);
    // The shared sidebar (Data nav link) proves the app shell rendered rather
    // than a Next error boundary / 500 page. exact:true avoids matching the
    // Import tab's provider links that also contain "Data".
    await expect(
      page.getByRole("link", { name: "Data", exact: true })
    ).toBeVisible();
    await expect(page.getByText("Application error")).toHaveCount(0);
  });
}
