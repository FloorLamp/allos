import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { followLink } from "./helpers";
import {
  E2E_LOGIN_LONG_RANGE,
  E2E_MEMBER_PASSWORD,
  LONG_RANGE_DAYS,
} from "./fixture-logins";
import { HISTORY_PAGE_SIZE } from "@/lib/pagination";

// Issue #2530 — the Trends body History table renders a PAGE, not the ledger.
//
// The table is deliberately all-time (it is the record editor, so a stray row worth
// deleting has to stay reachable when the charts above are windowed), which is
// exactly why it needs a page: it used to read and serialize every body_metrics row
// the profile had, on every visit to the census.
//
// Driven against the LONG_RANGE fixture, whose profile owns ~8 months of DAILY
// weigh-ins and nothing else — the only fixture where "the row count is the page
// size, not the record count" is a claim with teeth. Read-only login; this spec
// navigates and reads, so --repeat-each stays clean.
test("the body history table pages instead of rendering every row (#2530)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_LONG_RANGE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    // The table only renders at `md:` and up (body-view's stack container).
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto("/trends#body");

    const table = page.getByTestId("body-history-table");
    await expect(table).toBeVisible();
    const rows = table.getByTestId("body-history-row");
    await expect(rows).toHaveCount(HISTORY_PAGE_SIZE);

    // The pager states the whole extent, so a bounded table never reads as
    // "this is everything you ever recorded".
    const pager = page.getByTestId("body-history-pagination");
    await expect(pager).toContainText(
      `Showing 1–${HISTORY_PAGE_SIZE} of ${LONG_RANGE_DAYS}`
    );

    // Each delete control names ITS row, so the accessible names differ.
    const firstDate = (
      await rows.nth(0).getByTestId("body-history-date").innerText()
    ).trim();
    await expect(
      rows.nth(0).getByRole("button", { name: `Delete entry from ${firstDate}` })
    ).toBeVisible();

    // Next is a real navigation: the page rides the URL, so what it turns is the
    // read, and the rows that come back are the NEXT ten.
    await followLink(page, pager.getByRole("link", { name: "Next" }), /bpage=2/);
    const pageTwo = page
      .getByTestId("body-history-table")
      .getByTestId("body-history-row");
    await expect(pageTwo).toHaveCount(HISTORY_PAGE_SIZE);
    await expect(page.getByTestId("body-history-pagination")).toContainText(
      `Showing ${HISTORY_PAGE_SIZE + 1}–${HISTORY_PAGE_SIZE * 2} of ${LONG_RANGE_DAYS}`
    );
    const nextDate = (
      await pageTwo.nth(0).getByTestId("body-history-date").innerText()
    ).trim();
    expect(nextDate).not.toBe(firstDate);
  } finally {
    await page.close();
  }
});
