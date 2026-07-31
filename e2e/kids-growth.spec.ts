import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { hydratedClick } from "./helpers";

// Kids growth trends. For a CHILD profile the Trends → Body tab prioritizes
// height (WHO/CDC growth percentiles + a height/head-circ chart), offers a manual
// height + head-circumference quick-add, and hides body fat %. An ADULT profile is
// unchanged: no growth quick-add, no head-circ affordance, body fat still charted.
// The seeded family includes an ~18-month-old child ("Riley (child)").
//
// These share ONE authenticated session (storageState), so the active profile is
// server-side state; the tests run serially and always restore the "admin" profile
// so no other spec inherits the switch.

async function switchProfile(page: Page, name: string) {
  await page.goto("/");
  const trigger = page.getByTestId("user-menu-trigger");
  // toPass: the profile switch is a Server-Action form inside a client popover. A
  // click dispatched in the pre-hydration window is SWALLOWED with no POST fired
  // (#500/#830), so neither settledClick (no POST to await) nor a single click +
  // retrying expect (the click itself is never retried) can express the wait —
  // re-open the menu and re-submit until the header reflects the switch (the
  // openCommandPalette precedent). Under the merged dashboard's heavier hydration
  // this raw-click path flaked in full-batch runs.
  await expect(async () => {
    if (!((await trigger.textContent()) ?? "").includes(name)) {
      const popover = page.getByTestId("user-menu-popover");
      if (!(await popover.isVisible())) await trigger.click();
      // Scope the click INSIDE the user-menu popover: the dashboard's household
      // strip (#171) also renders profile-named form buttons behind the menu, so an
      // unscoped page-wide form locator is ambiguous (strict-mode violation).
      await popover
        .locator("form")
        .filter({ hasText: name })
        .getByRole("button")
        .click({ timeout: 2000 });
    }
    await expect(trigger).toContainText(name, { timeout: 4000 });
  }).toPass({ timeout: 25000, intervals: [500, 1000, 2000] }); // topass-ok: pre-hydration swallow leaves NO POST/signal to await — the submit itself must be retried until the header reflects the switch
}

// The weight unit is a LOGIN-scoped preference (shared across profiles/specs),
// so a test that flips it MUST restore "kg" so no sibling spec inherits the
// switch. Auto-saves on change (SaveStatus check).
async function setWeightUnit(page: Page, value: "kg" | "lb") {
  await page.goto("/settings/display");
  const select = page
    .getByRole("main")
    .locator("select")
    .filter({ has: page.locator('option[value="lb"]') })
    .first(); // first-ok: the weight-unit select, filtered by its lb option — one match
  await select.selectOption(value);
  await expect(page.getByLabel("Saved")).toBeVisible();
}

