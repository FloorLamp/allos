import { test, expect } from "./fixtures";
import { hydratedClick, settledClick } from "./helpers";
import { frozenNow } from "./worker-env";
// N-of-1 protocols + healthspan pillars (issue #161).
//   1. Full create → compare flow: create a protocol with two body-metric outcomes
//      and a past start date, land on its detail page, and see before/during
//      panels. Self-cleaning (deletes the protocol it created).
//   2. The healthspan-pillars dashboard widget renders, showing at least the
//      optimal-biomarkers pillar (seed profile 1 has labs) — proving the widget
//      renders only the pillars whose data exists.
// The default specs run authenticated as admin acting as profile 1 (storageState).
// Locators are scoped to the main content region to avoid the responsive shell.

test.describe("protocols create → compare (issue #161)", () => {
  test("creates a protocol and shows the before/during comparison", async ({
    page,
  }) => {
    test.slow(); // next dev compiles these routes on first hit

    const uniqueName = `E2E Creatine ${Date.now()}`;
    // A relative past start so the baseline/intervention windows both have seeded
    // weekly body-metric readings (never a hardcoded date that ages out).
    const start = new Date(frozenNow().getTime() - 42 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    await page.goto("/longevity#protocols");
    const main = page.getByRole("main");

    await main.getByTestId("new-protocol-toggle").click();
    const form = page.getByTestId("protocol-form");
    await form.getByLabel("Name").fill(uniqueName);
    await form.locator("#pr-start-new").fill(start);
    // Filling the date field opens its DateField popover, which floats over the
    // outcome picker below — dismiss it before choosing outcomes.
    await page.keyboard.press("Escape");
    const outcomeSearch = form.getByLabel("Filter outcome metrics");
    await outcomeSearch.fill("Body weight");
    await form.getByRole("button", { name: "Body weight" }).click();
    await outcomeSearch.fill("Resting heart rate");
    await form
      .getByRole("button", { name: "Resting heart rate", exact: true })
      .click();
    await form.getByRole("button", { name: "Create protocol" }).click();

    // Redirects to the detail page.
    await page.waitForURL(/\/protocols\/\d+/);
    const detailMain = page.getByRole("main");
    await expect(detailMain.getByTestId("protocol-header")).toContainText(
      uniqueName
    );

    // The comparison section renders per-outcome panels for the two chosen metrics.
    await expect(detailMain.getByTestId("protocol-compare")).toBeVisible();
    await expect(
      detailMain.getByTestId("protocol-outcome-metric:weight")
    ).toBeVisible();
    await expect(
      detailMain.getByTestId("protocol-outcome-metric:resting_hr")
    ).toBeVisible();

    // Edit opens the same wide modal as creation instead of replacing the narrow
    // detail card inline.
    await hydratedClick(
      page,
      detailMain.getByRole("button", { name: "More protocol actions" })
    );
    await page
      .getByRole("menu")
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    const editDialog = page.getByRole("dialog", { name: "Edit protocol" });
    await expect(editDialog).toBeVisible();
    await expect(editDialog.getByLabel("Name")).toHaveValue(uniqueName);
    await editDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(editDialog).toHaveCount(0);

    // End → Resume stays on the same protocol run inside the seven-day window.
    await hydratedClick(
      page,
      detailMain.getByRole("button", { name: "More protocol actions" })
    );
    await page
      .getByRole("menu")
      .getByRole("button", { name: "End now" })
      .click();
    await settledClick(
      page,
      page
        .getByTestId("confirm-dialog")
        .getByRole("button", { name: "End protocol" })
    );
    await expect(detailMain.getByTestId("protocol-header")).not.toContainText(
      "ongoing"
    );

    await hydratedClick(
      page,
      detailMain.getByRole("button", { name: "More protocol actions" })
    );
    await settledClick(
      page,
      page.getByRole("menu").getByRole("button", { name: "Resume" })
    );
    await expect(detailMain.getByTestId("protocol-header")).toContainText(
      "ongoing"
    );

    // Self-clean: delete it through the app confirmation.
    await hydratedClick(
      page,
      detailMain.getByRole("button", { name: "More protocol actions" })
    );
    await page
      .getByRole("menu")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await settledClick(
      page,
      page
        .getByTestId("confirm-dialog")
        .getByRole("button", { name: "Delete protocol" })
    );
    await page.waitForURL(/\/longevity(?:#|$)/);
    await expect(page.getByRole("main")).not.toContainText(uniqueName);
  });

  test("starts an expired protocol as a new run and preserves the old run", async ({
    page,
  }) => {
    test.slow();
    const uniqueName = `E2E Restart ${frozenNow().getTime()}`;
    const end = new Date(frozenNow().getTime() - 20 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const start = new Date(frozenNow().getTime() - 50 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    await page.goto("/longevity#protocols");
    const main = page.getByRole("main");
    await main.getByTestId("new-protocol-toggle").click();
    const form = page.getByTestId("protocol-form");
    await form.getByLabel("Name").fill(uniqueName);
    await form.locator("#pr-start-new").fill(start);
    await page.keyboard.press("Escape");
    await form.locator("#pr-end-new").fill(end);
    await page.keyboard.press("Escape");
    await settledClick(
      page,
      form.getByRole("button", { name: "Create protocol" })
    );
    await page.waitForURL(/\/protocols\/\d+/);
    const oldUrl = page.url();
    const detailMain = page.getByRole("main");

    await hydratedClick(
      page,
      detailMain.getByRole("button", { name: "More protocol actions" })
    );
    await settledClick(
      page,
      page.getByRole("menu").getByRole("button", { name: "Run again" })
    );
    await page.waitForURL((url) => url.href !== oldUrl);
    const newUrl = page.url();
    expect(newUrl).not.toBe(oldUrl);
    await expect(detailMain.getByTestId("protocol-header")).toContainText(
      "ongoing"
    );

    // The expired run remains addressable after the new run starts.
    await page.goto(oldUrl);
    await expect(detailMain.getByTestId("protocol-header")).not.toContainText(
      "ongoing"
    );

    // Clean up both runs.
    for (const url of [oldUrl, newUrl]) {
      await page.goto(url);
      await hydratedClick(
        page,
        detailMain.getByRole("button", { name: "More protocol actions" })
      );
      await page
        .getByRole("menu")
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await settledClick(
        page,
        page
          .getByTestId("confirm-dialog")
          .getByRole("button", { name: "Delete protocol" })
      );
      await page.waitForURL(/\/longevity(?:#|$)/);
    }
    await expect(page.getByRole("main")).not.toContainText(uniqueName);
  });
});

// #592: the protocol "Recovery gear" selector must offer only recovery (+
// uncategorized) gear, not the whole inventory. Profile 1 owns a seeded recovery
// "E2E Protocol Sauna" and a strength "E2E Protocol Barbell" (see seed-events); the
// add form's gear select must list the sauna and exclude the barbell (and the
// cardio Road Bike). Read-only — never submits — so it leaves the seed untouched.
test.describe("protocols recovery-gear filter (#592)", () => {
  test("the gear selector offers recovery gear but not a barbell", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/longevity#protocols");
    await page.getByTestId("new-protocol-toggle").click();
    const select = page.getByTestId("protocol-equipment");
    await expect(select).toBeVisible();

    // The recovery sauna is offered.
    await expect(
      select.locator("option", { hasText: "E2E Protocol Sauna" })
    ).toHaveCount(1);
    // The strength barbell and the cardio bike are filtered out.
    await expect(
      select.locator("option", { hasText: "E2E Protocol Barbell" })
    ).toHaveCount(0);
    await expect(
      select.locator("option", { hasText: "Road Bike" })
    ).toHaveCount(0);
  });
});

test.describe("healthspan pillars widget (issue #161)", () => {
  test("renders the pillars widget with available pillars", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/");
    const main = page.getByRole("main");
    const widget = main.getByTestId("healthspan-pillars-widget");
    await expect(widget).toBeVisible();
    // Seed profile 1 has labs, so the optimal-biomarkers pillar is available.
    await expect(widget.getByTestId("pillar-optimal-biomarkers")).toBeVisible();
  });
});
