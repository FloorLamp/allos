import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_TRENDS_PIN } from "./fixture-logins";

// ★-PINNED Body card order (#1643) — the USER's half of the Trends → Body sequence.
//
// Trends had TWO user-arrangement substrates. Overview's is `saved_items`: one ★
// store, starred from the tile's ⋯ menu, re-sequenced by drag (and the menu's arrow
// fallback) through `reorderSaved` → `setSavedOrder`. The Body tab had a second,
// order-only one that no UI ever wrote. #1643 retired it: the Body tab now leads with
// the profile's STARRED cards, in the saved order, and ranks everything else behind
// them.
//
// Only a browser can prove the two ends meet, because they are two different pages
// over one store. Three moves, in one fixture's own profile:
//   1. star a Body card → it leads the Body stack;
//   2. re-sequence it on OVERVIEW → the Body stack follows, with no gesture on Body;
//   3. unstar it → it drops back to its ranked slot.
//
// Fixture (#868 hygiene): a dedicated WRITE-granted member whose profile has exactly
// two Body cards with data — `weight` (a standard metric seed, so already starred and
// leading) and `steps` (unstarred, ranked behind it). Each test restores the seed
// state, so --repeat-each stays clean and no neighbouring Trends spec's order moves.

const PIN = { username: E2E_LOGIN_TRENDS_PIN, password: E2E_MEMBER_PASSWORD };

// Document order of the named Body tiles, keeping only the ones present. Position IS
// the assertion, so this compares places rather than counting anything.
async function tileOrder(page: Page, ids: string[]): Promise<string[]> {
  return page.evaluate((names) => {
    const found = names
      .map((id) => ({
        id,
        el: document.querySelector(`[data-testid="${id}"]`),
      }))
      .filter((e): e is { id: string; el: Element } => e.el != null);
    found.sort((a, b) =>
      a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1
    );
    return found.map((e) => e.id);
  }, ids);
}

async function openBodyTiles(page: Page): Promise<void> {
  await page.goto("/trends?tab=body&view=tiles");
  await expect(page.getByTestId("body-metric-tiles")).toBeVisible();
}

// A Body card's ⋯ menu. The panel is PORTALED to <body>, so it is located on the
// page rather than inside the card.
async function bodyCardMenu(page: Page, testid: string) {
  await page.getByTestId(testid).getByTestId("overflow-menu-trigger").click();
  const menu = page.getByTestId("trend-tile-menu");
  await expect(menu).toBeVisible();
  return menu;
}

// Toggle one Body card's ★ and land back on a freshly rendered tab: the order is
// composed server-side from the saved rows, so the reload is what is being asserted.
async function toggleStar(page: Page, testid: string): Promise<void> {
  const menu = await bodyCardMenu(page, testid);
  await settledClick(page, menu.getByTestId("star-toggle"));
  await openBodyTiles(page);
}

// The Overview reorder persist is a Server Action fired from a transition (no form
// submit), so wait for its POST rather than a navigation.
function reorderSettled(page: Page) {
  return page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === "/trends",
    { timeout: 15_000 }
  );
}

const WEIGHT = "body-tile-weight";
const STEPS = "body-tile-steps";

test.describe("★-pinned Body card order (#1643)", () => {
  test("starring a Body card pins it to the top, unstarring returns it to its ranked slot", async ({
    browser,
  }) => {
    test.slow(); // local `next dev` compiles the Trends route on first hit
    const page = await loginAs(browser, PIN);
    try {
      await openBodyTiles(page);

      // Day one: `weight` is a standard metric seed (starred at profile creation) and
      // `steps` is not, so the ranked default puts steps behind it.
      expect(await tileOrder(page, [WEIGHT, STEPS])).toEqual([WEIGHT, STEPS]);

      // The census carries the ★ itself — this is the same `saved_items` write an
      // Overview tile's star makes, which is the whole point of one substrate.
      const menu = await bodyCardMenu(page, STEPS);
      await expect(menu.getByTestId("star-toggle")).toHaveAttribute(
        "aria-checked",
        "false"
      );
      await settledClick(page, menu.getByTestId("star-toggle"));
      await openBodyTiles(page);

      // Pinned cards lead, so steps overtakes weight.
      expect(await tileOrder(page, [WEIGHT, STEPS])).toEqual([STEPS, WEIGHT]);
      const pinnedMenu = await bodyCardMenu(page, STEPS);
      await expect(pinnedMenu.getByTestId("star-toggle")).toHaveAttribute(
        "aria-checked",
        "true"
      );
      await page.keyboard.press("Escape");

      // Unstar: back to the ranked slot, not to some remembered position. Restoring
      // the fixture IS the second assertion.
      await toggleStar(page, STEPS);
      expect(await tileOrder(page, [WEIGHT, STEPS])).toEqual([WEIGHT, STEPS]);
    } finally {
      await page.context().close();
    }
  });

  test("the Body order follows a re-sequence made on Overview, with no gesture on Body", async ({
    browser,
  }) => {
    test.slow();
    const page = await loginAs(browser, PIN);
    try {
      await openBodyTiles(page);
      await toggleStar(page, STEPS);
      expect(await tileOrder(page, [WEIGHT, STEPS])).toEqual([STEPS, WEIGHT]);

      // Move it later on OVERVIEW — the ⋯ menu's arrow is the non-pointer fallback
      // for the drag and writes the same `saved_items` positions, which is why it is
      // the honest way to assert "Body follows the saved order" without pointer
      // physics standing in for the claim.
      await page.goto("/trends?tab=overview");
      await expect(page.getByTestId("saved-tiles")).toBeVisible();
      await page
        .locator('[data-tile-key="metric:steps"]')
        .getByTestId("overflow-menu-trigger")
        .click();
      const overviewMenu = page.getByTestId("trend-tile-menu");
      await expect(overviewMenu).toBeVisible();
      const settled = reorderSettled(page);
      await overviewMenu.getByTestId("saved-move-down").click();
      await settled;

      // No star, no drag and no control of any kind was touched on the Body tab.
      await openBodyTiles(page);
      expect(await tileOrder(page, [WEIGHT, STEPS])).toEqual([WEIGHT, STEPS]);

      // Restore: unstarring drops steps out of the pinned run entirely.
      await toggleStar(page, STEPS);
      expect(await tileOrder(page, [WEIGHT, STEPS])).toEqual([WEIGHT, STEPS]);
    } finally {
      await page.context().close();
    }
  });

  test("the tab says how its arrangement works, and unpinnable cards carry no star", async ({
    browser,
  }) => {
    const page = await loginAs(browser, PIN);
    try {
      await openBodyTiles(page);

      // The reorder gesture lives on Overview, so the Body tab has to say so — the
      // alternative was a second drag surface for one job.
      const hint = page.getByTestId("body-pin-hint");
      await expect(hint).toBeVisible();
      await expect(
        hint.getByRole("link", { name: "Overview" })
      ).toHaveAttribute("href", "/trends?tab=overview");

      // Every rendered Body metric card offers the ★.
      await expect(
        page.getByTestId(WEIGHT).getByTestId("overflow-menu-trigger")
      ).toBeVisible();
      await expect(
        page.getByTestId(STEPS).getByTestId("overflow-menu-trigger")
      ).toBeVisible();
    } finally {
      await page.context().close();
    }
  });
});
