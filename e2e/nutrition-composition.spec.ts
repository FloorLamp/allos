import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { settledBoxes } from "./helpers";
import { E2E_LOGIN_NUTRITION, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { CONTROL_BOX_PX } from "@/lib/tap-floor-tokens";

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
    await expect(page.getByTestId("nutrition-page-title")).toBeHidden();
    const shell = page.getByTestId("shell-chrome");
    const shellTabs = shell.getByTestId("shell-tab-strip");
    await expect(shellTabs.getByRole("tablist")).toBeVisible();

    const quick = page.getByTestId("food-quick-log");
    await expect(quick).toBeVisible({ timeout: WAIT });
    const initialSnapshot = page.getByTestId("nutrition-mobile-snapshot");
    await expect(initialSnapshot).toBeVisible();
    await expect(initialSnapshot).not.toContainText("At a glance");
    await expect(initialSnapshot).not.toContainText("Details below");
    await expect(
      initialSnapshot.getByTestId("nutrition-snapshot-protein-status")
    ).toHaveText("Below");
    await expect(
      initialSnapshot.getByTestId("nutrition-snapshot-fiber-status")
    ).toHaveText("Below");
    await expect(
      initialSnapshot.getByTestId("nutrition-snapshot-protein-value")
    ).toHaveText(/^\d+g\+ today$/);
    await expect(
      initialSnapshot.getByTestId("nutrition-snapshot-fiber-value")
    ).toHaveText(/^\d+g\+ today$/);
    await expect(quick.getByTestId("protein-quickadd")).toBeVisible();
    const dateMenuTrigger = page.getByTestId("food-day-menu-trigger");
    await expect(dateMenuTrigger).toBeVisible();
    await expect(dateMenuTrigger).toHaveAttribute("data-button-control", "");
    await expect(dateMenuTrigger).toHaveAttribute("aria-haspopup", "menu");
    await expect(dateMenuTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(
      page
        .getByTestId("food-context-heading")
        .getByTestId("food-day-menu-trigger")
    ).toBeVisible();
    await expect(page.getByTestId("food-day-toggle")).toBeHidden();

    // CompactDateMenu is the one adopter that genuinely renders on a phone.
    // Measure it beside the row's other action so the 44px repair cannot escape
    // the viewport or buy its size by covering Dietary preferences.
    const preferences = page.getByTestId("food-preferences-open");
    const [dateBox, preferencesBox] = await settledBoxes([
      dateMenuTrigger,
      preferences,
    ]);
    const viewport = page.viewportSize()!;
    expect(dateBox.width).toBeGreaterThanOrEqual(CONTROL_BOX_PX);
    expect(dateBox.height).toBeGreaterThanOrEqual(CONTROL_BOX_PX);
    expect(dateBox.x).toBeGreaterThanOrEqual(0);
    expect(dateBox.x + dateBox.width).toBeLessThanOrEqual(viewport.width);
    const overlapX =
      Math.min(
        dateBox.x + dateBox.width,
        preferencesBox.x + preferencesBox.width
      ) - Math.max(dateBox.x, preferencesBox.x);
    const overlapY =
      Math.min(
        dateBox.y + dateBox.height,
        preferencesBox.y + preferencesBox.height
      ) - Math.max(dateBox.y, preferencesBox.y);
    expect(overlapX > 0 && overlapY > 0).toBe(false);

    await dateMenuTrigger.click();
    const dateMenu = page.getByTestId("food-day-menu");
    await expect(dateMenu).toBeVisible();
    await expect(dateMenuTrigger).toHaveAttribute("aria-expanded", "true");
    const dateLabels = await dateMenu
      .getByRole("menuitemradio")
      .allTextContents();
    expect(dateLabels.slice(2)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/),
      ])
    );
    await expect(
      dateMenu.getByRole("menuitemradio", { name: "Today" })
    ).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(
      dateMenu.getByRole("menuitemradio", { name: "Yesterday" })
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dateMenuTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(dateMenuTrigger).toBeFocused();
    await expect(page.getByTestId("food-context-heading")).toHaveAccessibleName(
      /Yesterday (Morning|Midday|Evening) Food Log/
    );
    await expect(page.getByTestId("food-context-label")).toHaveText(
      /^(Morning|Midday|Evening)$/
    );
    const nutrientDetailsSummary = page.getByTestId(
      "nutrition-nutrient-details-summary"
    );
    const selectedDay = page.getByTestId("nutrition-selected-day-section");
    await expect(nutrientDetailsSummary).toBeVisible();
    await expect(nutrientDetailsSummary).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    await expect(selectedDay).toBeHidden();
    const historicalSnapshot = page.getByTestId("nutrition-mobile-snapshot");
    await expect(historicalSnapshot).toContainText(/g\+ yesterday/i);
    await expect(quick.getByTestId("protein-quickadd")).toHaveCount(0);
    await nutrientDetailsSummary.click();
    await expect(nutrientDetailsSummary).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    await expect(selectedDay).toBeVisible();
    await expect(selectedDay).toContainText("Yesterday");
    const selectedDayNutrients = selectedDay.getByTestId(
      "selected-day-nutrients"
    );
    await expect(selectedDayNutrients).toBeVisible();
    await expect(
      selectedDayNutrients.getByRole("img", { name: /Protein yesterday/i })
    ).toBeVisible();
    await expect(
      selectedDayNutrients.getByRole("img", { name: /Fiber yesterday/i })
    ).toBeVisible();
    await expect(page.getByTestId("nutrition-today-section")).toBeHidden();
    await expect(page.getByTestId("nutrition-week-section")).toBeVisible();
    await expect(
      selectedDay.getByRole("heading", { name: "Meals" })
    ).toHaveCount(0);
    await nutrientDetailsSummary.click();
    await expect(nutrientDetailsSummary).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    await dateMenuTrigger.click();
    await page
      .getByTestId("food-day-menu")
      .getByRole("menuitemradio", { name: "Today" })
      .click();
    await expect(page.getByTestId("food-context-heading")).toHaveAccessibleName(
      /Today (Morning|Midday|Evening) Food Log/
    );
    await expect(quick.getByTestId("protein-quickadd")).toBeVisible();
    await expect(selectedDay).toBeHidden();
    await expect(page.getByTestId("nutrition-today-section")).toBeHidden();
    await nutrientDetailsSummary.click();
    await expect(page.getByTestId("nutrition-today-section")).toBeVisible();
    // The quick rows themselves. Since #3362 the "More food groups" disclosure
    // sits INSIDE this list (it extends it), so its collapsed rows are under
    // `food-quick-log` too — scoped away by `food-quick-rows`, or "the quick log
    // offers six" would silently become "the catalog has N" and keep passing.
    await expect(
      quick
        .getByTestId("food-quick-rows")
        .locator('li[data-testid^="food-group-"]')
    ).toHaveCount(6);
    const more = page.getByTestId("food-more-groups");
    await expect(more).not.toHaveAttribute("open", "");
    await expect(page.getByTestId("nutrition-mobile-snapshot")).toBeVisible();
    const suggestionBadge = page.getByTestId("nutrition-suggestions-summary");
    await expect(suggestionBadge).toBeVisible();
    await expect(suggestionBadge).toHaveAttribute(
      "data-variant",
      "insight-launcher"
    );
    await expect(suggestionBadge).toHaveAttribute("aria-haspopup", "dialog");
    await expect(suggestionBadge).not.toHaveAttribute("aria-expanded", /.*/);

    // The nutrient analysis remains read-only. Its unified sidebar surface owns the
    // chrome, so this section is not another nested card.
    const nutrients = page.getByTestId("nutrients-card");
    await expect(nutrients).toBeVisible({ timeout: WAIT });
    await expect(nutrients).not.toHaveClass(/\bcard\b/);
    await expect(
      nutrients.getByRole("heading", { name: "Today", exact: true })
    ).toHaveClass(/\bsection-label\b/);
    await expect(nutrients.getByTestId("protein-adequacy")).toBeVisible();
    await expect(nutrients.getByTestId("protein-gauge")).toBeVisible();
    await expect(nutrients.getByTestId("protein-quickadd")).toHaveCount(0);
    await expect(nutrients.getByTestId("fiber-adequacy")).toBeVisible();
    await expect(nutrients.getByTestId("fiber-gauge")).toBeVisible();
    await expect(
      nutrients.getByRole("img", { name: /Fiber today/i })
    ).toBeVisible();
    // Detailed basis/target prose stays behind the single methodology disclosure.
    await expect(
      nutrients.getByTestId("protein-estimate-details")
    ).toBeHidden();
    await expect(nutrients.getByTestId("fiber-estimate-details")).toBeHidden();
    await expect(nutrients.getByTestId("protein-adequacy-caption")).toHaveCount(
      0
    );
    await expect(nutrients.getByTestId("fiber-adequacy-caption")).toHaveCount(
      0
    );

    // ONE THIS-WEEK LIST (#3987). The rollup and the habits section were two lists of
    // the same groups for the same week; there is one now, and the tracked groups carry
    // their target and pace INLINE on their own row rather than in a second list below.
    const week = page.getByTestId("nutrition-week-section");
    const habits = week.getByTestId("weekly-habits");
    await expect(habits).toBeVisible();
    await expect(habits).not.toHaveClass(/\bcard\b/);
    await expect(
      habits.getByRole("heading", { name: "This week", exact: true })
    ).toHaveClass(/\bsection-label\b/);
    // THE REMOVAL: no second weekly section, no second heading.
    await expect(
      week.getByRole("heading", { name: "Weekly habits" })
    ).toHaveCount(0);
    await expect(week.getByTestId("food-weekly-rollup")).toHaveCount(1);
    // THE CONVERSE, and it is the half an absence assertion cannot make: the ONE list
    // still carries BOTH facts. A tracked group's row names the group, its servings,
    // its target and its pace — and a group with no target still has its row.
    const rollup = habits.getByTestId("food-weekly-rollup");
    const rollupRows = rollup.locator(":scope > li");
    expect(await rollupRows.count()).toBeGreaterThan(0);
    // Every row of the one list is a group row. (That a TRACKED group carries its
    // target and pace on that same row is asserted where a tracked group exists —
    // training-routine-scope.spec.ts and food-habits.spec.ts, on the profile that has
    // one; this fixture profile tracks no habits, so asserting it here would be a
    // claim about an empty set.)
    await expect(rollup.locator(':scope > li:not([data-testid^="rollup-"])')).toHaveCount(
      0
    );
    // Weekly servings keep their visible hierarchy: most logged first, name for ties.
    const rollupValues = await rollupRows.evaluateAll((rows) =>
      rows.map((row) => {
        const values = row.querySelectorAll("span");
        return {
          count: Number(values[0]?.textContent ?? 0),
          name: values[1]?.textContent ?? "",
        };
      })
    );
    expect(rollupValues).toEqual(
      [...rollupValues].sort(
        (a, b) => b.count - a.count || a.name.localeCompare(b.name)
      )
    );

    // FIBER IS STATED ONCE ON THE RAIL (#3987's acceptance criterion). The weekly
    // block that used to sit down here folded INTO the fiber block, so its average is
    // one line under the gauge — and the weekly section carries no fiber gauge of its
    // own any more.
    await expect(week.getByTestId("nutrition-weekly-fiber")).toHaveCount(0);
    await expect(
      week.getByRole("heading", { name: "Weekly fiber target" })
    ).toHaveCount(0);
    const weeklyFiber = nutrients.getByTestId("nutrition-weekly-fiber");
    await expect(weeklyFiber).toBeVisible();
    await expect(weeklyFiber).toContainText("Avg logged day this week");
    await expect(
      weeklyFiber.getByTestId("nutrition-weekly-fiber-value")
    ).toHaveText(/^\d+g\+?$/);
    await expect(weeklyFiber).toContainText(/\/ \d+g\+ goal/);
    // ONE gauge per nutrient, page-wide — the count IS the "stated once" claim, and it
    // fails as loudly on a page that lost a gauge as on one that grew a second.
    await expect(page.getByTestId("fiber-gauge")).toHaveCount(1);
    await expect(page.getByTestId("protein-gauge")).toHaveCount(1);

    // The daily and weekly context lead; the optional modal launcher follows them.
    const today = page.getByTestId("nutrition-today-section");
    await expect(today.getByTestId("nutrients-card")).toBeVisible();
    const insights = page.getByTestId("nutrition-suggestions");
    await expect(
      insights.getByRole("heading", { name: "Insights", exact: true })
    ).toHaveClass(/\bsection-label\b/);

    // Vertical order on mobile: compact logger → Today → This week → Insights.
    const barBox = await page.getByTestId("food-log-bar").boundingBox();
    const todayBox = await today.boundingBox();
    const weekBox = await week.boundingBox();
    const insightsBox = await insights.boundingBox();
    expect(barBox).not.toBeNull();
    expect(todayBox).not.toBeNull();
    expect(weekBox).not.toBeNull();
    expect(insightsBox).not.toBeNull();
    expect(barBox!.y).toBeLessThan(todayBox!.y);
    expect(todayBox!.y).toBeLessThan(weekBox!.y);
    expect(weekBox!.y).toBeLessThan(insightsBox!.y);

    // Day context scrolls with the page on mobile, matching the tab strip and
    // auto-hiding shell chrome. Profile settings owns dietary preferences; the
    // logger header stays focused on day/meal input.
    const context = page.getByTestId("food-log-context");
    await expect(context.getByTestId("food-preferences-link")).toHaveCount(0);
    await expect(page.getByTestId("food-preferences-open")).toBeVisible();
    // ONE preferences affordance at every width, and no Meals-cards header to carry a
    // second one (#3987).
    await expect(
      page.getByTestId("food-preferences-open-desktop")
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Meals", level: 3 })
    ).toHaveCount(0);

    // The tabs are not a second sticky layer: they travel with ShellChrome's
    // existing hide/reveal transform as the bottom of that ONE unit.
    await expect(shell).toHaveAttribute("data-ready", "true");
    const deep = await page.evaluate(() => {
      window.scrollTo(0, 1000);
      return window.scrollY;
    });
    expect(deep).toBeGreaterThan(400);
    await expect(shell).toHaveAttribute("data-hidden", "true");
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(shell).toHaveAttribute("data-hidden", "false");
  } finally {
    await page.close();
  }
});

test("desktop nutrition exposes the full context and lab suggestions", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_NUTRITION,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto("/nutrition?tab=food");
    await expect(page.getByTestId("nutrition-page-title")).toBeVisible();
    await expect(page.getByTestId("shell-tab-strip")).toBeHidden();
    await expect(
      page.getByTestId("nutrition-nutrient-details-summary")
    ).toBeHidden();
    await expect(page.getByTestId("nutrition-today-section")).toBeVisible();
    await expect(page.getByTestId("food-day-menu-trigger")).toBeHidden();
    await expect(page.getByTestId("food-day-toggle")).toBeVisible();
    const sidebar = page.getByTestId("nutrition-sidebar");
    await expect(
      sidebar.getByTestId("nutrition-sidebar-surface")
    ).toBeVisible();
    const suggestionBadge = sidebar.getByTestId(
      "nutrition-suggestions-summary"
    );
    await expect(suggestionBadge).toBeVisible();
    const sidebarSurface = sidebar.getByTestId("nutrition-sidebar-surface");
    await expect(sidebarSurface).toBeVisible();
    await suggestionBadge.click();
    const dialog = page.getByRole("dialog", { name: "Lab suggestions" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByTestId("nutrition-suggestions-panel")
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await page.close();
  }
});
