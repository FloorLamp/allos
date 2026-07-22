import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_TRENDS_BODY } from "./fixture-logins";

// Trends → Body mobile overhaul, Phase 1 of #1067. On mobile the tab used to force
// scrolling past three quick-add forms and a fixed single-column chart stack before
// the metric you wanted. Phase 1 (no route change):
//   1. the three quick-adds collapse to a "+ Log …" chip row on mobile (desktop
//      keeps the inline forms — ONE shared QuickAddPanel, opt-in mobile behavior),
//   2. sticky chart-jump chips (one overflow-x-auto row) scroll to a chart,
//   3. per-chart `#id` anchors land ON the chart,
//   4. present-only charts are ordered by relevance and their chips render from the
//      SAME visible list, so a chartless metric's chip is hidden.
//
// Fixture (#868 hygiene): a dedicated read-only member/profile (Trends Body (e2e))
// seeded with a KNOWN, PARTIAL metric set (weight+HR, steps, sleep, HR-daily —
// but NO hydration/BMR/calories/…), so the present/absent chip assertions are
// deterministic under --repeat-each. The spec only navigates + scrolls (no writes).

const PHONE = { width: 360, height: 800 };
const DESKTOP = { width: 1280, height: 900 };

async function openBodyTab(page: Page): Promise<void> {
  await page.goto("/trends?tab=body");
  await expect(page.getByRole("tab", { name: "Body" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
}

test.describe("Trends → Body mobile (#1067 Phase 1)", () => {
  test("quick-adds collapse to a chip row on mobile; desktop keeps the inline forms", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });

    // ── Mobile: chip row shown, inline forms collapsed ──────────────────────
    await page.setViewportSize(PHONE);
    await openBodyTab(page);

    const chips = page.getByTestId("quick-add-chips");
    await expect(chips).toBeVisible();
    await expect(page.getByTestId("quick-add-chip-body")).toBeVisible();
    await expect(page.getByTestId("quick-add-chip-vitals")).toBeVisible();
    // Adult profile → no growth quick-add, so no growth chip.
    await expect(page.getByTestId("quick-add-chip-growth")).toHaveCount(0);

    // The forms themselves are collapsed (display:none) until a chip expands them.
    await expect(page.getByTestId("vitals-quick-add")).not.toBeVisible();

    // Tapping the Vitals chip expands its form inline (pure client toggle).
    await page.getByTestId("quick-add-chip-vitals").click();
    await expect(page.getByTestId("vitals-quick-add")).toBeVisible();

    // ── Desktop: inline forms shown, chip row hidden (same component) ────────
    await page.setViewportSize(DESKTOP);
    await openBodyTab(page);
    await expect(page.getByTestId("quick-add-chips")).not.toBeVisible();
    await expect(page.getByTestId("vitals-quick-add")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Log body metrics" })
    ).toBeVisible();

    await page.context().close();
  });

  test("chart-jump chips render present metrics only and scroll to the chart", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(PHONE);
    await openBodyTab(page);

    const jumpRow = page.getByTestId("chart-jump-chips");
    await expect(jumpRow).toBeVisible();

    // Present metrics get a chip (the fixture seeds these).
    await expect(page.getByTestId("chart-jump-body-composition")).toBeVisible();
    await expect(page.getByTestId("chart-jump-steps")).toBeVisible();
    await expect(page.getByTestId("chart-jump-sleep")).toBeVisible();
    await expect(page.getByTestId("chart-jump-hr")).toBeVisible();

    // ONE predicate drives chip + chart: a chartless metric has no chip.
    await expect(page.getByTestId("chart-jump-hydration")).toHaveCount(0);
    await expect(page.getByTestId("chart-jump-bmr")).toHaveCount(0);
    await expect(page.getByTestId("chart-jump-calories")).toHaveCount(0);

    // The chip row is its OWN horizontal scroll container (#1063) and the page
    // body itself does not scroll sideways at 360px.
    const bodyNoHScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1
    );
    expect(bodyNoHScroll).toBe(true);

    // Tapping a chip scrolls its chart into view (plain in-page `#id` anchor).
    const sleepTile = page.getByTestId("sleep-summary-tile");
    await expect(sleepTile).not.toBeInViewport();
    await page.getByTestId("chart-jump-sleep").click();
    await expect(sleepTile).toBeInViewport();
  });

  test("a per-chart #id anchor lands on the chart on load", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(PHONE);

    // Deep-link straight to the HR chart — the anchor resolves to the card.
    await page.goto("/trends?tab=body#hr");
    await expect(page.getByRole("tab", { name: "Body" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(page.locator("#hr")).toBeInViewport();

    // And the sleep anchor lands on the sleep tile.
    await page.goto("/trends?tab=body#sleep");
    await expect(page.getByTestId("sleep-summary-tile")).toBeInViewport();

    await page.context().close();
  });

  test("the #1083 vitals focus deep-link still focuses the systolic field", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(PHONE);

    // The canonical #1083 preventive deep-link lands on the Vitals tab's quick-add
    // (VitalsSection, untouched by #1067) with systolic focused.
    await page.goto("/trends?tab=vitals&focus=blood-pressure");
    await expect(page.getByTestId("vitals-quick-add")).toBeVisible();
    await expect(page.locator("#v-systolic")).toBeFocused();

    // On the BODY tab (whose vitals quick-add is now collapsed on mobile), the same
    // param must AUTO-EXPAND the vitals form so the focus still lands — the #1067
    // collapse must not swallow the #1083 focus path.
    await page.goto("/trends?tab=body&focus=blood-pressure");
    const bodyVitals = page.getByTestId("vitals-quick-add");
    await expect(bodyVitals).toBeVisible();
    await expect(bodyVitals.locator("#v-systolic")).toBeFocused();

    await page.context().close();
  });
});
