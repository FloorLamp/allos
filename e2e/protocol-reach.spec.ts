import { test, expect } from "./fixtures";
import {
  expectNoClippedContent,
  followLink,
  hydratedClick,
  settledClick,
} from "./helpers";
import { frozenNow } from "./worker-env";

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
    const select = page.getByTestId("protocol-intake-item");
    await expect(select).toBeVisible();
    await expect(
      select.locator("option", { hasText: "Creatine Monohydrate" })
    ).toHaveCount(1);
    await page
      .getByRole("dialog", { name: "New protocol" })
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
  test("the Trends Body tab shows a Protocols annotation toggle", async ({
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
    const uniqueName = `E2E LDL protocol ${Date.now()}`;
    // A past start so the window overlaps the seeded LDL readings.
    const start = new Date(frozenNow().getTime() - 60 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    await page.goto("/longevity#protocols");
    const main = page.getByRole("main");
    await main.getByTestId("new-protocol-toggle").click();
    const form = page.getByTestId("protocol-form");
    await form.getByLabel("Name").fill(uniqueName);
    await form.locator("#pr-start-new").fill(start);
    // Dismiss the DateField popover so it doesn't intercept the outcome picker.
    await page.keyboard.press("Escape");
    await form.getByLabel("Filter outcome metrics").fill("LDL Cholesterol");
    await form
      .getByRole("button", { name: "LDL Cholesterol", exact: true })
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
      `/biomarkers/view?name=${encodeURIComponent("LDL Cholesterol")}`
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
    // settledClick proved the save POST completed; what remains is the layout
    // refresh re-rendering the whole dashboard, which can outlast the default 5s
    // on a loaded runner. A named ceiling, not a sleep — this still fails if the
    // editor never exits.
    await expect(
      main.getByRole("button", { name: "Edit dashboard" })
    ).toBeVisible({ timeout: 20_000 });

    const widget = main.getByTestId("dashboard-widget-active-protocols");
    await expect(widget).toBeVisible();
    await expect(widget).toContainText("Creatine 5 g/day");

    // THE THREE-SURFACE PIN (#2008). The seeded "Red light 3-5x/week" protocol is
    // the only one of profile 1's ongoing protocols with a practice target, so its
    // adherence line is the unique one in the widget. The widget used to derive its
    // chip from `met` alone — a two-state answer — so the same practice, the same
    // day and the same rows read amber "Behind" here while the wellness card and
    // the protocol detail page read "On pace". All three now render the SAME
    // <PracticeWeeklyProgress>, so the verdict word must be identical whatever the
    // run's frozen day makes it.
    const widgetVerdict = await widget
      .getByTestId("active-protocol-adherence")
      .locator(".badge")
      .innerText();
    const adherence = widget.getByTestId("active-protocol-adherence");
    await expect(adherence).toContainText("Therapy sessions");
    await expect(adherence).not.toContainText("Red light therapy sessions");
    const logControl = widget.getByTestId("practice-log-control");
    await expect(logControl).not.toContainText("Today");
    await expect(logControl).not.toContainText("No sessions yet");
    await expect(logControl.getByTestId("practice-log-button")).not.toHaveClass(
      /bg-brand-600/
    );

    // #2204 (owner ruling): the widget mounts the SAME ProtocolLogButton the detail
    // page does, so its one-tap records what it shows rather than discarding the
    // duration. No details trigger here — the widget is a summary and the detail page
    // owns the expanded form — so this row is stepper + tap, two controls not three.
    const widgetPractice = widget.getByTestId("practice-log-control");
    await expect(
      widgetPractice.getByTestId("practice-duration-input")
    ).toBeVisible();
    await expect(
      widgetPractice.getByTestId("practice-log-details-trigger")
    ).toHaveCount(0);
    // Nothing is clipped at this width even with the stepper added — the control
    // cluster wraps rather than overflowing (the #2204 containment fix).
    await expectNoClippedContent(page);

    // Restore the default (hidden) so the shared dashboard layout is left untouched
    // for neighboring specs (suite hygiene — a spec owns its state).
    await main.getByRole("button", { name: "Edit dashboard" }).click();
    await main.getByRole("button", { name: "Hide Active protocols" }).click();
    await settledClick(
      page,
      main.getByRole("button", { name: "Save", exact: true })
    );
    // Same refresh latency as above (the restore is a second full-dashboard save).
    await expect(
      main.getByTestId("dashboard-widget-active-protocols")
    ).toHaveCount(0, { timeout: 20_000 });

    // Surface 2: the wellness card.
    await page.goto("/wellness");
    const wellnessVerdict = await page
      .getByTestId("wellness-practice-card")
      .filter({ hasText: "Red light therapy" })
      .getByTestId("wellness-practice-progress")
      .locator(".badge")
      .innerText();

    // Surface 3: the protocol detail page.
    await page.goto("/longevity#protocols");
    await followLink(
      page,
      page.getByRole("main").getByRole("link", { name: /Red light/ }),
      /\/protocols\/\d+/
    );
    const detailVerdict = await page
      .getByTestId("protocol-adherence")
      .locator(".badge")
      .innerText();

    expect(widgetVerdict).toBe(wellnessVerdict);
    expect(detailVerdict).toBe(wellnessVerdict);
  });
});