test.describe.serial("kids growth trends", () => {
  test.afterAll(async ({ browser }) => {
    // Restore the default profile AND weight unit for any following spec, even
    // if a test above failed mid-switch.
    const page = await browser.newPage();
    try {
      await setWeightUnit(page, "kg");
      await switchProfile(page, "admin");
    } finally {
      await page.close();
    }
  });

  test("child profile: growth entry, height prioritized, body fat hidden", async ({
    page,
  }) => {
    await switchProfile(page, "Riley (child)");
    await page.goto("/trends?view=all");

    // The growth fields are life-stage-gated ROWS of the ONE combined measurements
    // form since #1486 (the standalone growth quick-add retired) — reached through
    // the desktop "+ Log" modal.
    await hydratedClick(page, page.getByTestId("log-measurements-toggle"));
    const form = page.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();
    const heightInput = form.getByLabel("Height", { exact: true });
    await expect(heightInput).toBeVisible();
    await expect(
      form.getByLabel("Head Circumference", { exact: true })
    ).toBeVisible();

    // Height is charted and the WHO/CDC growth-percentile card renders.
    await expect(
      page.getByRole("heading", { name: "Growth Percentiles" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Height", exact: true })
    ).toBeVisible();

    // Body fat % is de-prioritized out of a child's Body tab entirely — the chart
    // heading AND (issue #493) the entry field are both gone, so "not tracked" is
    // consistent instead of hidden-from-charts-but-still-enterable.
    await expect(page.getByRole("heading", { name: "Body Fat" })).toHaveCount(
      0
    );
    await expect(page.getByLabel("Body Fat (%)")).toHaveCount(0);

    // Adding a height persists without error and closes the desktop logging modal.
    await heightInput.fill("82.5");
    await form.getByRole("button", { name: "Save measurements" }).click();
    await expect(page.getByText("Measurements saved")).toBeVisible();
    await expect(form).toHaveCount(0);

    // The height still charts after the write (growth card remains populated).
    await expect(
      page.getByRole("heading", { name: "Growth Percentiles" })
    ).toBeVisible();

    const largeGrowthCard = page.getByTestId("growth-charts-card");
    await expect(
      largeGrowthCard
        .getByTestId("growth-chart-height")
        .getByTestId("chart-card-header-link")
    ).toHaveAttribute("href", /\/trends\/growth\?from=.*&to=.*#growth-height/);
    await expect(
      largeGrowthCard.getByTestId("growth-chart-weight")
    ).toBeVisible();
    await expect(
      largeGrowthCard.getByTestId("growth-chart-head_circumference")
    ).toBeVisible();
    await expect(largeGrowthCard.getByTestId("growth-chart-bmi")).toBeVisible();
    // Separate grid cards must scale their plots to the card. The old composite
    // chart's 520px minimum created horizontal scrollbars in these narrower cards.
    await expect(largeGrowthCard.locator(".overflow-x-auto")).toHaveCount(0);

    // Each available reference is its own chart tile. The tile opens the matching
    // chart on the shared growth detail surface rather than a representative
    // aggregate.
    await page.goto("/trends?view=tiles");
    const growthTile = page.getByTestId("body-tile-growth-height");
    await expect(growthTile).toBeVisible();
    await expect(growthTile.getByRole("application")).toBeVisible();
    await expect(page.getByTestId("body-tile-growth-weight")).toBeVisible();
    await expect(
      page.getByTestId("body-tile-growth-head_circumference")
    ).toBeVisible();
    await expect(page.getByTestId("body-tile-growth-bmi")).toBeVisible();
    const growthTileLink = growthTile.getByTestId("trend-mini-header-link");
    await expect(growthTileLink).toHaveAttribute(
      "href",
      /\/trends\/growth\?from=.*&to=.*#growth-height/
    );
    await growthTileLink.click();
    await expect(page).toHaveURL(
      /\/trends\/growth\?from=.*&to=.*#growth-height$/
    );
    await expect(
      page.getByRole("heading", { level: 1, name: "Growth Percentiles" })
    ).toBeVisible();
    const detail = page.getByTestId("growth-charts-card");
    await expect(detail.getByTestId("growth-chart-height")).toBeVisible();
    await expect(detail.getByTestId("growth-chart-weight")).toBeVisible();
    await expect(
      detail.getByTestId("growth-chart-head_circumference")
    ).toBeVisible();
    await expect(detail.getByTestId("growth-chart-bmi")).toBeVisible();
    await expect(
      page.getByTestId("growth-chip-row").getByRole("link", {
        name: "90D",
        exact: true,
      })
    ).toHaveAttribute("aria-current", "page");

    // The detail page's shared range controls all four trajectories. An old window
    // keeps the chart identities visible but empties their profile measurements.
    await page.goto(
      "/trends/growth?from=2010-01-01&to=2010-12-31#growth-height"
    );
    for (const metric of ["height", "weight", "head_circumference"]) {
      await expect(
        page
          .getByTestId(`growth-chart-${metric}`)
          .getByText(/in this date range/)
      ).toBeVisible();
    }
    const headCircCard = page.getByTestId("growth-chart-head_circumference");
    const [headCircPlotBox, headCircEmptyBox] = await Promise.all([
      headCircCard.getByTestId("chart-card-plot").boundingBox(),
      headCircCard
        .getByText(
          "No head circumference measurement is available in this date range."
        )
        .boundingBox(),
    ]);
    expect(headCircPlotBox).not.toBeNull();
    expect(headCircEmptyBox).not.toBeNull();
    expect(
      Math.abs(
        headCircPlotBox!.x +
          headCircPlotBox!.width / 2 -
          (headCircEmptyBox!.x + headCircEmptyBox!.width / 2)
      )
    ).toBeLessThanOrEqual(2);
    await expect(page.getByTestId("growth-chart-bmi")).toContainText(
      "not available for this age"
    );

    // Direct metric URLs must preserve the same life-stage gates as the combined
    // form. A hidden child metric cannot regain a Log Manually action by drilling
    // straight into its detail page.
    for (const metric of ["body-fat", "hrv"]) {
      await page.goto(`/trends/metric/${metric}`);
      await expect(page.getByTestId("metric-measurement-toggle")).toHaveCount(
        0
      );
    }
    await page.goto("/trends/metric/head-circ");
    await expect(page.getByTestId("metric-measurement-toggle")).toBeVisible();
  });

  test("adult profile: unchanged layout, no growth affordance", async ({
    page,
  }) => {
    await switchProfile(page, "admin");
    await page.goto("/trends?view=all");
    await hydratedClick(page, page.getByTestId("log-measurements-toggle"));
    const form = page.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();

    // No growth fields for an adult — the one form is life-stage-gated (#1486).
    expect(await form.getAttribute("data-life-stage")).toBe("adult");
    await expect(form.getByLabel("Height", { exact: true })).toHaveCount(0);

    // Body fat % is still charted AND enterable for an adult (#493); height/head-circ
    // are not surfaced as tiles.
    await expect(page.getByRole("heading", { name: "Body Fat" })).toBeVisible();
    await expect(form.getByLabel("Body Fat (%)")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Head Circumference" })
    ).toHaveCount(0);
    await page.goto("/trends?view=tiles");
    await expect(
      page.locator('[data-testid^="body-tile-growth-"]')
    ).toHaveCount(0);

    await page.goto("/trends/metric/head-circ");
    await expect(page.getByTestId("metric-measurement-toggle")).toHaveCount(0);
  });

  // Issue #194: the growth-percentile card's WEIGHT plot + label must follow the
  // login's weight preference (it used to hardcode kg). For an lb-preference
  // user the weight chart's tooltip reads in lb — proving the bands + points +
  // axis were all converted together at the display boundary (percentiles stay
  // kg-computed upstream). Restores kg at the end so no sibling spec inherits lb.
  test("child profile: growth card weight follows lb preference", async ({
    page,
  }) => {
    await switchProfile(page, "Riley (child)");
    await setWeightUnit(page, "lb");
    try {
      await page.goto("/trends?view=all");

      const card = page.getByTestId("growth-chart-weight");
      await expect(card).toBeVisible();

      // Hover the weight chart: the recharts tooltip renders values with the
      // display unit suffix. Re-hover on each retry (recharts needs a mousemove).
      const surface = card.locator(".recharts-surface").first(); // first-ok: the scoped weight card's chart surface — one chart per card
      const tooltip = card.locator(".recharts-tooltip-wrapper");
      await expect(async () => {
        const box = await surface.boundingBox();
        if (!box) throw new Error("no growth chart surface");
        // locator.hover scrolls this second-row card into view before dispatching
        // the pointer move. Raw page coordinates worked while Growth was one
        // full-width card, but can stay below the viewport in the 2-column layout.
        await surface.hover({
          position: {
            x: Math.floor(box.width * 0.55),
            y: Math.floor(box.height * 0.5),
          },
        });
        await expect(tooltip).toContainText("lb");
      }).toPass({ timeout: 10_000 }); // topass-ok: recharts opens the tooltip only after a hover mousemove — re-hover per attempt, no single awaitable render event (the sleep-page precedent)

      // And never kg while lb is the preference.
      await expect(tooltip).not.toContainText("kg");
    } finally {
      await setWeightUnit(page, "kg");
    }
  });
});
