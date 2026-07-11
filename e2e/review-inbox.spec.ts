import { test, expect } from "@playwright/test";

// Dogfoods the Data → Review import inbox (the feature that motivated this tier).
// After issue #208 the surface is split into two sections with a shared strip on
// top: "Needs attention" (a currently-failing integration) spans both, then
// "Connected sources" (recurring per-provider streams, collapsed to latest-state
// with a Sync now / push explainer) and "Imports" (the chronological one-off feed
// of documents + paste jobs). Plus the profile-menu badge count.
test.describe("Data → Review import inbox", () => {
  test("splits connected sources from one-off imports, with a failing integration on top", async ({
    page,
  }) => {
    await page.goto("/data?section=review");
    // Scope to the review panel — the (hidden) Import tab also mentions the
    // providers, so a page-wide text match would resolve to hidden nodes.
    const review = page.getByTestId("review-inbox");

    // The Imports section header (renamed from "Recent imports").
    await expect(
      review.getByRole("heading", { name: "Imports", exact: true })
    ).toBeVisible();

    // The failing Strava sync is called out under "Needs attention".
    await expect(review.getByText("Needs attention")).toBeVisible();
    await expect(review.getByText("Strava sync failed")).toBeVisible();
    await expect(review.getByText(/token refresh failed/)).toBeVisible();

    // "Connected sources": one card per recurring provider, collapsed to latest state.
    await expect(
      review.getByRole("heading", { name: "Connected sources" })
    ).toBeVisible();

    // Health Connect's card shows its latest sync split (30 new · 10 changed) and,
    // being push-only, an explainer instead of a Sync now button.
    const hcCard = review.getByTestId("source-health-connect");
    await expect(hcCard.getByText("Google Health Connect")).toBeVisible();
    await expect(hcCard.getByText("30 new · 10 changed")).toBeVisible();
    await expect(hcCard.getByText(/Push-only/)).toBeVisible();

    // Strava's card (connected in the seed) offers a per-provider Sync now button;
    // its latest outcome is the failure.
    const stravaCard = review.getByTestId("source-strava");
    await expect(
      stravaCard.getByRole("button", { name: "Sync now" })
    ).toBeVisible();
    await expect(stravaCard.getByText("Sync failed")).toBeVisible();

    // Admin-only raw payload viewer (#9): the seeded Health Connect sync carries a
    // raw_ref, so the admin (the seed logs in as admin) sees a "View raw"
    // affordance on the source card. Expanding it lazily fetches the admin-gated,
    // profile-scoped raw route, which returns the captured provider JSON.
    const viewRaw = hcCard.getByText("View raw").first();
    await expect(viewRaw).toBeVisible();
    await viewRaw.click();
    await expect(hcCard.getByText(/"records"/)).toBeVisible();
    await expect(hcCard.getByText(/"Steps"/)).toBeVisible();
  });

  test("the Imports feed merges uploaded documents and paste jobs, not syncs", async ({
    page,
  }) => {
    await page.goto("/data?section=review");
    const feed = page.getByTestId("import-feed");

    // The successfully-extracted document appears with its produced-item count
    // and links to its /import/[id] verify/detail view. "items", not "records":
    // the tally spans every clinical kind an import writes (#212).
    const docLink = feed.getByRole("link", { name: "e2e-labs.pdf" });
    await expect(docLink).toBeVisible();
    await expect(docLink).toHaveAttribute("href", /\/import\/\d+/);
    await expect(feed.getByText("7 items", { exact: true })).toBeVisible();

    // A rejected upload (inserted straight into a terminal 'failed' state — the
    // path the toast bug missed) still surfaces in the feed.
    await expect(feed.getByText("e2e-broken.txt")).toBeVisible();
    await expect(feed.getByText("import failed")).toBeVisible();

    // A pasted/CSV job shows in the same feed and points back to the importer.
    await expect(feed.getByText("Pasted labs")).toBeVisible();
    await expect(feed.getByText(/review to save/)).toBeVisible();

    // Recurring integration syncs are NOT in this feed anymore — they live in the
    // "Connected sources" section above.
    await expect(feed.getByText("No new data")).toHaveCount(0);

    // Following the document link lands on its import-detail page.
    await docLink.click();
    await expect(page).toHaveURL(/\/import\/\d+/);
    await expect(
      page.getByRole("link", { name: "Back to Review" })
    ).toBeVisible();
  });

  test("the re-extract-all button previews the AI cost before confirming", async ({
    page,
  }) => {
    await page.goto("/data?section=review");
    const review = page.getByTestId("review-inbox");

    // The rescoped button lives in the Imports section header and reads
    // unambiguously.
    const button = review.getByTestId("reprocess-all");
    await expect(button).toHaveText(/Re-extract all documents/);
    await button.click();

    // The confirm dialog shows the deterministic/AI cost split computed before
    // running: the seed carries a health record (ccda → no AI) and a scan/PDF
    // (labcorp-panel.pdf → one AI extraction) with the daily quota remaining.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      /health record.*re-imported instantly, no AI/
    );
    await expect(dialog).toContainText(
      /scan\/PDF.*AI extraction.*daily remaining/
    );

    // Cancel — the e2e never actually re-extracts (the fixtures have no blob on
    // disk, and a run would mutate the shared seeded DB).
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
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
        name: "Imports",
        exact: true,
      })
    ).toBeVisible();
  });
});
