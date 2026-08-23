import { test, expect } from "./fixtures";
import { hydratedClick, settledClick } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_TRENDS_CURATE,
  E2E_LOGIN_TRENDS_PIN,
  E2E_MEMBER_PASSWORD,
  TRENDS_CURATE_EMPTY_ANALYTE,
} from "./fixture-logins";

// The unified ★ store after #3387: clinical-result saves keep their Results and
// passport meanings but render no duplicate Trends tile; metric saves pin the one
// census tile and can be removed from its own page or pinned-card menu.

const ANALYTE = TRENDS_CURATE_EMPTY_ANALYTE;

test("a starred clinical result stays on Results and the passport, never Trends", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_TRENDS_CURATE,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/results/clinical-results");
  await expect(
    page.getByTestId("starred-results").getByText(ANALYTE, { exact: true })
  ).toBeVisible();

  await page.goto("/profile");
  await expect(page.getByText(`★ ${ANALYTE}`, { exact: true })).toBeVisible();

  await page.goto("/trends");
  await expect(page.getByText(ANALYTE, { exact: true })).toHaveCount(0);
  await page.context().close();
});

test("a metric star pins its existing census tile instead of creating a copy", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_TRENDS_PIN,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/trends/metric/steps");
  const star = page.getByTestId("star-toggle");
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await settledClick(page, star);
  await expect(star).toHaveAttribute("aria-pressed", "true");

  await page.goto("/trends");
  const tile = page.getByTestId("body-tile-steps");
  await expect(tile).toHaveCount(1);
  await expect(
    page
      .locator('[data-tile-key="metric:steps"]')
      .getByTestId("body-tile-steps")
  ).toHaveCount(1);

  // The pinned tile's menu is the in-census unstar path.
  await hydratedClick(page, tile.getByTestId("overflow-menu-trigger"));
  await settledClick(
    page,
    page.getByTestId("trend-tile-menu").getByTestId("star-toggle")
  );
  await expect(page.getByTestId("body-tile-steps")).toHaveCount(1);
  await expect(page.locator('[data-tile-key="metric:steps"]')).toHaveCount(0);
  await page.context().close();
});
