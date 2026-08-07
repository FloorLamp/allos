import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { followLink, settledClick, settledPickOption } from "./helpers";
import { workerDbPath } from "./worker-env";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_TRENDS_CURATE,
  TRENDS_CURATE_EMPTY_ANALYTE,
  TRENDS_CURATE_PROFILE,
} from "./fixture-logins";

// Trends Overview is CURATION-DRIVEN (#1487) with uniform saved-slot tiles (#2153).
//
// Two things this proves that no other tier can:
//   1. The membership flip is real — unstarring a STANDARD metric (training volume,
//      which used to render unconditionally) removes its tile, and the picker brings
//      it back. Both halves matter: a removal with no add gesture would strand the
//      tile forever, so the round trip is the feature.
//   2. The tile grid is two-abreast at 390px and a saved item with nothing to show
//      keeps full tile geometry in its saved slot, including reorder controls.
//
// Fixture (#868 hygiene): a dedicated write-granted member whose sole profile is
// "Trends Curate (e2e)" — seeded through the same standard-metric seeds a real new
// profile gets, plus two weigh-ins (weight + resting HR populated), no body-fat/
// activity data, and one starred never-measured analyte. The spec churns THAT
// profile's saved set and restores it; nothing shared moves.
//
// `loginAs` opens its own context, which does NOT inherit the project's `use`
// block — so the phone viewport is passed explicitly (see trends-vitals.mobile).
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };

async function curatePage(browser: Parameters<typeof loginAs>[0]) {
  return loginAs(
    browser,
    { username: E2E_LOGIN_TRENDS_CURATE, password: E2E_MEMBER_PASSWORD },
    PHONE
  );
}

const VOLUME = "Training Volume";

function tile(page: Page, name: string) {
  return page.getByTestId("trend-mini-card").filter({ hasText: name });
}

// Open one tile's corner ⋯ menu and return the menu panel (portaled to <body>, so
// it is NOT inside the tile's own subtree — scope to the panel, not the card).
async function openTileMenu(page: Page, name: string) {
  await tile(page, name).getByTestId("overflow-menu-trigger").click();
  const menu = page.getByTestId("trend-tile-menu");
  await expect(menu).toBeVisible();
  return menu;
}

async function openTileMenuByKey(page: Page, key: string) {
  await page
    .locator(`[data-testid="saved-tile"][data-tile-key="${key}"]`)
    .getByTestId("overflow-menu-trigger")
    .click();
  const menu = page.getByTestId("trend-tile-menu");
  await expect(menu).toBeVisible();
  return menu;
}

