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

// #39 (findings bus): the dashboard Coaching widget's "Not today" snoozes the top
// recommendation through the shared suppression store, so it's no longer the
// widget's top suggestion after the click (the next-ranked one surfaces, or the
// empty fallback shows). Exercises a coaching Recommendation → Finding adapter, the
// generalized snoozeFinding writer, and the round-trip re-render end-to-end.
test("dashboard coaching 'Not today' snoozes the top recommendation (#39)", async ({
  page,
}) => {
  await page.goto("/");
  const card = page.locator(".card", {
    has: page.getByTestId("coaching-not-today"),
  });
  await expect(card).toBeVisible();
  const original = (
    await card.locator("p.font-semibold").first().textContent()
  )?.trim();
  expect(original).toBeTruthy();

  await card.getByTestId("coaching-not-today").click();
  // The snoozed recommendation is no longer shown as the widget's suggestion.
  await expect(card.getByText(original!, { exact: true })).toHaveCount(0);
});

// #38: a refill-tracked supplement (seed sets Magnesium Glycinate's on-hand
// supply) shows an "≈N days left" estimate that names its basis — the actual
// taken-log rate vs the scheduled-dose-count fallback. Asserts the rendered
// days-left badge carries both the days text and the basis label.
test("supplements page shows a refill days-left estimate with its basis (#38)", async ({
  page,
}) => {
  await page.goto("/medicine");
  const badge = page.getByTestId("refill-days-left").first();
  await expect(badge).toContainText(/days?\s+left/);
  await expect(badge).toContainText(/based on (your last 30 days|schedule)/);
});
