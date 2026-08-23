import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import {
  chartsSettled,
  followLink,
  hydratedClick,
  openCombobox,
  settledBoxes,
  settledClick,
  settledFill,
} from "./helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_TRENDS_CURATE,
  TRENDS_CURATE_PROFILE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

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

function setSavedMetric(key: string, saved: boolean): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const row = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(TRENDS_CURATE_PROFILE) as { id: number };
    if (saved) {
      db.prepare(
        "INSERT OR IGNORE INTO saved_items (profile_id, kind, key) VALUES (?, 'trend-metric', ?)"
      ).run(row.id, key);
    } else {
      db.prepare(
        "DELETE FROM saved_items WHERE profile_id = ? AND kind = 'trend-metric' AND key = ?"
      ).run(row.id, key);
    }
  } finally {
    db.close();
  }
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

    await hydratedClick(
      page,
      pickerSlot.getByTestId("save-trend-picker-toggle")
    );
    const picker = pickerSlot.getByTestId("save-trend-picker");
    const field = picker.locator('input[role="combobox"]');
    const listbox = await openCombobox(page, field);
    // The final cell is useful on a default profile even beyond the four legacy
    // digest metrics: every eligible census metric is represented.
    await expect(
      listbox.getByRole("option", { name: "Daily Steps", exact: true })
    ).toBeVisible();
    await settledFill(page, field, "Weight");
    await listbox.getByRole("option", { name: "Weight", exact: true }).click();
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

test("saved empty and gated metrics keep a linked tile and an unstar path", async ({
  browser,
}) => {
  test.slow();
  setSavedMetric("bmr", true);
  setSavedMetric("calm", true);
  const page = await curatePage(browser);
  try {
    await page.goto("/trends?view=tiles");

    const bmr = page.getByTestId("body-tile-bmr");
    await expect(bmr).toContainText("No data in this range");
    await expect(bmr.getByTestId("trend-mini-header-link")).toHaveAttribute(
      "href",
      "/trends/metric/bmr"
    );
    const bmrMenu = await openMenuByKey(page, "metric:bmr");
    await settledClick(page, bmrMenu.getByTestId("star-toggle"));
    await expect(
      page.locator(
        '[data-testid="pinned-census-tile"][data-tile-key="metric:bmr"]'
      )
    ).toHaveCount(0);

    const calm = page.getByTestId("body-tile-calm");
    await expect(calm).toContainText("No data in this range");
    await followLink(
      page,
      calm.getByTestId("trend-mini-header-link"),
      /\/trends\/metric\/calm/
    );
    await expect(page.getByText("This metric isn’t available")).toBeVisible();
    const calmStar = page.getByTestId("star-toggle");
    await expect(calmStar).toHaveAttribute("aria-pressed", "true");
    await settledClick(page, calmStar);
    await expect(calmStar).toHaveAttribute("aria-pressed", "false");
  } finally {
    setSavedMetric("bmr", false);
    setSavedMetric("calm", false);
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
