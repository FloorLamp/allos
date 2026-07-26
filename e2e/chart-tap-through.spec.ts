import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { expandTrendsContext } from "./trends-chrome";
import { followLink, settledClick, hydratedClick } from "./helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_TRENDS_BODY,
  E2E_LOGIN_TRENDS_READINGS,
  TRENDS_READINGS_HRV_MANUAL,
  TRENDS_READINGS_HRV_SYNCED,
} from "./fixture-logins";

// Chart tap-through (issue #1488): every full-size Trends chart reaches its
// full-depth detail page, and the detail page carries the readings table that is
// #1397's fix home.
//
// The four properties under test, in the issue's own terms:
//   1. the card HEADER navigates, and the EXPAND icon is accessible-named;
//   2. tapping the PLOT shows a tooltip and does NOT navigate — on touch that gesture
//      is how you read a point, and it must never become navigation;
//   3. the detail page renders the readings table, and a row's ⋯ menu edits and
//      deletes with the chart above updating;
//   4. an empty chart card and a populated one occupy the SAME box (the mobile square
//      rule), and desktop card proportions are unchanged by it.
//
// Fixtures (#868): the read-only Trends Body profile for the navigation half, and a
// dedicated WRITE profile (Trends Readings) for the row CRUD — the spec restores what
// it edits and re-creates nothing shared, so --repeat-each stays clean.

const PHONE = { width: 360, height: 800 };
const DESKTOP = { width: 1280, height: 900 };

test.describe("chart tap-through (#1488)", () => {
  test("a Body chart's header opens its detail page; the plot does not navigate", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(PHONE);
    // view=all is the classic full-chart stack — the surface that was a dead end.
    await page.goto("/trends?tab=body&view=all");
    await expandTrendsContext(page);

    const stepsCard = page.locator("#steps");
    await expect(stepsCard).toBeVisible();

    // The expand icon carries an accessible name (#794 7a) rather than being a
    // nameless glyph.
    const expand = stepsCard.getByTestId("chart-card-expand");
    await expect(expand).toHaveAttribute("aria-label", "Open steps detail");

    // TAPPING THE PLOT MUST NOT NAVIGATE. recharts owns that gesture (it is how a
    // point is read on touch), so the plot is a plain sibling of the header link —
    // never wrapped in an anchor.
    const plot = stepsCard.getByTestId("chart-card-plot");
    await expect(plot.locator("xpath=ancestor::a")).toHaveCount(0);
    await plot.click({ position: { x: 120, y: 60 } });
    await expect(page).toHaveURL(/\/trends\?tab=body/);

    // The HEADER row is the tap target.
    const header = stepsCard.getByTestId("chart-card-header-link");
    await followLink(page, header, /\/trends\/metric\/steps/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Steps per day" })
    ).toBeVisible();

    await page.context().close();
  });

  test("the expand icon reaches the same detail page as the header", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(DESKTOP);
    await page.goto("/trends?tab=body&view=all");

    const card = page.locator("#hr");
    await expect(card).toBeVisible();
    await followLink(
      page,
      card.getByTestId("chart-card-expand"),
      /\/trends\/metric\/hr/
    );
    await expect(page.getByTestId("metric-period-stats")).toBeVisible();
    // A DERIVED metric says why it has no editable readings instead of showing an
    // empty table that reads as missing data.
    await expect(page.getByTestId("metric-readings")).toContainText(
      /computed from/i
    );

    await page.context().close();
  });

  test("the detail page's readings table edits and deletes a reading", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_READINGS,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(DESKTOP);
    await page.goto("/trends/metric/hrv");

    const table = page.getByTestId("metric-readings-table");
    await expect(table).toBeVisible();
    // Two seeded HRV readings, addressed by their DISTINCT values rather than by
    // position, so a row-order change can't silently retarget the edit.
    const manualRow = table
      .locator("tr")
      .filter({ hasText: `${TRENDS_READINGS_HRV_MANUAL} ms` });
    const syncedRow = table
      .locator("tr")
      .filter({ hasText: `${TRENDS_READINGS_HRV_SYNCED} ms` });
    await expect(manualRow).toHaveCount(1);
    await expect(syncedRow).toHaveCount(1);

    // ── Edit ──────────────────────────────────────────────────────────────────
    const corrected = TRENDS_READINGS_HRV_MANUAL + 9;
    await hydratedClick(
      page,
      manualRow.getByRole("button", { name: "Reading actions" })
    );
    await hydratedClick(page, page.getByRole("menuitem", { name: "Edit" }));
    const field = page.getByLabel("Reading value");
    await field.fill(String(corrected));
    await settledClick(
      page,
      page.getByRole("button", { name: "Save", exact: true })
    );
    await expect(
      table.locator("tr").filter({ hasText: `${corrected} ms` })
    ).toHaveCount(1);
    // The chart above is server-rendered from the same rows, so it redrew with it.
    await expect(page.getByTestId("metric-detail-chart")).toBeVisible();

    // ── Delete ────────────────────────────────────────────────────────────────
    await hydratedClick(
      page,
      syncedRow.getByRole("button", { name: "Reading actions" })
    );
    await hydratedClick(page, page.getByRole("menuitem", { name: "Delete" }));
    await settledClick(
      page,
      page.getByRole("button", { name: "Delete", exact: true })
    );
    await expect(
      table
        .locator("tr")
        .filter({ hasText: `${TRENDS_READINGS_HRV_SYNCED} ms` })
    ).toHaveCount(0);

    await page.context().close();
  });

  test("an empty chart card and a populated one occupy the same box on mobile", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(PHONE);
    await page.goto("/trends?tab=body&view=all");

    // Every chart card's PLOT commits to the same square below `sm`, whatever its
    // state — that is what stops a stack reflowing because one series is empty.
    const plots = page.getByTestId("chart-card-plot");
    const count = await plots.count();
    expect(count).toBeGreaterThan(1);
    const boxes = [];
    for (let i = 0; i < count; i++) {
      const box = await plots.nth(i).boundingBox();
      if (box && box.width > 0) boxes.push(box);
    }
    for (const box of boxes) {
      // 1:1, within a pixel of rounding.
      expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(2);
    }

    await page.context().close();
  });

  test("desktop chart-card proportions are unchanged by the mobile square rule", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(DESKTOP);
    await page.goto("/trends?tab=body&view=all");

    // The default full-size plot is h-64 (256px) from `sm` up — the pre-#1488
    // height — and is WIDER than it is tall, i.e. not the square.
    const plot = page.locator("#steps").getByTestId("chart-card-plot");
    const box = await plot.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.height)).toBe(256);
    expect(box!.width).toBeGreaterThan(box!.height);

    await page.context().close();
  });
});
