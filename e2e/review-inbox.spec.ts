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

    // The failing Strava sync is called out under "Needs attention". The same
    // failure message also renders on the Strava source card (by design), so
    // scope the message assertion to the attention item to avoid a strict-mode
    // double-match.
    await expect(review.getByText("Needs attention")).toBeVisible();
    const attentionItem = review
      .getByRole("listitem")
      .filter({ hasText: "Strava sync failed" });
    await expect(attentionItem.getByText(/token refresh failed/)).toBeVisible();

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
    // "Sync failed" appears in both the collapsed latest-state line and the
    // recent-history list of the same card — assert the first (latest-state).
    await expect(stravaCard.getByText("Sync failed").first()).toBeVisible();

    // Admin-only raw payload viewer (#9): the seeded Health Connect sync carries a
    // raw_ref, so the admin (the seed logs in as admin) sees a "View raw"
    // affordance on the source card. Expanding it lazily fetches the admin-gated,
    // profile-scoped raw route, which returns the captured provider JSON.
    const viewRaw = hcCard.getByText("View raw").first();
    await expect(viewRaw).toBeVisible();
    // The click can land while the page is still hydrating (all the assertions
    // above are satisfied by the SSR HTML alone): the native <details> may open
    // before React attaches its onToggle, or React may swallow the discrete
    // event outright. The component now catches up on mount (loads if it finds
    // itself already open), and this retry covers the swallowed-click case —
    // re-clicking after hydration settles.
    const payload = hcCard.getByText(/"records"/);
    await expect(async () => {
      if (!(await payload.isVisible())) await viewRaw.click();
      await expect(payload).toBeVisible({ timeout: 4000 });
    }).toPass({ timeout: 20_000 });
    await expect(hcCard.getByText(/"Steps"/)).toBeVisible();
  });

  test("shows a removed source's history with a Reconnect link, and hides never-set-up sources (issue #294)", async ({
    page,
  }) => {
    await page.goto("/data?section=review");
    const review = page.getByTestId("review-inbox");

    // Only sources that have been set up appear: Health Connect (has sync history)
    // and Strava (connected) both render.
    await expect(review.getByTestId("source-health-connect")).toBeVisible();
    await expect(review.getByTestId("source-strava")).toBeVisible();

    // Oura was connected and later removed — it stays visible because it still has
    // historical logs, but as a "Not connected" card with a Reconnect link back to
    // its setup page (instead of a live Sync now button). A provider with neither a
    // connection nor any sync history is filtered out entirely.
    const oura = review.getByTestId("source-oura");
    await expect(oura).toBeVisible();
    await expect(oura.getByText("Not connected")).toBeVisible();
    const reconnect = oura.getByRole("link", { name: /Reconnect Oura Ring/ });
    await expect(reconnect).toBeVisible();
    await expect(reconnect).toHaveAttribute("href", "/integrations/oura");
    // Its historical sync split is still shown (8 new · 4 changed).
    await expect(oura.getByText("8 new · 4 changed")).toBeVisible();
    // A disconnected source offers no Sync now button.
    await expect(oura.getByRole("button", { name: "Sync now" })).toHaveCount(0);
  });

  test("a dead-token source shows a 'Needs reconnect' card, distinct from 'Not connected' (issue #326)", async ({
    page,
  }) => {
    await page.goto("/data?section=review");
    const review = page.getByTestId("review-inbox");

    // Withings' refresh token died in the seed → the connection flipped to
    // needs_reauth. Its card surfaces the distinct, actionable "Needs reconnect"
    // badge (contrast Oura's benign "Not connected") plus a Reconnect link back to
    // its setup page — never a live Sync now button.
    const withings = review.getByTestId("source-withings");
    await expect(withings).toBeVisible();
    await expect(withings.getByText("Needs reconnect")).toBeVisible();
    const reconnect = withings.getByRole("link", {
      name: /Reconnect Withings/,
    });
    await expect(reconnect).toBeVisible();
    await expect(reconnect).toHaveAttribute("href", "/integrations/withings");
    await expect(
      withings.getByRole("button", { name: "Sync now" })
    ).toHaveCount(0);
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

    // Following the document link lands on its import-detail page. The click can
    // land in the hydration window (React swallows discrete events on a
    // not-yet-hydrated tree — the URL then never changes), and under `next dev`
    // the destination compiles on demand, so retry the click and give the
    // navigation room.
    await expect(async () => {
      if (!/\/import\/\d+/.test(page.url())) {
        await docLink.click({ timeout: 2000 });
      }
      await expect(page).toHaveURL(/\/import\/\d+/, { timeout: 4000 });
    }).toPass({ timeout: 20_000 });
    await expect(
      page.getByRole("link", { name: "Back to Review" })
    ).toBeVisible({ timeout: 15_000 });
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
    // clicked. The trigger is disabled until hydration (#830), so Playwright
    // auto-waits for it to enable before clicking — the open+click no longer
    // lands in the pre-hydration window, so no toPass() retry is needed. The
    // Import-review link inside is already a real Next <Link>.
    const trigger = page.getByTestId("user-menu-trigger");
    const reviewLink = page.getByRole("link", { name: "Import review" });
    await trigger.click();
    await reviewLink.click();
    await expect(page).toHaveURL(/\/data\?section=review/);
    await expect(
      page.getByTestId("review-inbox").getByRole("heading", {
        name: "Imports",
        exact: true,
      })
    ).toBeVisible();
  });
});
