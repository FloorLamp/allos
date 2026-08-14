import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { hydratedClick, openAllSyncDays } from "./helpers";
import { E2E_LOGIN_SYNC_HISTORY, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { frozenNow } from "./worker-env";

// #1991 — sync history is not an event log.
//
// A source that fires ~70×/day turned the per-run table into "Synced · N new ·
// 4 changed · 73 unchanged" over and over; the repeating "73 unchanged" is the tell
// that it is not news, and a real anomaly was invisible in that stream. These drive
// the redesign's four claims on the rendered page:
//
//   1. a day of pushes is ONE line, expanding to only what earned it;
//   2. the drill-in promises what it can LIST, never the run's split total;
//   3. the status card answers and stops — no second copy of the newest run;
//   4. the raw payload is admin-only and opens a dialog, not the page.
//
// The high-frequency stream lives on its own fixture profile (SYNC_HISTORY_PROFILE),
// seeded in e2e/seed/integrations.ts, because these assertions are about a stream
// nothing else may add to.

test.describe("day-grouped sync history (#1991)", () => {
  test("a busy day stays one line inside complete-day pagination", async ({
    browser,
  }) => {
    test.slow();
    const member = await loginAs(
      browser,
      {
        username: E2E_LOGIN_SYNC_HISTORY,
        password: E2E_MEMBER_PASSWORD,
      },
      // Deliberately differs from the profile's fixed-offset timezone. The ledger
      // must render the clock that assigned the profile-local day, not this one.
      { timezoneId: "Asia/Kathmandu" }
    );
    try {
      await member.goto("/integrations/health-connect");
      const history = member.getByTestId("sync-history");
      await expect(history).toBeVisible();

      // The first page is seven COMPLETE local days, not seven runs.
      const days = history.getByTestId("sync-day-summary");
      await expect(days).toHaveCount(7);
      // The ledger leads with the calendar hierarchy, then aligns the expanded
      // details under stable scan columns instead of flowing every fact together.
      const newestGroup = history.locator("details[open]");
      const newestDay = newestGroup.getByTestId("sync-day-summary");
      await expect(newestDay.getByTestId("sync-day-name")).toHaveText("Today");
      await expect(
        newestGroup.getByText("Changes and details", { exact: true })
      ).toBeVisible();
      const expectedProfileClock = `13:${String(frozenNow().getUTCMinutes()).padStart(2, "0")}`;
      const latestRun = history
        .getByTestId("sync-history-latest")
        .locator("xpath=ancestor::li[1]");
      await expect(latestRun.locator("time")).toHaveText(expectedProfileClock);
      await expect(latestRun.locator("time")).toHaveAttribute(
        "title",
        new RegExp(`, ${expectedProfileClock}$`)
      );
      // It counts runs in the source's own noun and carries the day's totals.
      await expect(newestDay).toContainText("30 pushes");
      await expect(newestDay).toHaveText(/30 pushes · \d+ new · \d+ changed/);
      // …and the day's ONE anomaly is on that line, so you never have to hunt it.
      await expect(newestDay).toContainText("6 skipped");

      // The newest day opens by default — it is what you came to check. Inside it,
      // the routine middle is a RANGE, not a row per push.
      const range = history.getByTestId("sync-history-range");
      await expect(range).toHaveCount(2); // before and after the anomaly
      await expect(range.nth(0)).toContainText("Routine");
      await expect(range.nth(0)).toContainText(/\d+ pushes/);

      // The individual runs stay reachable; they are just not the default view.
      const before = await history.getByTestId(/^sync-run-/).count();
      await range.nth(0).getByTestId("sync-history-show-each").click();
      await expect
        .poll(async () => history.getByTestId(/^sync-run-/).count())
        .toBeGreaterThan(before);

      // Opening another day is a user choice, not a render default. Appending an
      // older page must preserve it instead of resetting the disclosure list.
      const secondDay = history.locator("details").nth(1);
      await secondDay.locator("summary").click();
      await expect(secondDay).toHaveJSProperty("open", true);

      // Older history appends by whole day and exhausts after the final two days.
      const loadOlder = history.getByTestId("sync-history-load-older");
      await loadOlder.click();
      await expect(days).toHaveCount(9);
      await expect(secondDay).toHaveJSProperty("open", true);
      await expect(loadOlder).toHaveCount(0);

      // The WINDOW column is gone: structurally constant for this source, and the
      // rows never carried signal with it.
      await expect(
        history.getByRole("columnheader", { name: "Window" })
      ).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });

  test("the drill-in counts what it can show, and names the rest", async ({
    browser,
  }) => {
    test.slow();
    const member = await loginAs(browser, {
      username: E2E_LOGIN_SYNC_HISTORY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/health-connect");
      const history = member.getByTestId("sync-history");
      await expect(history).toBeVisible();

      // The newest push's split says 30 records (20 new + 10 changed), but only two
      // of them have an openable identity. The label used to say 30 and open onto
      // two — the count overstating by an order of magnitude while looking complete.
      const drill = history.getByText("What this wrote —", { exact: false });
      await expect(drill).toHaveText("What this wrote — 2 records");

      // Opening it lists exactly those two and NAMES the remainder rather than
      // pretending the rest are openable.
      // hydratedClick, not a re-click loop (#2729): the SSR markup satisfies the
      // assertions above, so the discrete onToggle can still be swallowed here — and
      // a <details> is a real toggle, so a retry whose guard has not caught up
      // closes what the previous click opened. One click, after the marker.
      const walk = history.getByRole("link", { name: /Day-group walk/ });
      await hydratedClick(member, drill, { timeout: 20_000 });
      await expect(walk).toBeVisible({ timeout: 20_000 });
      await expect(history.getByText(/\+28 more this run wrote/)).toBeVisible();
      await expect(history.getByText(/not itemizable/)).toBeVisible();
    } finally {
      await member.context().close();
    }
  });

  test("the status card answers and stops — the newest run is not on screen twice", async ({
    browser,
  }) => {
    test.slow();
    const member = await loginAs(browser, {
      username: E2E_LOGIN_SYNC_HISTORY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/health-connect");
      const main = member.getByRole("main");

      // The card states the standing and today's AGGREGATE, in the push vocabulary.
      const status = main.getByTestId("sync-period-health-connect");
      await expect(status).toContainText("Receiving normally");
      await expect(status).toContainText(/\d+ pushes today/);
      await expect(status).toContainText("records added");

      // The duplicate-text tripwire: the newest run's drill-in exists exactly ONCE
      // on the page — in the history that owns it — and nothing in the status card
      // restates it.
      await expect(
        main.getByText("What this wrote —", { exact: false })
      ).toHaveCount(1);
      await expect(
        status.getByText("What this wrote", { exact: false })
      ).toHaveCount(0);
      // The inline raw viewer is gone from this page entirely: it is a dialog now.
      await expect(main.getByText("View raw", { exact: true })).toHaveCount(0);

      // The page is centred through the shared container, not left against the edge.
      const container = main.getByTestId("integration-page");
      await expect(container).toHaveClass(/max-w-3xl/);
      await expect(container).toHaveClass(/mx-auto/);
    } finally {
      await member.context().close();
    }
  });

  test("the raw payload is admin-only and opens a dialog rather than the page", async ({
    page,
  }) => {
    // The shared admin session, on the seeded Strava source page: its partial run
    // carries a captured payload.
    await page.goto("/integrations/strava");
    const history = page.getByTestId("sync-history");
    await expect(history).toBeVisible();

    // Every day is collapsed except the newest, so open them all — the seeded runs
    // span three days and the payload's run is not on the newest.
    await openAllSyncDays(history);

    const open = history.getByTestId(/^raw-payload-open-/);
    await expect(open).toHaveCount(1);
    // It is a LINK-sized affordance, not a JSON tree: nothing is rendered until it
    // is asked for.
    await expect(page.getByTestId("raw-data-viewer")).toHaveCount(0);

    await open.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("raw-data-viewer")).toBeVisible();
    await expect(
      dialog.getByText("Fixture ride", { exact: false })
    ).toBeVisible();
  });

  test("a member never sees the raw payload affordance", async ({
    browser,
  }) => {
    test.slow();
    const member = await loginAs(browser, {
      username: E2E_LOGIN_SYNC_HISTORY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/health-connect");
      await expect(member.getByTestId("sync-history")).toBeVisible();
      await expect(member.getByTestId(/^raw-payload-open-/)).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });
});
