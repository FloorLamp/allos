import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { settledClick } from "./helpers";

async function revealFoodGroup(page: Page, slug: string) {
  const row = page.getByTestId(`food-group-${slug}`);
  if (!(await row.isVisible())) {
    await page.getByTestId("food-more-groups-summary").click();
    await expect(row).toBeVisible();
  }
}

// Food-group serving log (issue #579): one-tap logging on /nutrition, the day-view
// count, and the weekly rollup. Idempotent — logs a serving, asserts it appears in both
// the day count and the weekly rollup, then undoes it so the fixture is left as found.
// Uses the shared authenticated storageState (the seeded profile already has food_log
// rows from scripts/seed.ts).

test("logging a serving shows in the day count and the weekly rollup, undo decrements (#579)", async ({
  page,
}) => {
  await page.goto("/nutrition");

  const bar = page.getByTestId("food-log-bar");
  await expect(bar).toBeVisible();
  await revealFoodGroup(page, "nuts_seeds");

  const count = page.getByTestId("count-nuts_seeds");
  const before = Number((await count.textContent())?.trim() || "0");

  // One tap → optimistic increment.
  await page.getByTestId("log-nuts_seeds").click();
  await expect(count).toHaveText(String(before + 1));

  // The weekly rollup (server-rendered) reflects the serving after refresh.
  await expect(page.getByTestId("food-weekly-rollup")).toBeVisible();
  await expect(page.getByTestId("rollup-nuts_seeds")).toBeVisible();

  // Undo → decrement back (leave the fixture as found).
  await page.getByTestId("undo-nuts_seeds").click();
  await expect(count).toHaveText(String(before));
});

test("button counts are labeled for the selected meal and day", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  await revealFoodGroup(page, "eggs");

  const meal = await page
    .getByTestId("food-slot-chip")
    .getAttribute("data-slot");
  expect(meal).toBeTruthy();
  await expect(page.getByTestId("food-slot-chip")).toHaveClass(
    /text-slate-500/
  );
  await expect(page.getByTestId("food-slot-chip")).not.toHaveClass(/\bbadge\b/);
  await expect(page.getByTestId("count-eggs")).toHaveAttribute(
    "title",
    new RegExp(`in ${meal} today$`)
  );
  await page.getByTestId("food-day-yesterday").click();
  await expect(page.getByTestId("count-eggs")).toHaveAttribute(
    "title",
    new RegExp(`in ${meal} yesterday$`)
  );
});

test("compact food rows identify eat-more and eat-less guidance", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  await revealFoodGroup(page, "cruciferous");
  await expect(page.getByTestId("food-tier-cruciferous")).toHaveText(
    "Eat more"
  );
  await expect(
    page.getByTestId("food-group-cruciferous").getByTestId("food-group-icon")
  ).toHaveClass(/text-emerald-500/);

  await revealFoodGroup(page, "processed_meat");
  await expect(page.getByTestId("food-tier-processed_meat")).toHaveText(
    "Eat less"
  );
  await expect(
    page.getByTestId("food-group-processed_meat").getByTestId("food-group-icon")
  ).toHaveClass(/text-amber-500/);
});

test("dietary preferences can be edited in a modal without leaving the food log", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  const open = page.getByTestId("food-preferences-open");
  await expect(open).toBeVisible();
  await expect(open).not.toHaveAttribute("href");
  await open.click();

  const dialog = page.getByRole("dialog", { name: "Dietary preferences" });
  await expect(dialog).toBeVisible();
  const form = dialog.getByTestId("dietary-preferences-form");
  await expect(form).toBeVisible();
  await expect(form).not.toHaveClass(/\bcard\b/);
  await expect(dialog.getByTestId("dietary-preset")).toBeVisible();

  await dialog.getByTestId("food-preferences-done").click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/nutrition/);
});

test("the today/yesterday toggle backfills yesterday, not today (#748 item 1)", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // A group untouched by the other specs, so parallel runs don't collide.
  const slug = "lean_fish";
  await revealFoodGroup(page, slug);
  const todayCount = page.getByTestId(`count-${slug}`);
  const todayBefore = Number((await todayCount.textContent())?.trim() || "0");

  // Switch the log target to yesterday.
  await page.getByTestId("food-day-yesterday").click();
  await expect(page.getByTestId("food-day-total")).toContainText("yesterday");
  const yCount = page.getByTestId(`count-${slug}`);
  const yBefore = Number((await yCount.textContent())?.trim() || "0");

  // Log a serving on yesterday — the count reconciles to the server total.
  await page.getByTestId(`log-${slug}`).click();
  await expect(yCount).toHaveText(String(yBefore + 1));

  // Toggling back to today shows today's count UNCHANGED: the write hit yesterday.
  await page.getByTestId("food-day-today").click();
  await expect(page.getByTestId("food-day-total")).toContainText("today");
  await expect(todayCount).toHaveText(String(todayBefore));

  // Restore the fixture — undo the yesterday serving.
  await page.getByTestId("food-day-yesterday").click();
  await expect(yCount).toHaveText(String(yBefore + 1));
  await page.getByTestId(`undo-${slug}`).click();
  await expect(yCount).toHaveText(String(yBefore));
});

