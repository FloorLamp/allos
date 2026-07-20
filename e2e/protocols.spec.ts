import { test, expect } from "@playwright/test";

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
    const start = new Date(Date.now() - 42 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    await page.goto("/longevity#protocols");
    const main = page.getByRole("main");

    const form = main.getByTestId("protocol-form");
    await form.getByLabel("Name").fill(uniqueName);
    await main.locator("#pr-start-new").fill(start);
    // Filling the date field opens its DateField popover, which floats over the
    // outcome-metric checkboxes below and would intercept their clicks — dismiss
    // it (the picker closes on Escape) before checking the boxes.
    await page.keyboard.press("Escape");
    await form.getByRole("checkbox", { name: "Body weight" }).check();
    // Resting HR is offered from two metric namespaces (a device `metric:` and a
    // discrete `biomarker:` reading), so its label matches two checkboxes — target
    // the device-metric one unambiguously by value.
    await form
      .locator('input[name="outcome_keys"][value="metric:resting_hr"]')
      .check();
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

    // Self-clean: delete it (confirm dialog) and confirm it drops off the list.
    page.on("dialog", (d) => d.accept());
    await detailMain.getByRole("button", { name: "Delete" }).click();
    await page.waitForURL(/\/longevity(?:#|$)/);
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
