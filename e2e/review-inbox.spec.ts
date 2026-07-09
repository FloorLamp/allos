import { test, expect } from "@playwright/test";

// Dogfoods the Data → Review import inbox (the feature that motivated this tier):
// recent imports feed, the "Needs attention" section for a currently-failing
// integration, and the profile-menu badge count.
test.describe("Data → Review import inbox", () => {
  test("surfaces recent imports and a failing integration", async ({
    page,
  }) => {
    await page.goto("/data?section=review");
    // Scope to the review panel — the (hidden) Import tab also mentions the
    // providers, so a page-wide text match would resolve to hidden nodes.
    const review = page.getByTestId("review-inbox");

    await expect(
      review.getByRole("heading", { name: "Recent imports" })
    ).toBeVisible();

    // The failing Strava sync is called out under "Needs attention".
    await expect(review.getByText("Needs attention")).toBeVisible();
    await expect(review.getByText("Strava sync failed")).toBeVisible();
    await expect(review.getByText(/token refresh failed/)).toBeVisible();

    // Health Connect appears in the recent-imports feed.
    await expect(
      review.getByText("Google Health Connect").first()
    ).toBeVisible();

    // The recent-imports feed renders the #273 insert/update/unchanged split:
    // the Health Connect sync shows "30 new · 10 changed", and the all-unchanged
    // Strava re-scan collapses to "nothing new".
    await expect(review.getByText("30 new · 10 changed")).toBeVisible();
    await expect(review.getByText("nothing new")).toBeVisible();

    // Admin-only raw payload viewer (#9): the seeded Health Connect sync carries a
    // raw_ref, so the admin (the seed logs in as admin) sees a "View raw"
    // affordance. Expanding it lazily fetches the admin-gated, profile-scoped raw
    // route, which returns the captured provider JSON.
    const viewRaw = review.getByText("View raw").first();
    await expect(viewRaw).toBeVisible();
    await viewRaw.click();
    await expect(review.getByText(/"records"/)).toBeVisible();
    await expect(review.getByText(/"Steps"/)).toBeVisible();
  });

  test("shows the failing-integration count on the profile badge", async ({
    page,
  }) => {
    await page.goto("/");
    const badge = page.getByTestId("review-badge").first();
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("1");
  });

  test("the tab is reachable from the profile menu link", async ({ page }) => {
    await page.goto("/");
    // The link lives in the profile menu, which is collapsed until the pill is
    // clicked.
    await page.getByTestId("user-menu-trigger").click();
    await page.getByRole("link", { name: "Import review" }).click();
    await expect(page).toHaveURL(/\/data\?section=review/);
    await expect(
      page.getByTestId("review-inbox").getByRole("heading", {
        name: "Recent imports",
      })
    ).toBeVisible();
  });
});
