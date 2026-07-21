import { test, expect } from "@playwright/test";

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

test("the day-scoped count chip is labeled 'today' (and 'yesterday' on the toggle) (#1016)", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // The web bar stays a DAY surface by design (#1016) — its chips are day totals, and the
  // tooltip names the day so a mid-day read isn't mistaken for a per-slot count (the
  // Telegram nudge is where counts go slot-scoped). Copy-level assert, count-independent.
  await expect(page.getByTestId("count-eggs")).toHaveAttribute(
    "title",
    /today$/
  );
  await page.getByTestId("food-day-yesterday").click();
  await expect(page.getByTestId("count-eggs")).toHaveAttribute(
    "title",
    /yesterday$/
  );
});

test("the today/yesterday toggle backfills yesterday, not today (#748 item 1)", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // A group untouched by the other specs, so parallel runs don't collide.
  const slug = "lean_fish";
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

test("the labs food-suggestions card is collapsed by default and expands on click (#591)", async ({
  page,
}) => {
  await page.goto("/nutrition");

  // The container (native <details>) is present, keeping its testid, with a compact
  // one-line summary showing the count. The seeded profile has flagged-low omega-3 +
  // folate readings (e2e/seed-events.ts), so a suggestion exists.
  const card = page.getByTestId("nutrition-suggestions");
  await expect(card).toBeVisible();
  const summary = page.getByTestId("nutrition-suggestions-summary");
  await expect(summary).toContainText("Food suggestions from your labs");

  // Collapsed by default: a suggestion inside is not shown until the card is opened.
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

    const toggle = page.getByTestId("detail-leafy_greens");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Collapsed: the serving line is clamped to one line.
    const desc = toggle.locator("span span").last();
    const collapsedH = (await desc.boundingBox())!.height;

    // Tap the label → it expands, the flag flips, and the (long) line wraps taller.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const expandedH = (await desc.boundingBox())!.height;
    expect(expandedH).toBeGreaterThan(collapsedH);

    // Tap again → collapses back.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});

test("the Trends → Nutrition tab renders the food-servings rollup (#579)", async ({
  page,
}) => {
  await page.goto("/trends?tab=nutrition");
  const section = page.getByTestId("nutrition-trends");
  await expect(section).toBeVisible();
  // The seed logs leafy greens most days, so its rollup row is present over the range.
  await expect(page.getByTestId("nutrition-trends-rollup")).toBeVisible();
  await expect(section.getByTestId("rollup-leafy_greens")).toBeVisible();
});
