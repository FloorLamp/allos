import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import {
  chartsSettled,
  followLink,
  hydratedClick,
  settledBoxes,
  settledClick,
  settledPickOption,
} from "./helpers";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_TRENDS_CURATE } from "./fixture-logins";

// #3387's one Trends tile flow at 390px: saved metrics pin inside the Body census,
// the picker is its last equal-geometry cell, and the pinned run owns drag plus the
// menu-arrow fallback. The dedicated profile starts with Weight and Resting Heart
// Rate saved, so every write below is restored before the test exits.

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };

async function curatePage(browser: Parameters<typeof loginAs>[0]) {
  return loginAs(
    browser,
    { username: E2E_LOGIN_TRENDS_CURATE, password: E2E_MEMBER_PASSWORD },
    PHONE
  );
}

async function pinnedOrder(page: Page): Promise<string[]> {
  return page
    .getByTestId("body-metric-tiles")
    .evaluate((grid) =>
      Array.from(
        grid.querySelectorAll('[data-testid="pinned-census-tile"]')
      ).map((tile) => tile.getAttribute("data-tile-key") ?? "")
    );
}

async function openMenuByKey(page: Page, key: string) {
  const grid = page.getByTestId("body-metric-tiles");
  await chartsSettled(grid, grid);
  await hydratedClick(
    page,
    page
      .locator(`[data-tile-key="${key}"]`)
      .getByTestId("overflow-menu-trigger")
  );
  const menu = page.getByTestId("trend-tile-menu");
  await expect(menu).toBeVisible();
  return menu;
}

function reorderSettled(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/trends",
    { timeout: 15_000 }
  );
}

test("+ Add tile is the final census cell and re-pins the metric it stars", async ({
  browser,
}) => {
  test.slow();
  const page = await curatePage(browser);
  try {
    await page.goto("/trends");
    const weight = page.getByTestId("body-tile-weight");
    await expect(weight).toHaveCount(1);

    // Remove the pin from the owning detail page; the census card remains.
    await followLink(
      page,
      weight.getByTestId("trend-mini-header-link"),
      /\/trends\/metric\/weight/
    );
    const star = page.getByTestId("star-toggle");
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await settledClick(page, star);
    await expect(star).toHaveAttribute("aria-pressed", "false");
    await page.goto("/trends");

    const grid = page.getByTestId("body-metric-tiles");
    const pickerSlot = grid.getByTestId("save-trend-picker-slot");
    await expect(pickerSlot).toBeVisible();
    expect(
      await pickerSlot.evaluate((element) => element.nextElementSibling)
    ).toBeNull();

    // It occupies one neighbour-sized grid cell, never census membership/ranking.
    const [pickerBox, peerBox] = await settledBoxes([
      pickerSlot,
      page.getByTestId("body-tile-resting-hr"),
    ]);
    expect(Math.abs(pickerBox.width - peerBox.width)).toBeLessThan(3);
    expect(pickerBox.height).toBeGreaterThanOrEqual(180);

    await pickerSlot.getByTestId("save-trend-picker-toggle").click();
    const picker = pickerSlot.getByTestId("save-trend-picker");
    await settledPickOption(
      page,
      picker.locator('input[role="combobox"]'),
      "Weight"
    );
    await settledClick(page, picker.getByRole("button", { name: "Star" }));

    // The one existing card moves into the saved run; no duplicate is created.
    await expect(page.getByTestId("body-tile-weight")).toHaveCount(1);
    await expect
      .poll(async () => (await pinnedOrder(page))[0])
      .toBe("metric:weight");
  } finally {
    await page.context().close();
  }
});

test("pinned cards drag within the census and persist", async ({ browser }) => {
  test.slow();
  const page = await curatePage(browser);
  try {
    await page.goto("/trends");
    const before = await pinnedOrder(page);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const [first, second] = before;
    const [from, to] = await settledBoxes([
      page.locator(`[data-tile-key="${first}"]`),
      page.locator(`[data-tile-key="${second}"]`),
    ]);

    const settled = reorderSettled(page);
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      from.x + from.width / 2 + 14,
      from.y + from.height / 2,
      {
        steps: 4,
      }
    );
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
    await expect.poll(async () => (await pinnedOrder(page))[0]).toBe(second);
    await settled;
    await page.reload();
    expect((await pinnedOrder(page)).slice(0, 2)).toEqual([second, first]);

    // Restore through the non-pointer fallback, proving both paths share one list.
    const menu = await openMenuByKey(page, second);
    const restored = reorderSettled(page);
    await menu.getByTestId("saved-move-down").click();
    await expect.poll(async () => (await pinnedOrder(page))[0]).toBe(first);
    await restored;
  } finally {
    await page.context().close();
  }
});
