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
  TRENDS_READINGS_RHR_CLINIC,
  TRENDS_READINGS_RHR_CORRECTED,
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
//      deletes with the chart above updating — including a row that lives in a
//      DIFFERENT STORE from the page's own (#2032): a folded same-identity clinical
//      observation used to be read-only here, because the write path resolved its store
//      from the metric slug;
//
// Fixtures (#868): the read-only Trends Body profile for the navigation half, and a
// dedicated WRITE profile (Trends Readings) for the row CRUD — the spec restores what
// it edits and re-creates nothing shared, so --repeat-each stays clean.

const DESKTOP = { width: 1280, height: 900 };

test.describe("chart tap-through (#1488)", () => {
  test("a Body chart's header opens its detail page; the plot does not navigate", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    // The body census is intentionally tiles-only on a phone; the full chart stack
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
    await followLink(page, header, /\/trends\/metric\/weight/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Weight" })
    ).toBeVisible();

    await page.context().close();
  });

  test("a desktop tile header links to the metric detail", async ({
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

  test("a folded clinical observation is corrected on the stream metric's page (#2032)", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_READINGS,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(DESKTOP);

    // The routing half of the same change: a resting heart rate is a CONTINUOUS
    // reading now, so the reading detail page sends it to the surface that charts it.
    await page.goto("/results/readings/view?name=Resting+Heart+Rate");
    await expect(page).toHaveURL(/\/trends\/metric\/resting-hr$/);

    const table = page.getByTestId("metric-readings-table");
    await expect(table).toBeVisible();
    // The clinic-measured row, addressed by the marker that says it lives elsewhere —
    // not by its value, which this very test changes.
    const observed = table
      .locator("tr")
      .filter({ has: page.getByTestId("metric-reading-observed") });
    await expect(observed).toHaveCount(1);
    // It is offered an action rather than marked read-only.
    await hydratedClick(
      page,
      observed.getByRole("button", { name: "Reading actions" })
    );
    await hydratedClick(page, page.getByRole("menuitem", { name: "Edit" }));
    const field = page.getByLabel("Reading value");
    await field.fill(String(TRENDS_READINGS_RHR_CORRECTED));
    await settledClick(
      page,
      field
        .locator("xpath=ancestor::tr")
        .getByRole("button", { name: "Save", exact: true })
    );

    // The correction landed on the clinical record, and the row still says where the
    // reading was taken.
    await expect(observed).toContainText(
      `${TRENDS_READINGS_RHR_CORRECTED} bpm`
    );
    await expect(observed).toContainText("clinical record");
    await expect(
      table
        .locator("tr")
        .filter({ hasText: `${TRENDS_READINGS_RHR_CLINIC} bpm` })
    ).toHaveCount(0);
    // The chart above is server-rendered from the same rows, so it redrew with it.
    await expect(page.getByTestId("metric-detail-chart")).toBeVisible();

    await page.context().close();
  });
});
