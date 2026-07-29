import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { followLink, settledClick } from "./helpers";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_TRENDS_PIN } from "./fixture-logins";

// ★-PINNED Body card order (#1643) — the USER's half of the Trends → Body sequence.
//
// Trends had TWO user-arrangement substrates. Overview's is `saved_items`: one ★
// store, starred from a tile's ⋯ menu or from a metric's own page, re-sequenced by
// drag (and the menu's arrow fallback) through `reorderSaved` → `setSavedOrder`. The
// Body tab had a second, order-only one that no UI ever wrote. #1643 retired it: the
// Body tab now leads with the profile's STARRED cards, in the saved order, and ranks
// everything else behind them.
//
// Only a browser can prove the two ends meet, because they are three different pages
// over one store. Three moves, in one fixture's own profile:
//   1. star a Body metric from the page its card taps through to → it leads the tab;
//   2. re-sequence it on OVERVIEW → the Body stack follows, with no gesture on Body;
//   3. unstar it → it drops back to its ranked slot.
//
// Fixture (#868 hygiene): a dedicated WRITE-granted member whose profile has exactly
// two Body cards with data — `weight` (a standard metric seed, so already starred and
// leading) and `steps` (unstarred, ranked behind it). Each test restores the seed
// state, so --repeat-each stays clean and no neighbouring Trends spec's order moves.

const PIN = { username: E2E_LOGIN_TRENDS_PIN, password: E2E_MEMBER_PASSWORD };

const WEIGHT = "body-tile-weight";
const STEPS = "body-tile-steps";
const STEPS_DETAIL = "/trends/metric/steps";

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

// Toggle the steps metric's ★ through the affordance a Body card actually offers:
// the card's own header link opens the metric page, and the ★ is there (#1456). The
// walk THROUGH the card is the point — it is what makes "star from the census" true
// without a second control on every card.
async function toggleStepsStarFromItsCard(
  page: Page,
  expected: "false" | "true"
): Promise<void> {
  await followLink(
    page,
    page.getByTestId(STEPS).getByTestId("trend-mini-header-link"),
    new RegExp(STEPS_DETAIL)
  );
  const star = page.getByTestId("star-toggle");
  await expect(star).toHaveAttribute("aria-pressed", expected);
  await settledClick(page, star);
  await expect(star).toHaveAttribute(
    "aria-pressed",
    expected === "false" ? "true" : "false"
  );
  await openBodyTiles(page);
}

// The Overview grid's populated order, as the grid renders it.
async function overviewTileKeys(page: Page): Promise<string[]> {
  return page
    .getByTestId("saved-tiles")
    .evaluate((el) =>
      Array.from(el.querySelectorAll("[data-tile-key]")).map(
        (n) => n.getAttribute("data-tile-key") ?? ""
      )
    );
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

test.describe("★-pinned Body card order (#1643)", () => {
  test("starring a Body metric pins its card to the top; unstarring returns it to its ranked slot", async ({
    browser,
  }) => {
    test.slow(); // local `next dev` compiles the Trends route on first hit
    const page = await loginAs(browser, PIN);
    try {
      await openBodyTiles(page);

      // Day one: `weight` is a standard metric seed (starred at profile creation) and
      // `steps` is not, so the ranked default puts steps behind it.
      expect(await tileOrder(page, [WEIGHT, STEPS])).toEqual([WEIGHT, STEPS]);

      // One gesture, one store — the same `saved_items` row an Overview tile's star
      // writes, reached through the card the Body tab already renders.
      await toggleStepsStarFromItsCard(page, "false");
      expect(await tileOrder(page, [WEIGHT, STEPS])).toEqual([STEPS, WEIGHT]);

      // Unstar: back to the ranked slot, not to some remembered position. Restoring
      // the fixture IS the second assertion.
      await toggleStepsStarFromItsCard(page, "true");
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
      await toggleStepsStarFromItsCard(page, "false");
      expect(await tileOrder(page, [WEIGHT, STEPS])).toEqual([STEPS, WEIGHT]);

      // Move it later on OVERVIEW — the ⋯ menu's arrow is the non-pointer fallback
      // for the drag and writes the same `saved_items` positions, which is why it is
      // the honest way to assert "Body follows the saved order" without pointer
      // physics standing in for the claim.
      await page.goto("/trends?tab=overview");
      await expect(page.getByTestId("saved-tiles")).toBeVisible();
      expect((await overviewTileKeys(page))[0]).toBe("metric:steps");
      await page
        .locator('[data-tile-key="metric:steps"]')
        .getByTestId("overflow-menu-trigger")
        .click();
      const overviewMenu = page.getByTestId("trend-tile-menu");
      await expect(overviewMenu).toBeVisible();
      const settled = reorderSettled(page);
      await overviewMenu.getByTestId("saved-move-down").click();
      // The optimistic swap first (the grid owns the list), then the persist — a
      // navigation that outran either would read the order it was about to leave.
      await expect
        .poll(async () => (await overviewTileKeys(page))[0])
        .toBe("metric:weight");
      await settled;

      // No control on the Body tab was touched, and its order moved with the store.
      await openBodyTiles(page);
      expect(await tileOrder(page, [WEIGHT, STEPS])).toEqual([WEIGHT, STEPS]);

      // Restore: unstarring drops steps out of the pinned run entirely.
      await toggleStepsStarFromItsCard(page, "true");
      expect(await tileOrder(page, [WEIGHT, STEPS])).toEqual([WEIGHT, STEPS]);
    } finally {
      await page.context().close();
    }
  });

  test("the tab says how its arrangement works", async ({ browser }) => {
    const page = await loginAs(browser, PIN);
    try {
      await openBodyTiles(page);

      // The pin gesture lives on the metric page and the re-sequence on Overview, so
      // the tab has to say so — the alternative was a second reorder surface here.
      const hint = page.getByTestId("body-pin-hint");
      await expect(hint).toBeVisible();
      await expect(
        hint.getByRole("link", { name: "Overview" })
      ).toHaveAttribute("href", "/trends?tab=overview");

      // …and the route it describes is one tap from the card itself.
      await expect(
        page.getByTestId(STEPS).getByTestId("trend-mini-header-link")
      ).toHaveAttribute("href", STEPS_DETAIL);
    } finally {
      await page.context().close();
    }
  });
});
