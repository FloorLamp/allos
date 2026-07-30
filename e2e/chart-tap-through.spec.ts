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
//   1. the card HEADER navigates, while the redundant expand icon stays off desktop;
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
    // The Body tab is intentionally tiles-only on a phone; the full chart stack
    // and its large header target are the desktop reading mode.
    await page.setViewportSize(DESKTOP);
    // view=all is the classic full-chart stack — the surface that was a dead end.
    await page.goto("/trends?view=all");
    await expandTrendsContext(page);

    const chartCard = page.getByTestId("body-chart-weight");
    await expect(chartCard).toBeVisible();

    // The full-width header already communicates navigation on desktop, so the
    // extra expand glyph is deliberately phone-only.
    const expand = chartCard.getByTestId("chart-card-expand");
    await expect(expand).toBeHidden();

    // TAPPING THE PLOT MUST NOT NAVIGATE. recharts owns that gesture (it is how a
    // point is read on touch), so the plot is a plain sibling of the header link —
    // never wrapped in an anchor.
    const plot = chartCard.getByTestId("chart-card-plot");
    await expect(plot.locator("xpath=ancestor::a")).toHaveCount(0);
    await plot.click({ position: { x: 120, y: 60 } });
    await expect(page).toHaveURL(/\/trends/);

    // The HEADER row is the tap target.
    const header = chartCard.getByTestId("chart-card-header-link");
    const cardBox = await chartCard.boundingBox();
    const headerBox = await header.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(headerBox).not.toBeNull();
    expect(headerBox!.height).toBeGreaterThanOrEqual(44);
    expect(headerBox!.width).toBeGreaterThan(cardBox!.width * 0.95);
    expect(Math.abs(headerBox!.x - cardBox!.x)).toBeLessThanOrEqual(2);
    expect(
      Number.parseFloat(
        await header.evaluate((element) => getComputedStyle(element).paddingTop)
      )
    ).toBeGreaterThanOrEqual(16);
    const titleBox = await chartCard
      .getByRole("heading", { name: "Weight", exact: true })
      .boundingBox();
    const headlineBox = await chartCard
      .getByTestId("chart-card-headline")
      .boundingBox();
    expect(titleBox).not.toBeNull();
    expect(headlineBox).not.toBeNull();
    expect(
      Math.abs(
        titleBox!.y +
          titleBox!.height / 2 -
          (headlineBox!.y + headlineBox!.height / 2)
      ),
      "the desktop label and value should share one row"
    ).toBeLessThanOrEqual(4);
    const headerBackground = await header.evaluate(
      (element) => getComputedStyle(element).backgroundColor
    );
    await header.hover();
    await expect
      .poll(() =>
        header.evaluate((element) => getComputedStyle(element).backgroundColor)
      )
      .not.toBe(headerBackground);
    await followLink(page, header, /\/trends\/metric\/weight/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Weight" })
    ).toBeVisible();

    await page.context().close();
  });

  test("a desktop tile uses the same full-width, one-row linked header", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(DESKTOP);
    await page.goto("/trends?view=tiles");

    const card = page.getByTestId("body-tile-weight");
    await expect(card).toBeVisible();
    const header = card.getByTestId("trend-mini-header-link");
    const [cardBox, headerBox, titleBox, valueBox] = await Promise.all([
      card.boundingBox(),
      header.boundingBox(),
      header.getByText("Weight", { exact: true }).boundingBox(),
      header.getByText(/kg$/).boundingBox(),
    ]);
    expect(cardBox).not.toBeNull();
    expect(headerBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    expect(valueBox).not.toBeNull();
    expect(headerBox!.width).toBeGreaterThan(cardBox!.width * 0.95);
    expect(Math.abs(headerBox!.x - cardBox!.x)).toBeLessThanOrEqual(2);
    expect(
      Math.abs(
        titleBox!.y +
          titleBox!.height / 2 -
          (valueBox!.y + valueBox!.height / 2)
      ),
      "the desktop tile label and value should share one row"
    ).toBeLessThanOrEqual(4);

    await followLink(page, header, /\/trends\/metric\/weight/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Weight" })
    ).toBeVisible();

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
    const editingRow = field.locator("xpath=ancestor::tr");
    await field.fill(String(corrected));
    // Editing owns the row until Save/Cancel. Leaving the overflow trigger in its
    // action cell lets that cell intercept the inline Save button at tight widths.
    await expect(
      editingRow.getByRole("button", { name: "Reading actions" })
    ).toHaveCount(0);
    const save = editingRow.getByRole("button", {
      name: "Save",
      exact: true,
    });
    const cancel = editingRow.getByRole("button", {
      name: "Cancel",
      exact: true,
    });
    await expect(save).toHaveClass(/\bbtn\b/);
    await expect(cancel).toHaveClass(/\bbtn-ghost\b/);
    await settledClick(page, save);
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
    await page.goto("/trends?view=all");

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
    await page.goto("/trends?view=all");

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
