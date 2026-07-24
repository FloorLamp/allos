import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { E2E_LOGIN_NUTRITION, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Food-tab composition (issue #980), driven against the dedicated NUTRITION_PROFILE
// (seed-events: a weigh-in, this-week food servings, a confirmed fiber supplement, sex =
// male, a flagged low omega-3 → protein gauge + fiber row + suggestions all present).
//
// READ-ONLY on purpose (e2e hygiene #868): these assertions are preference-INDEPENDENT
// (the card structure and section order don't change with a dietary preference), so this
// file never mutates the shared profile's preferences and can't race the trio spec's
// vegetarian test. The "a set preference shows the note" proof lives in nutrition-trio's
// vegetarian flow (which owns that mutation); the "no preference → no note" logic is pinned
// by the pure lib/__tests__/dietary-preferences.test.ts.
const WAIT = 15_000;

test("mobile nutrition leads with quick logging and a compact snapshot before the detailed Today and This week sections", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_NUTRITION,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    // Narrow (mobile) viewport so the grid collapses to one column — the honest test of
    // the mobile order act (log bar) → today's feedback → weekly reflection.
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/nutrition?tab=food");

    const quick = page.getByTestId("food-quick-log");
    await expect(quick).toBeVisible({ timeout: WAIT });
    await expect(page.getByTestId("food-log-shell")).toHaveCSS(
      "border-top-width",
      "0px"
    );
    const dateCombobox = page.getByTestId("food-day-combobox");
    await expect(dateCombobox).toBeVisible();
    await expect(page.getByTestId("food-day-toggle")).toBeHidden();
    const dateLabels = await dateCombobox.locator("option").allTextContents();
    expect(dateLabels.slice(2)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/),
      ])
    );
    await dateCombobox.selectOption({ label: "Yesterday" });
    await expect(page.getByTestId("food-day-total")).toContainText("yesterday");
    const selectedDay = page.getByTestId("nutrition-selected-day-section");
    await expect(selectedDay).toBeVisible();
    await expect(selectedDay).toContainText("Yesterday");
    await expect(page.getByTestId("nutrition-today-section")).toBeHidden();
    await expect(page.getByTestId("nutrition-week-section")).toBeVisible();
    await expect(
      selectedDay.getByTestId("selected-day-slot-morning")
    ).toBeVisible();
    await expect(
      selectedDay.getByTestId("selected-day-slot-midday")
    ).toBeVisible();
    await expect(
      selectedDay.getByTestId("selected-day-slot-evening")
    ).toBeVisible();
    await dateCombobox.selectOption({ label: "Today" });
    await expect(page.getByTestId("food-day-total")).toContainText("today");
    await expect(selectedDay).toBeHidden();
    await expect(page.getByTestId("nutrition-today-section")).toBeVisible();
    await expect(quick.locator('li[data-testid^="food-group-"]')).toHaveCount(
      8
    );
    const more = page.getByTestId("food-more-groups");
    await expect(more).not.toHaveAttribute("open", "");
    await expect(page.getByTestId("nutrition-mobile-snapshot")).toBeVisible();
    const suggestionBadge = page.getByTestId("nutrition-suggestions-summary");
    await expect(suggestionBadge).toBeVisible();
    const suggestionBadgeBox = await suggestionBadge.boundingBox();
    expect(suggestionBadgeBox).not.toBeNull();
    expect(suggestionBadgeBox!.height).toBeLessThanOrEqual(36);
    await expect(suggestionBadge).toHaveAttribute("aria-expanded", "false");

    // ONE "Today's nutrients" card now holds both nutrient rows AND the quick-add — the
    // standalone protein-adequacy / fiber / quick-add cards are gone (all nested here).
    const nutrients = page.getByTestId("nutrients-card");
    await expect(nutrients).toBeVisible({ timeout: WAIT });
    await expect(nutrients).toContainText(/Today.s nutrients/i);
    await expect(nutrients.getByTestId("protein-adequacy")).toBeVisible();
    await expect(nutrients.getByTestId("protein-gauge")).toBeVisible();
    await expect(nutrients.getByTestId("protein-quickadd")).toBeVisible();
    await expect(nutrients.getByTestId("fiber-adequacy")).toBeVisible();
    await expect(nutrients.getByTestId("fiber-gauge")).toBeVisible();

    // This week holds the weekly rollup + the habits card, both unchanged.
    const week = page.getByTestId("nutrition-week-section");
    await expect(week.getByTestId("food-weekly-rollup")).toBeVisible();
    await expect(week.getByTestId("weekly-habits")).toBeVisible();

    // The nutrients card is inside the Today section, which sits ABOVE This week.
    const today = page.getByTestId("nutrition-today-section");
    await expect(today.getByTestId("nutrients-card")).toBeVisible();

    // Vertical order on mobile: compact logger → detailed Today → This week.
    const barBox = await page.getByTestId("food-log-bar").boundingBox();
    const todayBox = await today.boundingBox();
    const weekBox = await week.boundingBox();
    expect(barBox).not.toBeNull();
    expect(todayBox).not.toBeNull();
    expect(weekBox).not.toBeNull();
    expect(barBox!.y).toBeLessThan(todayBox!.y);
    expect(todayBox!.y).toBeLessThan(weekBox!.y);

    // Day context stays sticky while the optional remainder scrolls. Profile settings
    // owns dietary preferences; the logger header stays focused on day/meal input.
    const context = page.getByTestId("food-log-context");
    await expect(context).toHaveCSS("position", "sticky");
    await expect(context).toHaveCSS("border-top-width", "0px");
    await expect(context).toHaveCSS("border-top-left-radius", "0px");
    await expect(context.getByTestId("food-preferences-link")).toHaveCount(0);
    await expect(page.getByTestId("food-preferences-open")).toBeVisible();
  } finally {
    await page.close();
  }
});

test("the nutrition surface is capped to a smaller xl reading width", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_NUTRITION,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto("/nutrition?tab=food");
    const box = await page.getByTestId("nutrition-page").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(1152);
    await expect(page.getByTestId("food-day-combobox")).toBeHidden();
    await expect(page.getByTestId("food-day-toggle")).toBeVisible();
    await expect(page.getByTestId("food-log-shell")).toHaveCSS(
      "border-top-width",
      "1px"
    );
    const sidebar = page.getByTestId("nutrition-sidebar");
    const suggestionBadge = sidebar.getByTestId(
      "nutrition-suggestions-summary"
    );
    await expect(suggestionBadge).toBeVisible();
    const loggerBox = await page.getByTestId("food-log-shell").boundingBox();
    const suggestionBox = await suggestionBadge.boundingBox();
    expect(loggerBox).not.toBeNull();
    expect(suggestionBox).not.toBeNull();
    expect(suggestionBox!.x).toBeGreaterThan(loggerBox!.x + loggerBox!.width);
    await suggestionBadge.click();
    const suggestionPanelBox = await page
      .getByTestId("nutrition-suggestions-panel")
      .boundingBox();
    const layoutBox = await page
      .getByTestId("nutrition-food-layout")
      .boundingBox();
    expect(suggestionPanelBox).not.toBeNull();
    expect(layoutBox).not.toBeNull();
    expect(suggestionPanelBox!.x).toBeCloseTo(layoutBox!.x, 0);
    expect(suggestionPanelBox!.width).toBeCloseTo(layoutBox!.width, 0);
  } finally {
    await page.close();
  }
});