test("a recent day can be viewed and backfilled in a specific meal", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  const mealLayouts = await page
    .getByTestId("food-meal-slots")
    .locator("button")
    .evaluateAll((buttons) =>
      buttons.map((button) => {
        const firstChild = button.firstElementChild;
        return {
          offset: firstChild
            ? firstChild.getBoundingClientRect().top -
              button.getBoundingClientRect().top
            : Number.NaN,
          justifyContent: getComputedStyle(button).justifyContent,
        };
      })
    );
  expect(mealLayouts).toHaveLength(3);
  expect(
    mealLayouts.every(({ justifyContent }) => justifyContent === "flex-start")
  ).toBe(true);
  expect(
    mealLayouts.every(
      ({ offset }) => Math.abs(offset - mealLayouts[0].offset) < 1
    )
  ).toBe(true);
  await expect(page.getByTestId("food-meal-summary")).toHaveCSS(
    "border-top-width",
    "0px"
  );

  const slug = "cruciferous";
  await revealFoodGroup(page, slug);
  const initialSlot = await page
    .getByTestId("food-slot-chip")
    .getAttribute("data-slot");
  expect(initialSlot).toBeTruthy();
  const todayCount = page.getByTestId(`count-${slug}`);
  const todayBefore = Number((await todayCount.textContent())?.trim() || "0");

  // The picker exposes a bounded seven-day window; choose the third day and Dinner.
  const olderDay = page.locator('[data-days-ago="2"]');
  await olderDay.click();
  await expect(olderDay).toHaveAttribute("aria-pressed", "true");
  const selectedDay = page.getByTestId("nutrition-selected-day-section");
  await expect(selectedDay).toBeVisible();
  await expect(page.getByTestId("nutrition-today-section")).toBeHidden();
  const selectedEvening = selectedDay.getByTestId("selected-day-slot-evening");
  const selectedEveningBefore = Number(
    (await selectedEvening.locator("dd").textContent())?.trim() || "0"
  );
  await page.getByTestId("food-slot-evening").click();
  await expect(page.getByTestId("food-slot-chip")).toHaveText("Evening");

  const olderCount = page.getByTestId(`count-${slug}`);
  const olderBefore = Number((await olderCount.textContent())?.trim() || "0");
  await settledClick(page, page.getByTestId(`log-${slug}`));
  await expect(olderCount).toHaveText(String(olderBefore + 1));
  await expect(olderCount).toHaveClass(/text-slate-700/);
  await expect(selectedEvening.locator("dd")).toHaveText(
    String(selectedEveningBefore + 1)
  );
  const eveningItem = page.getByTestId(`food-meal-item-evening-${slug}`);
  await expect(eveningItem).toBeVisible();

  // All meals remain visible at once. Selecting Morning changes the logging target,
  // but the serving stays visible in the Evening card and never appears in Morning.
  await page.getByTestId("food-slot-morning").click();
  await expect(eveningItem).toBeVisible();
  await expect(page.getByTestId(`food-meal-item-morning-${slug}`)).toHaveCount(
    0
  );
  await expect(olderCount).toHaveText("0");
  await expect(olderCount).toHaveClass(/text-slate-400/);

  // Today remains untouched.
  await page.getByTestId(`food-slot-${initialSlot!.toLowerCase()}`).click();
  await page.getByTestId("food-day-today").click();
  await expect(todayCount).toHaveText(String(todayBefore));

  // Restore the owned write in the exact day/meal where it was created.
  await olderDay.click();
  await page.getByTestId("food-slot-evening").click();
  await settledClick(page, page.getByTestId(`undo-${slug}`));
  await expect(olderCount).toHaveText(String(olderBefore));
  await expect(selectedEvening.locator("dd")).toHaveText(
    String(selectedEveningBefore)
  );
});

