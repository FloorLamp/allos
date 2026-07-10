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

    // The recent-imports feed renders the insert/update/unchanged split: the Health
    // Connect sync shows "30 new · 10 changed".
    await expect(review.getByText("30 new · 10 changed")).toBeVisible();

    // Issue #137: the four consecutive hourly Strava no-op re-scans do NOT each
    // print a "nothing new" row — they collapse into a single "No new data · 4
    // checks" summary line, so the feed isn't drowned in noise.
    await expect(review.getByText("No new data · 4 checks")).toBeVisible();
    await expect(review.getByText("nothing new")).toHaveCount(0);

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

  test("the feed merges uploaded documents and paste jobs, not just syncs", async ({
    page,
  }) => {
    await page.goto("/data?section=review");
    const feed = page.getByTestId("import-feed");

    // The successfully-extracted document appears with its produced-record count
    // and links to its /import/[id] verify/detail view.
    const docLink = feed.getByRole("link", { name: "e2e-labs.pdf" });
    await expect(docLink).toBeVisible();
    await expect(docLink).toHaveAttribute("href", /\/import\/\d+/);
    await expect(feed.getByText("7 records", { exact: true })).toBeVisible();

    // A rejected upload (inserted straight into a terminal 'failed' state — the
    // path the toast bug missed) still surfaces in the feed.
    await expect(feed.getByText("e2e-broken.txt")).toBeVisible();
    await expect(feed.getByText("import failed")).toBeVisible();

    // A pasted/CSV job shows in the same feed and points back to the importer.
    await expect(feed.getByText("Pasted labs")).toBeVisible();
    await expect(feed.getByText(/review to save/)).toBeVisible();

    // Following the document link lands on its import-detail page.
    await docLink.click();
    await expect(page).toHaveURL(/\/import\/\d+/);
    await expect(
      page.getByRole("link", { name: "Back to Review" })
    ).toBeVisible();
  });

  test("shows a review count on the profile badge", async ({ page }) => {
    await page.goto("/");
    const badge = page.getByTestId("review-badge").first();
    await expect(badge).toBeVisible();
    // The badge sums currently-failing integrations (Strava, always present) and
    // any unresolved detected duplicate pairs (issue #10). The exact count depends
    // on whether the dedup spec has merged its fixture yet (shared seeded DB), so
    // assert only that the always-present failing integration keeps it >= 1; the
    // exact 2 -> 1 transition is asserted in import-dedup.spec, which owns that
    // fixture's lifecycle.
    expect(Number(await badge.textContent())).toBeGreaterThanOrEqual(1);
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
