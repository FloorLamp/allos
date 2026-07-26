import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_TRENDS_CURATE,
  TRENDS_CURATE_EMPTY_ANALYTE,
} from "./fixture-logins";

// Trends Overview is CURATION-DRIVEN (#1487) and its tiles are dense (#1485 A+B).
//
// Two things this proves that no other tier can:
//   1. The membership flip is real — unstarring a STANDARD metric (training volume,
//      which used to render unconditionally) removes its tile, and the picker brings
//      it back. Both halves matter: a removal with no add gesture would strand the
//      tile forever, so the round trip is the feature.
//   2. The tile grid is two-abreast at 390px and a saved item with nothing to show
//      compacts to a one-line row BELOW the populated tiles, instead of ~300px of
//      "No data in this range" whitespace mid-grid.
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

const VOLUME = "Training volume";

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

test.describe("curated Trends Overview (#1487 / #1485 A+B)", () => {
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
      const picker = page.getByTestId("save-trend-picker");
      await picker.getByRole("combobox").selectOption("metric:volume");
      await settledClick(page, picker.getByRole("button", { name: "Star" }));

      // Restoring the fixture IS the assertion.
      await expect(tile(page, VOLUME)).toHaveCount(1);
    } finally {
      await page.context().close();
    }
  });

  test("populated tiles sit two-abreast at 390px and empty ones compact below them", async ({
    browser,
  }) => {
    test.slow();
    const page = await curatePage(browser);
    try {
      await page.goto("/trends");
      await expect(page.getByTestId("saved-tiles")).toBeVisible();

      // #1485 B — two columns at phone width. The fixture's two populated tiles
      // (weight, resting HR) share a row: same top, different left, each under half
      // the viewport. A single-column grid fails on the `top` equality.
      const weight = tile(page, "Weight");
      const hr = tile(page, "Resting heart rate");
      const wBox = await weight.boundingBox();
      const hBox = await hr.boundingBox();
      expect(wBox, "weight tile box").not.toBeNull();
      expect(hBox, "resting HR tile box").not.toBeNull();
      expect(Math.abs(wBox!.y - hBox!.y)).toBeLessThan(4);
      expect(wBox!.x).toBeLessThan(hBox!.x);
      expect(wBox!.width).toBeLessThan(195);

      // #1485 A — a saved analyte with no readings at all is a ONE-LINE row, not a
      // ~300px card, and it sinks below every populated tile. (The row's own height
      // is the assertion: a full tile here was the ~600px of mid-grid waste.)
      const empty = tile(page, TRENDS_CURATE_EMPTY_ANALYTE);
      await expect(empty).toBeVisible();
      const eBox = await empty.boundingBox();
      expect(eBox, "empty tile box").not.toBeNull();
      expect(eBox!.height).toBeLessThan(72);
      expect(eBox!.y).toBeGreaterThan(wBox!.y + wBox!.height);

      // Compaction, not omission (#1456): its unstar control is still reachable.
      const menu = await openTileMenu(page, TRENDS_CURATE_EMPTY_ANALYTE);
      await expect(menu.getByTestId("star-toggle")).toBeVisible();
    } finally {
      await page.context().close();
    }
  });
});
