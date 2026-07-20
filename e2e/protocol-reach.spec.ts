import { test, expect } from "@playwright/test";
import { followLink, settledClick } from "./helpers";

// Protocol reach (issue #660): chart annotations, the active-protocol dashboard
// widget, and the direct intake-item link. The default specs run authenticated as
// admin acting as profile 1 (storageState), which owns the seeded ongoing
// "Creatine 5 g/day" protocol (linked to the seeded Creatine supplement) plus LDL
// labs. Locators are scoped to the main content region to avoid the responsive shell.

test.describe("protocol intake-item link (#660 ask 3)", () => {
  test("the form offers a supplement/medication and the detail page links it", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/longevity#protocols");
    const main = page.getByRole("main");

    // The add form offers the seeded Creatine supplement as an intervention.
    const select = main.getByTestId("protocol-intake-item");
    await expect(select).toBeVisible();
    await expect(
      select.locator("option", { hasText: "Creatine Monohydrate" })
    ).toHaveCount(1);

    // The seeded protocol's detail page shows the intervention link to the
    // supplement surface (Nutrition → Supplements).
    await followLink(
      page,
      main.getByRole("link", { name: /Creatine 5 g\/day/ }),
      /\/protocols\/\d+/
    );
    const detail = page.getByRole("main");
    const link = detail.getByTestId("protocol-intake-link");
    await expect(link).toBeVisible();
    await expect(link).toContainText("Creatine Monohydrate");
    await expect(link).toHaveAttribute("href", "/nutrition?tab=supplements");
  });
});

test.describe("protocol chart annotations (#660 ask 1)", () => {
  test("the Trends Body tab shows a Protocols annotation toggle", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/trends?tab=body");
    const main = page.getByRole("main");
    // The seeded ongoing protocol shades the body charts, so the shared annotation
    // toggle bar offers a "Protocols" pill.
    await expect(main.getByRole("button", { name: "Protocols" })).toBeVisible();
  });

  test("a biomarker's own chart annotates the protocol that targets it", async ({
    page,
  }) => {
    test.slow();
    const uniqueName = `E2E LDL protocol ${Date.now()}`;
    // A past start so the window overlaps the seeded LDL readings.
    const start = new Date(Date.now() - 60 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    await page.goto("/longevity#protocols");
    const main = page.getByRole("main");
    const form = main.getByTestId("protocol-form");
    await form.getByLabel("Name").fill(uniqueName);
    await main.locator("#pr-start-new").fill(start);
    // Dismiss the DateField popover so it doesn't intercept the checkbox click.
    await page.keyboard.press("Escape");
    await form
      .locator('input[name="outcome_keys"][value="biomarker:LDL Cholesterol"]')
      .check();
    await settledClick(
      page,
      form.getByRole("button", { name: "Create protocol" })
    );
    await page.waitForURL(/\/protocols\/\d+/);
    const protocolUrl = page.url();

    // The LDL detail chart now carries the annotation toggle bar (previously it had
    // none at all) with the targeting protocol's "Protocols" window pill.
    await page.goto(
      `/biomarkers/view?name=${encodeURIComponent("LDL Cholesterol")}`
    );
    await expect(
      page.getByRole("main").getByRole("button", { name: "Protocols" })
    ).toBeVisible();

    // Self-clean: delete the protocol we created.
    page.on("dialog", (d) => d.accept());
    await page.goto(protocolUrl);
    await settledClick(
      page,
      page.getByRole("main").getByRole("button", { name: "Delete" })
    );
    await page.waitForURL(/\/longevity(?:#|$)/);
    await expect(page.getByRole("main")).not.toContainText(uniqueName);
  });
});

test.describe("active-protocol dashboard widget (#660 ask 2)", () => {
  test("Customize enables the widget and it shows the ongoing protocol", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/");
    const main = page.getByRole("main");

    // Off by default — enable it from Customize (eye toggle → Save).
    await main.getByRole("button", { name: "Edit dashboard" }).click();
    await main.getByRole("button", { name: "Show Active protocols" }).click();
    await settledClick(
      page,
      main.getByRole("button", { name: "Save", exact: true })
    );
    await expect(
      main.getByRole("button", { name: "Edit dashboard" })
    ).toBeVisible();

    const widget = main.getByTestId("dashboard-widget-active-protocols");
    await expect(widget).toBeVisible();
    await expect(widget).toContainText("Creatine 5 g/day");

    // Restore the default (hidden) so the shared dashboard layout is left untouched
    // for neighboring specs (suite hygiene — a spec owns its state).
    await main.getByRole("button", { name: "Edit dashboard" }).click();
    await main.getByRole("button", { name: "Hide Active protocols" }).click();
    await settledClick(
      page,
      main.getByRole("button", { name: "Save", exact: true })
    );
    await expect(
      main.getByTestId("dashboard-widget-active-protocols")
    ).toHaveCount(0);
  });
});