test.describe("curated Trends Overview (#1487 / #1485 A+B)", () => {
  test("an empty starred grid collapses to one action row on a phone", async ({
    browser,
  }) => {
    const db = new Database(workerDbPath());
    db.pragma("busy_timeout = 5000");
    const profileId = (
      db
        .prepare("SELECT id FROM profiles WHERE name = ?")
        .get(TRENDS_CURATE_PROFILE) as { id: number }
    ).id;
    const saved = db
      .prepare(
        `SELECT id, kind, key, position, created_at
           FROM saved_items
          WHERE profile_id = ?
          ORDER BY id`
      )
      .all(profileId) as Array<{
      id: number;
      kind: string;
      key: string;
      position: number | null;
      created_at: string;
    }>;
    db.prepare("DELETE FROM saved_items WHERE profile_id = ?").run(profileId);
    db.close();

    const page = await curatePage(browser);
    try {
      await page.goto("/trends");

      const empty = page.getByTestId("starred-empty-state");
      const toggle = empty.getByTestId("save-trend-picker-toggle");
      await expect(
        toggle.getByText("★ Starred", { exact: true })
      ).toBeVisible();
      await expect(
        toggle.getByText("· Add tile", { exact: true })
      ).toBeVisible();
      await expect(
        toggle.getByText("· Close", { exact: true })
      ).not.toBeVisible();
      await expect(
        empty.getByText("Star metrics and biomarkers to build your grid.")
      ).not.toBeVisible();
      await expect(toggle).toBeVisible();
      const closedTogglePosition = await toggle.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y };
      });
      expect(
        await empty.evaluate((node) => node.getBoundingClientRect().height)
      ).toBeLessThanOrEqual(40);

      await toggle.click();
      const picker = empty.getByTestId("save-trend-picker");
      await expect(
        toggle.getByText("· Add tile", { exact: true })
      ).not.toBeVisible();
      await expect(toggle.getByText("· Close", { exact: true })).toBeVisible();
      const openTogglePosition = await toggle.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y };
      });
      expect(
        Math.abs(openTogglePosition.x - closedTogglePosition.x)
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(openTogglePosition.y - closedTogglePosition.y)
      ).toBeLessThanOrEqual(1);
      await expect(
        picker.getByText("Add to your overview:", { exact: true })
      ).not.toBeVisible();
      const search = picker.getByRole("combobox");
      await expect(search).toBeVisible();
      await expect(
        picker.getByRole("button", { name: "Star" })
      ).not.toBeVisible();
      expect(
        await picker.evaluate((node) => {
          const form = node.getBoundingClientRect();
          const section =
            node.parentElement?.parentElement?.getBoundingClientRect();
          const field = node
            .querySelector('[role="combobox"]')
            ?.getBoundingClientRect();
          return (
            section != null &&
            field != null &&
            form.left >= section.left &&
            form.right <= section.right &&
            field.width >= form.width - 2
          );
        })
      ).toBe(true);
    } finally {
      await page.context().close();
      const restoreDb = new Database(workerDbPath());
      const restore = restoreDb.prepare(
        `INSERT INTO saved_items
           (id, profile_id, kind, key, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const restoreAll = restoreDb.transaction(() => {
        restoreDb
          .prepare("DELETE FROM saved_items WHERE profile_id = ?")
          .run(profileId);
        for (const row of saved) {
          restore.run(
            row.id,
            profileId,
            row.kind,
            row.key,
            row.position,
            row.created_at
          );
        }
      });
      restoreAll();
      restoreDb.close();
    }
  });

  test("overview chart links open their detailed metric surfaces", async ({
    browser,
  }) => {
    const page = await curatePage(browser);
    try {
      await page.goto("/trends");

      await expect(
        tile(page, "Weight").getByTestId("trend-mini-header-link")
      ).toHaveAttribute("href", "/trends/metric/weight");
      await expect(
        tile(page, "Resting Heart Rate").getByTestId("trend-mini-header-link")
      ).toHaveAttribute("href", "/trends/metric/resting-hr");
      const restingHeartRate = tile(page, "Resting Heart Rate");
      await expect(
        restingHeartRate.getByText("RHR", { exact: true })
      ).toBeVisible();
      await expect(
        restingHeartRate.getByText("Resting Heart Rate", { exact: true })
      ).not.toBeVisible();
      await expect(
        tile(page, VOLUME).getByTestId("trend-mini-header-link")
      ).toHaveAttribute("href", "/training?tab=analyze");
      await expect(
        tile(page, TRENDS_CURATE_EMPTY_ANALYTE).getByTestId(
          "trend-mini-header-link"
        )
      ).toHaveAttribute("href", /\/biomarkers\/view\?name=/);

      await followLink(
        page,
        tile(page, "Weight").getByTestId("trend-mini-header-link"),
        /\/trends\/metric\/weight/
      );
      await expect(
        page.getByRole("heading", { level: 1, name: "Weight" })
      ).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("unstarring a standard metric removes its tile, and the picker puts it back", async ({
    browser,
  }) => {
    test.slow(); // local `next dev` compiles the Trends route on first hit
    const page = await curatePage(browser);
    try {
      await page.goto("/trends");
      const grid = page.getByTestId("saved-tiles");
      await expect(grid).toBeVisible();
      // The standard tiles are ordinary saved rows now (seeded at profile
      // creation) — which is why they render at all.
      await expect(tile(page, VOLUME)).toHaveCount(1);

      const menu = await openTileMenu(page, VOLUME);
      await settledClick(page, menu.getByTestId("star-toggle"));

      // The capability the flip unlocks: the tile is GONE. Under the old grid the
      // four standard metrics rendered whether you wanted them or not.
      await expect(tile(page, VOLUME)).toHaveCount(0);
      // …and its neighbours are untouched — an unstar is not a grid reset.
      await expect(tile(page, "Weight")).toHaveCount(1);

      // The way back (this is why the picker offers METRICS, not just biomarkers).
      // It goes through settledPickOption: the picker is the shared Combobox since
      // #1675, and since #1644 the hub is one long streamed page, so hydration lands
      // later and a value set before React attaches would be reverted — the Star
      // would then submit the stale one.
      await page.getByTestId("save-trend-picker-toggle").click();
      const picker = page.getByTestId("save-trend-picker");
      await settledPickOption(
        page,
        picker.locator('input[role="combobox"]'),
        VOLUME
      );
      await settledClick(page, picker.getByRole("button", { name: "Star" }));

      // Restoring the fixture IS the assertion.
      await expect(tile(page, VOLUME)).toHaveCount(1);
    } finally {
      await page.context().close();
    }
  });

  test("empty tiles keep the same grid geometry in their saved slot", async ({
    browser,
  }) => {
    test.slow();
    const page = await curatePage(browser);
    try {
      await page.goto("/trends");
      await expect(page.getByTestId("saved-tiles")).toBeVisible();

      // #1485 B — two columns at phone width. Assert the grid itself rather than
      // assuming two named tiles are adjacent: the preceding membership test may
      // legitimately restore one at the end of the saved order.
      const grid = page.getByTestId("saved-tiles").locator(".grid");
      await expect(grid).toBeVisible();
      expect(
        await grid.evaluate(
          (element) =>
            getComputedStyle(element).gridTemplateColumns.split(" ").length
        )
      ).toBe(2);
      const weight = tile(page, "Weight");
      const wBox = await weight.boundingBox();
      expect(wBox, "weight tile box").not.toBeNull();
      expect(wBox!.width).toBeLessThan(195);

      // #2153 reverses #1485 A: a saved analyte with no readings is a full grid
      // cell, not a full-width strip below the populated cards.
      const empty = tile(page, TRENDS_CURATE_EMPTY_ANALYTE);
      await expect(empty).toBeVisible();
      const eBox = await empty.boundingBox();
      expect(eBox, "empty tile box").not.toBeNull();
      expect(Math.abs(eBox!.width - wBox!.width)).toBeLessThan(3);
      expect(eBox!.height).toBeGreaterThan(150);
      await expect(empty).toContainText("No data in this range");
      const emptyWrapper = empty.locator("xpath=..");
      await expect(emptyWrapper).toHaveAttribute(
        "data-tile-key",
        `bio:${TRENDS_CURATE_EMPTY_ANALYTE}`
      );
      expect(
        await emptyWrapper.evaluate((element) =>
          element.parentElement?.classList.contains("grid")
        )
      ).toBe(true);

      // Full geometry, not omission (#1456): its unstar control is still reachable.
      const menu = await openTileMenu(page, TRENDS_CURATE_EMPTY_ANALYTE);
      await expect(menu.getByTestId("star-toggle")).toBeVisible();
    } finally {
      await page.context().close();
    }
  });
});

// ── #1485 C: reorder converges on drag ──────────────────────────────────────
//
// The tiles' order used to move ONLY through per-tile up/down arrows — a second
// reorder language beside DashboardGrid's drag. It is now the same lift-and-drop,
// through the shared components/SortableOrder.tsx, with the arrows kept inside the
// ⋯ menu as the non-pointer fallback. Both halves need a browser: the drag is
// pointer physics, and the fallback's whole point is that it moves the tile within
// the SAME list the drag does.
//
// Same dedicated fixture as above (#868): the profile is this file's own, and each
// test restores the order it found, so --repeat-each stays clean.

// The populated tiles' order, as the grid renders it.
async function tileOrder(page: Page): Promise<string[]> {
  return page
    .getByTestId("saved-tiles")
    .evaluate((el) =>
      Array.from(el.querySelectorAll("[data-tile-key]")).map(
        (n) => n.getAttribute("data-tile-key") ?? ""
      )
    );
}

// Lift one tile and drop it on another. A mouse drag (not touch) on purpose:
// Playwright can drive it deterministically, and the MouseSensor's 6px activation
// distance is the same DndContext the long-press TouchSensor feeds — so this
// exercises the real reorder path without emulating a press-and-hold.
async function dragTile(page: Page, fromKey: string, toKey: string) {
  const from = page.locator(`[data-tile-key="${fromKey}"]`);
  const to = page.locator(`[data-tile-key="${toKey}"]`);
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  expect(a, `no box for ${fromKey}`).not.toBeNull();
  expect(b, `no box for ${toKey}`).not.toBeNull();
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
  await page.mouse.down();
  // Clear the activation distance first — a lift is deliberate, never a tap.
  await page.mouse.move(a!.x + a!.width / 2 + 14, a!.y + a!.height / 2, {
    steps: 4,
  });
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
}

// The persist is a Server Action fired from a transition (no form submit, so
// settledClick does not apply); wait for its POST so a reload cannot outrun it.
function reorderSettled(page: Page) {
  return page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === "/trends",
    { timeout: 15_000 }
  );
}

test.describe("reorder converges on drag (#1485 C)", () => {
  test("a tile dragged onto another takes its slot, and the order survives a reload", async ({
    browser,
  }) => {
    test.slow();
    const page = await curatePage(browser);
    try {
      await page.goto("/trends");
      await expect(page.getByTestId("saved-tiles")).toBeVisible();
      const before = await tileOrder(page);
      expect(
        before.length,
        "the fixture needs two populated tiles to swap"
      ).toBeGreaterThanOrEqual(2);
      const [first, second] = before;

      const settled = reorderSettled(page);
      await dragTile(page, first, second);
      await expect.poll(async () => (await tileOrder(page))[0]).toBe(second);
      await settled;

      // Persistence is the point — an optimistic swap that evaporates on reload is
      // the failure the #1456 position column exists to prevent.
      await page.reload();
      await expect(page.getByTestId("saved-tiles")).toBeVisible();
      expect((await tileOrder(page)).slice(0, 2)).toEqual([second, first]);

      // Restore the fixture (that it restores IS a second assertion that the drag
      // works in both directions).
      const back = reorderSettled(page);
      await dragTile(page, second, first);
      await expect.poll(async () => (await tileOrder(page))[0]).toBe(first);
      await back;
    } finally {
      await page.context().close();
    }
  });

  test("the ⋯ menu keeps the arrows as the non-pointer fallback, moving the same list", async ({
    browser,
  }) => {
    test.slow();
    const page = await curatePage(browser);
    try {
      await page.goto("/trends");
      await expect(page.getByTestId("saved-tiles")).toBeVisible();
      const before = await tileOrder(page);
      const [first, second] = before;

      // The first tile can only go later; the arrows say so rather than offering a
      // move off the end.
      const firstMenu = await openTileMenuByKey(page, first);
      await expect(firstMenu.getByTestId("saved-move-up")).toBeVisible();
      await expect(firstMenu.getByTestId("saved-move-down")).toBeVisible();
      await expect(firstMenu.getByTestId("saved-move-up")).toBeDisabled();
      await page.keyboard.press("Escape");

      // "Move earlier" on the SECOND tile puts it first — the same list the drag
      // moves, which is exactly what the old arrows could not promise (they stepped
      // through the stored order, past sunk empty rows).
      const menu = await openTileMenuByKey(page, second);
      const settled = reorderSettled(page);
      await menu.getByTestId("saved-move-up").click();
      await expect.poll(async () => (await tileOrder(page))[0]).toBe(second);
      await settled;

      await page.reload();
      await expect(page.getByTestId("saved-tiles")).toBeVisible();
      expect((await tileOrder(page))[0]).toBe(second);

      // Restore.
      const back = reorderSettled(page);
      const restore = await openTileMenuByKey(page, second);
      await restore.getByTestId("saved-move-down").click();
      await expect.poll(async () => (await tileOrder(page))[0]).toBe(first);
      await back;
    } finally {
      await page.context().close();
    }
  });

  test("an empty tile reorders within the same saved list", async ({
    browser,
  }) => {
    test.slow();
    const page = await curatePage(browser);
    try {
      await page.goto("/trends");
      await expect(page.getByTestId("saved-tiles")).toBeVisible();

      const before = await tileOrder(page);
      const emptyKey = `bio:${TRENDS_CURATE_EMPTY_ANALYTE}`;
      const beforeIndex = before.indexOf(emptyKey);
      expect(beforeIndex).toBeGreaterThanOrEqual(0);
      const menu = await openTileMenu(page, TRENDS_CURATE_EMPTY_ANALYTE);
      await expect(menu.getByTestId("star-toggle")).toBeVisible();
      const direction = beforeIndex === 0 ? "down" : "up";
      const settled = reorderSettled(page);
      await menu.getByTestId(`saved-move-${direction}`).click();
      await expect
        .poll(async () => (await tileOrder(page)).indexOf(emptyKey))
        .toBe(beforeIndex + (direction === "down" ? 1 : -1));
      await settled;

      // Restore the saved order through the opposite arrow.
      const restore = reorderSettled(page);
      const restoreMenu = await openTileMenu(page, TRENDS_CURATE_EMPTY_ANALYTE);
      await restoreMenu
        .getByTestId(`saved-move-${direction === "down" ? "up" : "down"}`)
        .click();
      await expect
        .poll(async () => (await tileOrder(page)).indexOf(emptyKey))
        .toBe(beforeIndex);
      await restore;
    } finally {
      await page.context().close();
    }
  });
});
