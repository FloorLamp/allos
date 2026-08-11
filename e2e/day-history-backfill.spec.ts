import { expect, test } from "./fixtures";
import type { Locator } from "@playwright/test";
import { shiftDateStr } from "@/lib/date";
import { formatDateWithYear } from "@/lib/format-date";
import { frozenNow } from "./worker-env";

async function expectEmptyDayAddLink(
  section: Locator,
  unitMany: string,
  href: RegExp
) {
  const emptyDay = section
    .locator(`button[aria-label*=" — no ${unitMany}"]`)
    .first(); // first-ok: any empty calendar day has the same close-the-loop contract
  await expect(emptyDay).toBeVisible();
  const date = await emptyDay.getAttribute("data-date");
  expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await emptyDay.click();
  const panel = section.getByTestId("day-history-daypanel");
  await expect(panel).toContainText("Nothing logged this day.");
  const add = panel.getByTestId("day-history-add-link");
  await expect(add).toHaveText("Log for this day →");
  await expect(add).toHaveAttribute("href", href);
  await expect(add).toHaveAttribute("href", new RegExp(date!));
}

test("every day-history domain closes an empty-day gap with a dated log link (#2420)", async ({
  page,
}) => {
  await page.goto("/trends?tab=nutrition");
  await expectEmptyDayAddLink(
    page.getByTestId("intake-history"),
    "servings",
    /\/nutrition\?tab=food&date=/
  );
  await expectEmptyDayAddLink(
    page.getByTestId("dose-history"),
    "doses",
    /\/nutrition\?tab=supplements&backfill=/
  );

  await page.goto("/trends?tab=fitness");
  await expectEmptyDayAddLink(
    page.getByTestId("workout-history"),
    "sessions",
    /\/training\?tab=log&date=/
  );

  await page.goto("/wellness");
  await expectEmptyDayAddLink(
    page.getByTestId("practice-history"),
    "sessions",
    /\/wellness\?log=/
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
  await expect(
    doseLauncher.getByTestId("historical-dose-item-picker")
  ).toBeVisible();
  await expect(
    doseLauncher
      .getByTestId("historical-dose-form")
      .locator('input[name="date"]')
  ).toHaveValue(yesterday);

  await page.goto(`/wellness?log=${yesterday}`);
  const practiceLauncher = page.getByTestId("practice-backfill-launcher");
  await expect(
    practiceLauncher.getByTestId("practice-backfill-picker")
  ).toBeVisible();
  await expect(page.getByTestId("practice-log-details")).toBeVisible();
  await expect(
    page.getByTestId("practice-log-details").locator('input[name="date"]')
  ).toHaveValue(yesterday);

  await page.goto(`/training?tab=log&date=${yesterday}`);
  await expect(page.locator("#activity-date")).toHaveValue(
    formatDateWithYear(yesterday)
  );
  await expect(page).toHaveURL(/\/training\?tab=log$/);
});

test("bounded destinations explain an out-of-range day instead of misdating it (#2420)", async ({
  page,
}) => {
  const today = frozenNow().toISOString().slice(0, 10);
  const oldFoodDate = shiftDateStr(today, -7);
  const oldPracticeDate = shiftDateStr(today, -31);

  await page.goto(`/nutrition?tab=food&date=${oldFoodDate}`);
  await expect(page.getByTestId("food-date-bound-note")).toContainText(
    "previous six days"
  );
  await expect(page.getByTestId("food-day-today")).toHaveAttribute(
    "aria-pressed",
    "true"
  );

  await page.goto(`/wellness?log=${oldPracticeDate}`);
  await expect(page.getByTestId("practice-backfill-launcher")).toContainText(
    "previous 30 days"
  );
  await expect(page.getByTestId("practice-log-details")).toHaveCount(0);
});
