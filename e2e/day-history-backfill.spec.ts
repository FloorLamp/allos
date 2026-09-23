import { expect, test } from "./fixtures";
import type { Locator } from "@playwright/test";
import { shiftDateStr } from "@/lib/date";
import { DEFAULT_FORMAT_PREFS, formatDateWithYear } from "@/lib/format-date";
import { frozenNow } from "./worker-env";
import { hydratedClick } from "./helpers";

async function expectEmptyDayAddLink(
  section: Locator,
  unitMany: string,
  href: RegExp
) {
  // eslint-disable-next-line no-restricted-properties -- first-ok: any in-range empty calendar day has the same close-the-loop contract
  const emptyDay = section
    .locator(`button[aria-label*=" — no ${unitMany}"]`)
    .first();
  await expect(emptyDay).toBeVisible();
  const date = await emptyDay.getAttribute("data-date");
  expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await hydratedClick(emptyDay.page(), emptyDay);
  const panel = section.getByTestId("day-history-daypanel");
  await expect(panel).toContainText("Nothing logged this day.");
  const add = panel.getByTestId("day-history-add-link");
  await expect(add).toHaveText("Log for this day");
  await expect(add).toHaveAttribute("href", href);
  await expect(add).toHaveAttribute("href", new RegExp(date!));
}

test("day history closes an empty-day gap with a dated log link (#2420)", async ({
  page,
}) => {
  // One rendered instance proves the shared component's empty-day interaction. The
  // pure dayHistoryAddHref table and the destination test below cover all four URL
  // mappings; repeating this interaction for every domain added no browser evidence.
  await page.goto("/trends?tab=nutrition");
  await expectEmptyDayAddLink(
    page.getByTestId("dose-history"),
    "doses",
    /\/nutrition\?tab=supplements&backfill=/
  );
});

test("dated entry destinations preserve their own bounds and prefill the day (#2420)", async ({
  page,
}) => {
  const today = frozenNow().toISOString().slice(0, 10);
  const yesterday = shiftDateStr(today, -1);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/nutrition?tab=food&date=${yesterday}`);
  await expect(page.getByTestId("food-day-yesterday")).toHaveAttribute(
    "aria-pressed",
    "true"
  );

  await page.goto(`/nutrition?tab=supplements&backfill=${yesterday}`);
  const doseLauncher = page.getByTestId("historical-dose-launcher");
  await expect(doseLauncher).toBeVisible();
  // THE HEADING IS THE DOMAIN'S DECLARED PHRASE (#5617 step 2), not this page's own.
  // It read "Log a past dose" here while the record's door and the quick sheet read
  // `LOG_MANIFEST.dose.noun`; asserting the rendered phrase — scoped to the launcher
  // — pins that the declaration actually reaches this surface, which reading the
  // manifest back in a unit test cannot.
  await expect(
    doseLauncher.getByRole("heading", { name: "Log dose" })
  ).toBeVisible();
  await expect(
    doseLauncher.getByTestId("historical-dose-item-picker")
  ).toBeVisible();
  await expect(
    doseLauncher
      .getByTestId("historical-dose-form")
      .locator('input[name="date"]')
  ).toHaveValue(yesterday);

  // A practice's dated entry is the History day view's Practice chip (#5668).
  await page.goto(`/history?day=${yesterday}`);
  await hydratedClick(page, page.getByTestId("history-add-open-practice"));
  await expect(
    page.getByTestId("practice-log-details").locator('input[name="date"]')
  ).toHaveValue(yesterday);

  await page.goto(`/training?tab=log&date=${yesterday}`);
  await expect(page.locator("#activity-date")).toHaveValue(
    formatDateWithYear(yesterday, DEFAULT_FORMAT_PREFS)
  );
  await expect(page).toHaveURL(/\/training\?tab=log$/);
});

test("dated Food and Practice destinations accept days beyond their former launcher bounds (#5211)", async ({
  page,
}) => {
  const today = frozenNow().toISOString().slice(0, 10);
  const oldFoodDate = shiftDateStr(today, -7);
  const oldPracticeDate = shiftDateStr(today, -31);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/nutrition?tab=food&date=${oldFoodDate}`);
  await expect(page.getByTestId(`food-day-${oldFoodDate}`)).toHaveAttribute(
    "aria-pressed",
    "true"
  );

  await page.goto(`/history?day=${oldPracticeDate}`);
  await hydratedClick(page, page.getByTestId("history-add-open-practice"));
  const details = page.getByTestId("practice-log-details");
  await expect(details).toBeVisible();
  await expect(details.locator('input[name="date"]')).toHaveValue(
    oldPracticeDate
  );
});

// THE PRACTICE HEAT MAP'S ADD DOOR (#5668). It stands on History's practice view,
// and "Log for this day" lands on that day's view, whose Practice chip opens the
// form on the day the reader picked.
test("the practice heat map's add door opens a past day's practice form", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/history?kind=practice");
  const heat = page.getByTestId("practice-history");
  await expectEmptyDayAddLink(heat, "sessions", /\/history\?day=/);
  const add = heat.getByTestId("day-history-add-link");
  const date = new URL(
    (await add.getAttribute("href"))!,
    "http://e2e.test"
  ).searchParams.get("day")!;

  await hydratedClick(page, add);
  await expect(page).toHaveURL(new RegExp(`day=${date}`));
  await hydratedClick(page, page.getByTestId("history-add-open-practice"));
  await expect(
    page.getByTestId("practice-log-details").locator('input[name="date"]')
  ).toHaveValue(date);
});
