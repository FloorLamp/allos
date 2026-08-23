import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { followLink, settledClick } from "./helpers";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_TRENDS_PIN } from "./fixture-logins";

// ★-PINNED Body card order (#1643) — the USER's half of the Trends → Overview → body census sequence.
//
// Trends had TWO user-arrangement substrates. Overview's is `saved_items`: one ★
// store, starred from a metric's own page, re-sequenced inside the pinned census
// run by drag (and the menu's arrow fallback). The
// the census formerly had a second, order-only one that no UI ever wrote. #1643 retired it: the
// body census now leads with the profile's STARRED cards, in the saved order, and ranks
// everything else behind them.
//
// Only a browser can prove the two ends meet, because they are three different pages
// over one store. Three moves, in one fixture's own profile:
//   1. star a Body metric from the page its card taps through to → it leads the tab;
//   2. re-sequence it inside the pinned census run;
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
  await page.goto("/trends?view=tiles");
  // The census streams in (#1644) — wait for its section to hold it before the
  // unscoped tile queries below.
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

// The census's pinned run, in rendered order.
async function pinnedTileKeys(page: Page): Promise<string[]> {
  return page
    .getByTestId("body-metric-tiles")
    .evaluate((el) =>
      Array.from(el.querySelectorAll('[data-testid="pinned-census-tile"]')).map(
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
      // writes, reached through the card the body census already renders.
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

  test("the Body order follows a re-sequence made in its pinned run", async ({
    browser,
  }) => {
    test.slow();
    const page = await loginAs(browser, PIN);
    try {
      await openBodyTiles(page);
      await toggleStepsStarFromItsCard(page, "false");
      expect(await tileOrder(page, [WEIGHT, STEPS])).toEqual([STEPS, WEIGHT]);

      // Move it later in the census — the ⋯ menu's arrow is the non-pointer
      // fallback for the drag and writes the same `saved_items` positions.
      await page.goto("/trends?view=tiles");
      await expect(page.getByTestId("body-metric-tiles")).toBeVisible();
      expect((await pinnedTileKeys(page))[0]).toBe("metric:steps");
      await page
        .locator('[data-tile-key="metric:steps"]')
        .getByTestId("overflow-menu-trigger")
        .click();
      const pinnedMenu = page.getByTestId("trend-tile-menu");
      await expect(pinnedMenu).toBeVisible();
      const settled = reorderSettled(page);
      await pinnedMenu.getByTestId("saved-move-down").click();
      // The optimistic swap first (the grid owns the list), then the persist — a
      // navigation that outran either would read the order it was about to leave.
      await expect
        .poll(async () => (await pinnedTileKeys(page))[0])
        .toBe("metric:weight");
      await settled;

      // The rendered order and stored order agree after navigation.
      await openBodyTiles(page);
      expect(await tileOrder(page, [WEIGHT, STEPS])).toEqual([WEIGHT, STEPS]);

      // Restore: unstarring drops steps out of the pinned run entirely.
      await toggleStepsStarFromItsCard(page, "true");
      expect(await tileOrder(page, [WEIGHT, STEPS])).toEqual([WEIGHT, STEPS]);
    } finally {
      await page.context().close();
    }
  });

  test("the census says how its arrangement works", async ({ browser }) => {
    const page = await loginAs(browser, PIN);
    try {
      await openBodyTiles(page);

      // The pin gesture lives on the metric page and the re-sequence in the pinned
      // census run, so the hint has to name both paths.
      const hint = page.getByTestId("body-pin-hint");
      await expect(hint).toBeVisible();
      await expect(hint).toContainText("Drag pinned cards here");

      // …and the route it describes is one tap from the card itself.
      await expect(
        page.getByTestId(STEPS).getByTestId("trend-mini-header-link")
      ).toHaveAttribute("href", STEPS_DETAIL);
    } finally {
      await page.context().close();
    }
  });

  test("an empty-window metric keeps its detail-page unstar path", async ({
    browser,
  }) => {
    const page = await loginAs(browser, PIN);
    try {
      await openBodyTiles(page);
      await toggleStepsStarFromItsCard(page, "false");

      await page.goto("/trends?view=tiles&from=2000-01-01&to=2000-01-01#body");
      const emptySteps = page.getByTestId(STEPS);
      await expect(emptySteps).toContainText("No data in this range");
      expect((await pinnedTileKeys(page))[0]).toBe("metric:steps");

      await followLink(
        page,
        emptySteps.getByTestId("trend-mini-header-link"),
        new RegExp(STEPS_DETAIL)
      );
      const star = page.getByTestId("star-toggle");
      await expect(star).toHaveAttribute("aria-pressed", "true");
      await settledClick(page, star);
      await expect(star).toHaveAttribute("aria-pressed", "false");

      await page.goto("/trends?view=tiles&from=2000-01-01&to=2000-01-01#body");
      await expect(page.getByTestId(STEPS)).toHaveCount(1);
      expect(await pinnedTileKeys(page)).not.toContain("metric:steps");
    } finally {
      await page.context().close();
    }
  });

  test("a starred metric renders exactly once at 390px (#3387)", async ({
    browser,
  }) => {
    const page = await loginAs(browser, PIN, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    try {
      await openBodyTiles(page);
      await expect(page.getByTestId(WEIGHT)).toHaveCount(1);
      await expect(page.getByTestId("vitals-today-strip")).toHaveCount(0);
      await expect(page.getByTestId("trends-section-starred")).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });
});