test("the labs food-suggestions sidebar badge is collapsed by default and expands on click (#591)", async ({
  page,
}) => {
  await page.goto("/nutrition");

  // The disclosure lives in the sidebar while minimized to a small badge. The
  // seeded profile has flagged-low omega-3 + folate readings
  // (e2e/seed-events.ts), so a suggestion exists.
  const badge = page.getByTestId("nutrition-suggestions");
  await expect(badge).toBeVisible();
  await expect(
    page.getByTestId("nutrition-sidebar").getByTestId("nutrition-suggestions")
  ).toBeVisible();
  const summary = page.getByTestId("nutrition-suggestions-summary");
  await expect(summary).toContainText("Lab suggestions");

  // Collapsed by default: a suggestion inside is not shown until the badge is opened.
  const suggestion = page.getByTestId("food-suggestion-omega-3");
  await expect(suggestion).toBeHidden();

  // Expand → the suggestion becomes visible.
  await summary.click();
  await expect(suggestion).toBeVisible();
});

test("logging a serving keeps the row order fixed (no reorder under the finger)", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  const rowIds = () =>
    page.$$eval('li[data-testid^="food-group-"]', (els) =>
      els.map((e) => e.getAttribute("data-testid"))
    );
  const before = await rowIds();

  // Tap a low-ranked, zero-weight group twice. The server re-ranks by
  // recency-decayed frequency, so WITHOUT the client-side order freeze these
  // taps would push this row up its tier on the refresh; with the freeze the row
  // stays put until the user navigates away.
  await revealFoodGroup(page, "other_vegetables");
  await page.getByTestId("log-other_vegetables").click();
  await page.getByTestId("log-other_vegetables").click();
  // The weekly rollup is server-rendered, so its row appearing proves the
  // router.refresh() (which carries the re-ranked order) has landed.
  await expect(page.getByTestId("rollup-other_vegetables")).toBeVisible();

  expect(await rowIds()).toEqual(before);

  // Restore the fixture.
  await page.getByTestId("undo-other_vegetables").click();
  await page.getByTestId("undo-other_vegetables").click();
});

test("the header shows today's total, ticking up on log and back on undo", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await revealFoodGroup(page, "eggs");
  const total = page.getByTestId("food-day-total");
  await expect(total).toBeVisible();
  const read = async () =>
    Number((await total.textContent())?.match(/\d+/)?.[0] ?? "0");

  const before = await read();
  await page.getByTestId("log-eggs").click();
  await expect.poll(read).toBe(before + 1);
  await page.getByTestId("undo-eggs").click();
  await expect.poll(read).toBe(before);
});

test.describe("tapping a category expands its serving detail on mobile", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the truncated serving line expands in place on tap", async ({
    page,
  }) => {
    await page.goto("/nutrition");
    await revealFoodGroup(page, "leafy_greens");

    const toggle = page.getByTestId("detail-leafy_greens");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Collapsed: the serving line is clamped to one line.
    const desc = toggle.locator("span span").last();
    const collapsedH = (await desc.boundingBox())!.height;
    const row = page.getByTestId("food-group-leafy_greens");
    const icon = row.getByTestId("food-group-icon");
    const name = row.getByTestId("food-name-leafy_greens");
    const collapsedRowBox = (await row.boundingBox())!;
    const collapsedIconBox = (await icon.boundingBox())!;
    const collapsedNameBox = (await name.boundingBox())!;
    const collapsedIconOffset = collapsedIconBox.y - collapsedRowBox.y;
    expect(
      Math.abs(
        collapsedIconBox.y +
          collapsedIconBox.height / 2 -
          (collapsedNameBox.y + collapsedNameBox.height / 2)
      )
    ).toBeLessThan(3);

    // Tap the label → it expands downward without recentering the leading icon.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const expandedH = (await desc.boundingBox())!.height;
    const expandedRowBox = (await row.boundingBox())!;
    const expandedIconBox = (await icon.boundingBox())!;
    const expandedIconOffset = expandedIconBox.y - expandedRowBox.y;
    expect(expandedH).toBeGreaterThan(collapsedH);
    expect(Math.abs(expandedIconOffset - collapsedIconOffset)).toBeLessThan(1);

    // Tap again → collapses back.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});

test("the Trends → Nutrition tab is the over-time view, not the duplicate rollup (#1166)", async ({
  page,
}) => {
  await page.goto("/trends?tab=nutrition");
  // #1166 reframed the tab: the duplicate FoodWeeklyRollup left for /nutrition; the
  // over-time cards (macros+fiber, adherence trend, intake grid) took its place. (The
  // detailed over-time assertions live in trends-nutrition.spec.ts.)
  await expect(page.getByTestId("nutrition-macros-chart")).toBeVisible();
  await expect(page.getByTestId("nutrition-trends-rollup")).toHaveCount(0);
  await expect(page.getByTestId("food-weekly-rollup")).toHaveCount(0);
});
