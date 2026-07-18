import { test, expect } from "@playwright/test";
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

test("the sidebar groups Today above This week, with one nutrients card holding the protein and fiber rows and the quick-add inside", async ({
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

    // Vertical order on mobile: log bar → Today → This week.
    const barBox = await page.getByTestId("food-log-bar").boundingBox();
    const todayBox = await today.boundingBox();
    const weekBox = await week.boundingBox();
    expect(barBox).not.toBeNull();
    expect(todayBox).not.toBeNull();
    expect(weekBox).not.toBeNull();
    expect(barBox!.y).toBeLessThan(todayBox!.y);
    expect(todayBox!.y).toBeLessThan(weekBox!.y);

    // The "Dietary preferences" link sits at the log bar's foot (preference-independent,
    // so safe to assert here) — the on-surface route to where #975's filter is set.
    await expect(page.getByTestId("food-preferences-link")).toBeVisible();
  } finally {
    await page.close();
  }
});
