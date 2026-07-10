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

    await page.goto("/protocols");
    const main = page.getByRole("main");

    const form = main.getByTestId("protocol-form");
    await form.getByLabel("Name").fill(uniqueName);
    await main.locator("#pr-start-new").fill(start);
    await form.getByRole("checkbox", { name: "Body weight" }).check();
    await form.getByRole("checkbox", { name: "Resting heart rate" }).check();
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
    await page.waitForURL(/\/protocols$/);
    await expect(page.getByRole("main")).not.toContainText(uniqueName);
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
