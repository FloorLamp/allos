import { test, expect } from "./fixtures";
import { followLink, hydratedClick, openAllSyncDays } from "./helpers";

// Dogfoods the Data → Review import inbox (the feature that motivated this tier).
// After issue #208 the surface is split into sections; since #1880 the inbox order
// is attention → duplicates → connected sources → imports → tools, and the
// "Needs attention" card IS the escalated source's card — chip, reason, consequence,
// and all its actions once — rather than a summary row duplicating a source card
// 200px below.
//
// Since #1772 "Connected sources" is an INBOX rendered through the shared state model
// (lib/integrations/source-state): a source with something unfinished is expanded
// with the reason and the action, a healthy one collapses to a single line, and the
// full per-source history lives on the source's own page (see the setup-page
// specs below and weather-uv.spec.ts).
test.describe("Data → Review import inbox", () => {
  test("renders the failing source ONCE, fully, under Needs attention (#1880)", async ({
    page,
  }) => {
    await page.goto("/data?section=review");
    // Scope to the review panel — the (hidden) Import tab also mentions the
    // sources, so a page-wide text match would resolve to hidden nodes.
    const review = page.getByTestId("review-inbox");

    // The Imports section header (renamed from "Recent imports").
    await expect(
      review.getByRole("heading", { name: "Imports", exact: true })
    ).toBeVisible();

    // Strava (its last success is past the staleness threshold, so its standing
    // escalates) renders its FULL card inside "Needs attention": standing chip,
    // reason, user-terms consequence, and its actions together. The alert IS the
    // card.
    const attention = review.getByTestId("needs-attention-sources");
    await expect(attention.getByText("Needs attention")).toBeVisible();
    const stravaCard = attention.getByTestId("source-strava");
    await expect(stravaCard.getByTestId("sync-status-strava")).toContainText(
      "Sync failing"
    );
    await expect(
      stravaCard.getByText(/Strava token refresh failed/)
    ).toBeVisible();
    await expect(
      stravaCard.getByTestId("source-consequence-strava")
    ).toContainText("New runs and rides have stopped arriving.");
    await expect(
      stravaCard.getByRole("button", { name: "Sync now" })
    ).toBeVisible();
    const fullHistory = stravaCard.getByTestId("source-history-link-strava");
    await expect(fullHistory).toHaveAttribute("href", "/integrations/strava");

    // THE duplicate-rendering tripwire: the failure reason appears exactly once on
    // the whole Review surface — the #1772 disease (attention row + source card
    // restating the same 401 with different buttons) stays dead. (Scoped to
    // Strava's own message: the seeded Withings card has a 401 of its own.)
    await expect(review.getByText(/Strava token refresh failed/)).toHaveCount(
      1
    );
    // And the escalated source is NOT listed again under Connected sources.
    await expect(
      review.getByTestId("connected-sources").getByTestId("source-strava")
    ).toHaveCount(0);

    // "Connected sources": one card per recurring source, collapsed to latest state.
    await expect(
      review.getByRole("heading", { name: "Connected sources" })
    ).toBeVisible();

    // Health Connect's card shows its latest sync split (30 new · 10 changed) and,
    // being push-only, an explainer instead of a Sync now button.
    const hcCard = review.getByTestId("source-health-connect");
    await expect(hcCard.getByText("Google Health Connect")).toBeVisible();
    await expect(hcCard.getByText("30 new · 10 changed")).toBeVisible();
    // The origin reconciliation renders once now — the inbox card shows the latest
    // state only, so there is no history copy of the same line to disambiguate.
    await expect(
      hcCard.getByText(
        "Total calories: Garmin used · Fitbit ignored as duplicate"
      )
    ).toBeVisible();
    await expect(hcCard.getByText(/Push-only/)).toBeVisible();

    // Admin-only raw payload viewer (#9): the seeded Health Connect sync carries a
    // raw_ref, so the admin (the seed logs in as admin) sees a "View raw"
    // affordance on the source card. Expanding it lazily fetches the admin-gated,
    // profile-scoped raw route, which returns the captured source JSON — now
    // rendered through the shared RawDataViewer as a collapsible tree (#1318), not
    // a flat <pre>.
    const viewRaw = hcCard.getByText("View raw");
    await expect(viewRaw).toBeVisible();
    // The click can land while the page is still hydrating (all the assertions
    // above are satisfied by the SSR HTML alone): the native <details> may open
    // before React attaches its onToggle, or React may swallow the discrete
    // event outright. The component now catches up on mount (loads if it finds
    // itself already open), and this retry covers the swallowed-click case —
    // re-clicking after hydration settles.
    const viewer = hcCard.getByTestId("raw-data-viewer");
    await expect(async () => {
      if (!(await viewer.isVisible())) await viewRaw.click();
      await expect(viewer).toBeVisible({ timeout: 4000 });
    }).toPass({ timeout: 20_000 }); // topass-ok: re-click the <details> until the tree loads — SSR satisfies the earlier asserts, so the discrete onToggle can be swallowed pre-hydration; no POST to settle on
    // The captured JSON is navigable: the top-level "records" key renders in the
    // tree; expanding reveals the nested "Steps" value (depth-collapsed by default).
    await expect(viewer.getByText("records:", { exact: false })).toBeVisible();
    await viewer.getByTestId("raw-expand-all").click();
    await expect(viewer.getByText(/"Steps"/)).toBeVisible();

    // Saving the payload to a file. The captured source payload is JSON, so the
    // format-aware button offers JSON and names the file after the sync event it came
    // from (the XML counterpart is asserted in import-records-browser.spec.ts).
    const downloadBtn = viewer.getByTestId("raw-download");
    await expect(downloadBtn).toHaveText(/Download JSON/);
    const [saved] = await Promise.all([
      page.waitForEvent("download"),
      downloadBtn.click(),
    ]);
    expect(saved.suggestedFilename()).toMatch(/^sync-payload-\d+\.json$/);
  });

  test("the sync provenance drill-in lists written records with working deep links (#1333)", async ({
    page,
  }) => {
    await page.goto("/data?section=review");
    const review = page.getByTestId("review-inbox");
    const hcCard = review.getByTestId("source-health-connect");
    await expect(hcCard).toBeVisible();

    // The healthy Health Connect sync wrote records (seed provenance rows), so the
    // card carries a "What this wrote" drill-in. It's behind a <details> with the
    // same pre-hydration swallow as the raw viewer — re-click until the list loads.
    const drill = hcCard.getByText("What this wrote", { exact: false });
    await expect(drill).toBeVisible();
    const provRun = hcCard.getByRole("link", { name: /HC provenance run/ });
    await expect(async () => {
      if (!(await provRun.isVisible())) await drill.click();
      await expect(provRun).toBeVisible({ timeout: 4000 });
    }).toPass({ timeout: 20_000 }); // topass-ok: re-click the <details> until the provenance list loads — SSR satisfies the earlier asserts, so the discrete onToggle can be swallowed pre-hydration

    // The inserted run carries a "new" disposition badge — scoped to the run's own
    // link (spec-owned fixture) so it's an exact, single match, no ordinal.
    await expect(provRun.getByText("new", { exact: true })).toBeVisible();
    await expect(provRun).toHaveAttribute(
      "href",
      /\/timeline\?from=2026-07-08/
    );
    // The deep link navigates to that record's timeline day.
    await provRun.click();
    await expect(page).toHaveURL(/\/timeline\?from=2026-07-08/);
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
    // its setup page (instead of a live Sync now button). A source with neither a
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

  // #1772 moved the per-source history home to the source's own page and made it
  // a real table. These two assert the properties the redesign was FOR: a truncated
  // run still reads as partial rather than a clean success (#1614), and a failure row
  // that is no longer the latest still carries its reason.
  test("the provider's own page owns the sync-history table (#1772)", async ({
    page,
  }) => {
    await page.goto("/integrations/strava");
    const history = page.getByTestId("sync-history");
    await expect(history).toBeVisible();
    await openAllSyncDays(history);
    await expect(history.getByTestId("sync-history-latest")).toHaveCount(1);

    // The window the runs cover is stated ONCE above the history instead of
    // repeating verbatim on every row (and since #1991 it is the only place it
    // appears — the structurally-constant Window column is gone).
    await expect(history.getByTestId("sync-history-window")).toContainText(
      "2026-07-01 → 2026-07-08"
    );

    // The four consecutive hourly no-op re-scans collapse to a single line (#137,
    // generalized to "nothing NOTABLE happened" by #1991) rather than filling four
    // slots with rows that say nothing.
    // (How many land on which day depends on the run's pinned timezone, so assert
    // the SHAPE of the collapsed line rather than a count that would drift.)
    const routine = history.getByTestId("sync-history-range");
    expect(await routine.count()).toBeGreaterThan(0);
    for (const row of await routine.all()) {
      await expect(row).toContainText("Routine");
      await expect(row).toContainText(/\d+ syncs/);
    }

    // The seeded truncated run reports what it DID land and is explicitly marked
    // partial, so a page cap / rate limit can't read as a fully green sync.
    await expect(history.getByText("Partial", { exact: true })).toBeVisible();
    await expect(
      history.getByText(/page cap or rate limit stopped this run early/)
    ).toBeVisible();
    await expect(
      history.getByText(/next sync picks up where it left off/)
    ).toBeVisible();
  });

  test("a history failure row exposes its reason, not just 'Failed' (#1772)", async ({
    page,
  }) => {
    await page.goto("/integrations/strava");
    const history = page.getByTestId("sync-history");
    await expect(history).toBeVisible();
    await openAllSyncDays(history);

    // The newest Strava event is a failure — its reason shows, as it always did.
    await expect(
      history.getByText(/Strava token refresh failed \(401\)/)
    ).toBeVisible();
    // And the OLDER failure, which is not the latest event, states its own distinct
    // reason too. That row used to render a bare "Sync failed" with no explanation
    // anywhere in the UI.
    await expect(
      history.getByText(/rate limit reached \(429\): daily quota exhausted/)
    ).toBeVisible();
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

  test("the Imports feed merges documents, paste jobs, and archive imports—not recurring syncs", async ({
    page,
  }) => {
    await page.goto("/data?section=review");
    const feed = page.getByTestId("import-feed");

    // The successfully-extracted document links to its /import/[id] verify/detail
    // view. The seed's e2e-labs.pdf carries an extracted_count SNAPSHOT of 7 but
    // NO live rows — the #1339 drift — so the feed shows the reconciled "0 of 7
    // items" (live of extracted), never a bare "7 items" that would contradict the
    // detail page one click away. "items", not "records": the tally spans every
    // clinical kind an import writes (#212).
    const docLink = feed.getByRole("link", { name: "e2e-labs.pdf" });
    await expect(docLink).toBeVisible();
    await expect(docLink).toHaveAttribute("href", /\/import\/\d+/);
    // Scope to e2e-labs.pdf's own row: it shows the reconciled "0 of 7 items", never
    // a bare "7 items" that reads as a current count. (Other seed docs legitimately
    // show "N items" when their live count matches the snapshot, so don't assert a
    // page-wide absence of "7 items".)
    const labsRow = feed
      .getByRole("listitem")
      .filter({ hasText: "e2e-labs.pdf" });
    await expect(
      labsRow.getByText("0 of 7 items", { exact: true })
    ).toBeVisible();
    await expect(labsRow.getByText("7 items", { exact: true })).toHaveCount(0);

    // A rejected upload (inserted straight into a terminal 'failed' state — the
    // path the toast bug missed) still surfaces in the feed.
    await expect(feed.getByText("e2e-broken.txt")).toBeVisible();
    await expect(feed.getByText("import failed")).toBeVisible();

    // A pasted/CSV job shows in the same feed and points back to the importer.
    await expect(feed.getByText("Pasted labs")).toBeVisible();
    await expect(feed.getByText(/review to save/)).toBeVisible();

    // The one-off Fitbit Takeout event is an archive import, so its accounting lives
    // here rather than masquerading as a recurring connection.
    const fitbit = feed
      .getByRole("listitem")
      .filter({ hasText: "Fitbit (Google Takeout)" });
    await expect(fitbit).toBeVisible();
    await expect(fitbit.getByText("3 new · 2 unchanged")).toBeVisible();

    // Recurring integration syncs are NOT in this feed — they live in the
    // "Connected sources" section above. The seeded no-op Strava rows would produce
    // "No new data" if they leaked into this one-off list.
    await expect(feed.getByText("No new data")).toHaveCount(0);

    // Following the document link lands on its import-detail page. A click can
    // land in the pre-hydration swallow window (the URL then never changes) —
    // followLink retries past it (#889 sweep; replaces the hand-rolled toPass).
    await followLink(page, docLink, /\/import\/\d+/);
    await expect(
      page.getByRole("link", { name: "Back to Review" })
    ).toBeVisible({ timeout: 15_000 });
    // The detail page reconciles the SAME two numbers (#1339/#221): the snapshot
    // vs what remains, naming why the rows are gone — not the bare, contradictory
    // "This import produced no records."
    await expect(page.getByTestId("produced-summary")).toHaveText(
      "7 extracted · 0 remain (7 deleted, merged, or reassigned)"
    );
    await expect(
      page.getByText("This import produced no records.")
    ).toHaveCount(0);
  });

  test("the re-run-extraction-on-all button previews the AI cost before confirming", async ({
    page,
  }) => {
    await page.goto("/data?section=review");
    const review = page.getByTestId("review-inbox");

    // The rescoped batch button lives in the Imports section header and reads
    // unambiguously — the #1071 vocabulary names the whole family by what differs.
    const button = review.getByTestId("reprocess-all");
    await expect(button).toHaveText(/Re-run extraction on all documents/);
    // Opens a confirm dialog from client state — no POST, no navigation — so a
    // tap landing before React attaches the handler is simply lost and the
    // dialog assertion below then waits out its whole timeout on a page that was
    // never asked to open one. Decision-tree case 3: click ONCE, after hydration.
    await hydratedClick(page, button);

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

  test("shows the review count on the Data nav entry (#1801)", async ({
    page,
  }) => {
    await page.goto("/");
    // The badge folded into the Data nav item when the profile menu it used to
    // hang on retired: it is Data → Review's number, so it badges the Data entry.
    const badge = page.getByTestId("review-badge").first(); // first-ok: the badge renders in the desktop sidebar AND the (hidden) mobile drawer's shared Nav; either mirror carries the same count
    await expect(badge).toBeVisible();
    // The badge sums currently-failing integrations (Strava, always present) and
    // any unresolved detected duplicate pairs (issue #10). The exact count depends
    // on whether the dedup spec has merged its fixture yet (shared seeded DB), so
    // assert only that the always-present failing integration keeps it >= 1; the
    // exact 2 -> 1 transition is asserted in import-dedup.spec, which owns that
    // fixture's lifecycle.
    expect(Number(await badge.textContent())).toBeGreaterThanOrEqual(1);
    // The badged entry is the Data one, not some other row that happens to sit
    // beside it.
    await expect(
      page
        .locator("aside nav")
        .getByRole("link", { name: /^Data/ })
        .getByTestId("review-badge")
    ).toBeVisible();
  });

  test("the tab is reachable from the badged Data nav entry", async ({
    page,
  }) => {
    await page.goto("/");
    // Nav anchor → followLink (#889 sweep); followLink retries the nav until the
    // URL commits.
    await followLink(
      page,
      page.locator("aside nav").getByRole("link", { name: /^Data/ }),
      /\/data/
    );
    await followLink(
      page,
      page.getByRole("link", { name: /^Review/ }),
      /\/data\?section=review/
    );
    await expect(
      page.getByTestId("review-inbox").getByRole("heading", {
        name: "Imports",
        exact: true,
      })
    ).toBeVisible();
  });
});
