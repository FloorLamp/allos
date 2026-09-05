import { test, expect } from "./fixtures";
import { followLink, hydratedClick, settledClick } from "./helpers";
import { frozenNow } from "./worker-env";
import { openProtocolFact, withProtocolFact } from "./protocol-form-helpers";

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
    await main.getByTestId("new-protocol-toggle").click();
    // The intake link sits behind the row's `link` fact since #3219, and with
    // nothing linked yet that fact has no chip of its own — it is reached through
    // the one trailing affordance, which is what `openProtocolFact` routes.
    const addForm = page.getByTestId("protocol-form");
    await expect(addForm).toBeVisible();
    await openProtocolFact(addForm, "link");
    const select = page.getByTestId("protocol-intake-item");
    await expect(select).toBeVisible();
    await expect(
      select.locator("option", { hasText: "Creatine Monohydrate" })
    ).toHaveCount(1);
    await page
      .getByRole("dialog", { name: "Add protocol" })
      .getByRole("button", { name: "Close" })
      .click();

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
  test("the Trends body census shows a Protocols annotation toggle", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/trends");
    const main = page.getByRole("main");
    // The seeded ongoing protocol shades the body charts, so the shared annotation
    // toggle bar offers a "Protocols" pill.
    await expect(main.getByRole("button", { name: "Protocols" })).toBeVisible();
  });

  test("a biomarker's own chart annotates the protocol that targets it", async ({
    page,
  }) => {
    test.slow();
    const uniqueName = `E2E LDL protocol ${Date.now()}`; // clock-ok: unique fixture-name suffix, never a stored timestamp
    // A past start so the window overlaps the seeded LDL readings.
    const start = new Date(frozenNow().getTime() - 60 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    await page.goto("/longevity#protocols");
    const main = page.getByRole("main");
    await main.getByTestId("new-protocol-toggle").click();
    const form = page.getByTestId("protocol-form");
    await form.getByLabel("Name").fill(uniqueName);
    await withProtocolFact(form, "window", async () => {
      await form.locator("#pr-start-new").fill(start);
      // Dismiss the DateField popover so it doesn't intercept the panel's Done.
      await page.keyboard.press("Escape");
    });
    await form.getByLabel("Filter outcome metrics").fill("LDL Cholesterol");
    // The option row is in the PORTALED listbox (#3271), not inside the form.
    await page
      .getByRole("listbox")
      .getByRole("option", { name: "LDL Cholesterol", exact: true })
      .click();
    await settledClick(
      page,
      form.getByRole("button", { name: "Create protocol" })
    );
    await page.waitForURL(/\/protocols\/\d+/);
    const protocolUrl = page.url();

    // The LDL detail chart now carries the annotation toggle bar (previously it had
    // none at all) with the targeting protocol's "Protocols" window pill.
    await page.goto(
      `/results/clinical-results/view?name=${encodeURIComponent("LDL Cholesterol")}`
    );
    await expect(
      page.getByRole("main").getByRole("button", { name: "Protocols" })
    ).toBeVisible();

    // Self-clean: delete the protocol we created through the app confirmation.
    await page.goto(protocolUrl);
    await hydratedClick(
      page,
      page.getByRole("button", { name: "More protocol actions" })
    );
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "Delete", exact: true })
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
});
