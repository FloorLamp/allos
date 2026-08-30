import { test, expect } from "./fixtures";

// One broad phone-viewport smoke pass. Desktop specs already navigate every route
// below repeatedly; the mobile project is opt-in, so this is the useful half of the
// old two-project smoke loop.
const ROUTES = [
  "/", // dashboard
  "/training",
  "/trends",
  "/history",
  "/sleep",
  "/upcoming",
  "/data",
  "/results",
  "/nutrition",
  "/medications",
  "/settings",
];

for (const route of ROUTES) {
  test(`renders ${route}`, async ({ page }) => {
    const response = await page.goto(route);
    expect(response?.status(), `HTTP status for ${route}`).toBeLessThan(400);
    await expect(page.getByTestId("dock-slot-more")).toBeVisible();
    await expect(page.getByText("Application error")).toHaveCount(0);
  });
}
