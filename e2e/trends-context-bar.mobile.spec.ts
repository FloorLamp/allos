import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { hydratedClick, followLink } from "./helpers";
import { expandTrendsContext } from "./trends-chrome";

// The Trends phone chrome: the primary SECTION chips stay visible in one scrolling
// row while the active chart range is a fixed trigger at the right. Tapping that
// trigger expands only the range controls beneath the stable chips. The whole row
// rides the #1416 navbar's hide/reveal and replaces the heading band below `sm`.
//
// #1644 replaced the tab strip with the page's jump chips in the same slot: the
// chrome contract is unchanged, and STICKY-ON-MOBILE is now load-bearing rather
// than merely nice — it is the only navigation a long single page has.
//
// Why only a browser can see this: every clause is layout and scroll behaviour at a
// specific viewport. `npm run build` and the unit tier both pass on a page whose
// context bar never appears, never expands, or covers the first chart.
//
// What is pinned, and why each is a real regression class:
//   • Chips and the range LABEL are always visible. A chart drawn over a 90-day
//     window that a reader takes for all time is a wrong answer, and primary
//     navigation must not be hidden behind a filter disclosure.
//   • Expanding restores the range controls without moving/hiding the chips, and
//     a range change through them re-windows the page and re-labels the trigger.
//   • The bar rides the shell chrome. A sticky strip that did NOT hide with the
//     navbar would permanently spend the band F just reclaimed.
//   • The heading is gone below `sm` but still in the accessibility tree.
//   • The first chart sits inside the arc's ~400px target — the number the whole
//     wave is measured against.
//
// Fixture (#868 hygiene): READ-ONLY over the shared seed. Every test navigates and
// toggles client state; nothing is written and no shared-seed row is exact-counted,
// so it is repeat-safe and perturbs no neighbour (the trends-fold.mobile precedent).

const BAR = "trends-context-bar";

// The bar's scroll listener only exists after hydration (components/useShellChrome
// via TrendsContextBar) — the same deterministic signal ShellChrome exposes, so a
// scroll assertion waits for it instead of racing it.
async function barReady(page: Page) {
  const bar = page.getByTestId(BAR);
  await expect(bar).toHaveAttribute("data-ready", "true");
  return bar;
}

// Scroll and read back the offset actually reached, so a vacuous pass on a short
// page is impossible (the shell.mobile.spec.ts idiom).
async function scrollTo(page: Page, y: number): Promise<number> {
  await page.evaluate((to) => window.scrollTo(0, to), y);
  return page.evaluate(() => window.scrollY);
}

test.describe("the chips-and-range context bar", () => {
  test("shows the section chips and the window before any chart, with range controls put away", async ({
    page,
  }) => {
    await page.goto("/trends");

    await expect(page.getByTestId("trends-context-label")).toHaveText("90D");
    await expect(page.getByTestId(BAR)).toHaveAttribute(
      "data-expanded",
      "false"
    );
    // Only the range controls are put away; the section chips stay discoverable.
    await expect(page.getByTestId("trends-context-controls")).toBeHidden();
    // `exact` is load-bearing on every pill locator: Playwright matches an
    // accessible name by case-insensitive SUBSTRING, and the movers digest on this
    // page renders chips labelled "… over 90d" (lib/trends-digest).
    await expect(
      page.getByRole("link", { name: "90D", exact: true })
    ).toBeHidden();
    await expect(page.getByTestId("chart-jump-body")).toBeVisible();

    // The navigation row is full bleed like the other mobile tab-first pages:
    // no second 16px page gutter outside the chips or range trigger. The expanded
    // range controls retain their own readable gutter below.
    const [tabsBox, toggleBox, barBox, shellBox, viewportWidth] =
      await Promise.all([
        page.getByTestId("trends-section-chips").boundingBox(),
        page.getByTestId("trends-context-toggle").boundingBox(),
        page.getByTestId(BAR).boundingBox(),
        page.getByTestId("shell-chrome").boundingBox(),
        page.evaluate(() => window.innerWidth),
      ]);
    expect(tabsBox).not.toBeNull();
    expect(toggleBox).not.toBeNull();
    expect(barBox).not.toBeNull();
    expect(shellBox).not.toBeNull();
    expect(tabsBox!.x).toBeCloseTo(0, 0);
    expect(toggleBox!.x + toggleBox!.width).toBeCloseTo(viewportWidth, 0);
    expect(barBox!.y).toBeCloseTo(shellBox!.y + shellBox!.height, 0);

    // The label sits ABOVE the first chart — the invariant, stated positionally.
    const label = await page.getByTestId("trends-context-label").boundingBox();
    const tile = page.getByTestId("trend-mini-card").first(); // first-ok: the grid's topmost tile is the subject — "is the window named above the FIRST chart?"
    await expect(tile).toBeVisible();
    const tileBox = await tile.boundingBox();
    expect(label!.y).toBeLessThan(tileBox!.y);
  });

  test("the range trigger follows the window in force", async ({ page }) => {
    // A deep link naming a custom window: the label has no pill to borrow a name
    // from and says the dates instead, so the chart below it can't read as "all
    // time" (or as the 90D default).
    await page.goto("/trends?from=2026-01-01&to=2026-02-01");
    await expect(page.getByTestId("trends-context-label")).toHaveText(
      "2026-01-01 → 2026-02-01"
    );

    // The trigger names the WINDOW only; where you are on the page is the chips'
    // job, and they are always on screen to say it.
    await page.goto("/trends");
    await expect(page.getByTestId("trends-context-label")).toHaveText("90D");
    await expect(page.getByTestId("chart-jump-body")).toBeVisible();
  });

  test("tapping the range expands its controls without hiding the tabs", async ({
    page,
  }) => {
    await page.goto("/trends");
    const toggle = page.getByTestId("trends-context-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    await hydratedClick(page, toggle);

    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("trends-context-controls")).toBeVisible();
    // The range pills come back…
    await expect(
      page.getByRole("link", { name: "90D", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "All time", exact: true })
    ).toBeVisible();
    // …while the chip strip stays visible in the row above.
    await expect(page.getByTestId("chart-jump-body")).toBeVisible();
    // The #1455 Custom… collapse still nests inside it.
    await expect(page.getByTestId("custom-range-toggle")).toBeVisible();
    // The range label never leaves — expanded or not, the window is named.
    await expect(page.getByTestId("trends-context-label")).toBeVisible();

    // Close from scroll depth, where removing the expanded in-flow panel changes
    // page geometry. That layout shift must not be mistaken for a scroll-down
    // gesture that hides the whole shell/context row.
    const bar = await barReady(page);
    const deep = await scrollTo(page, 360);
    expect(deep).toBeGreaterThan(200);
    // The listener is rAF-coalesced. Observe the completed downward transition
    // before issuing the upward gesture, otherwise both programmatic scrolls can
    // land in one frame and the listener sees only a net scroll down.
    await expect(bar).toHaveAttribute("data-hidden", "true");
    await scrollTo(page, deep - 120);
    await expect(bar).toHaveAttribute("data-hidden", "false");

    await hydratedClick(page, toggle);
    await expect(page.getByTestId("trends-context-controls")).toBeHidden();
    await expect(page.getByTestId("chart-jump-body")).toBeVisible();
    await expect(bar).toHaveAttribute("data-hidden", "false");
    await expect(page.getByTestId("shell-chrome")).toHaveAttribute(
      "data-hidden",
      "false"
    );
  });

  test("a range change through the expanded bar re-windows the page and re-labels it", async ({
    page,
  }) => {
    await page.goto("/trends");
    await expandTrendsContext(page);

    await followLink(
      page,
      page.getByRole("link", { name: "All time", exact: true }),
      /range=all/
    );

    // The trigger names the new window without collapsing the controls the user
    // is actively navigating.
    await expect(page.getByTestId("trends-context-label")).toHaveText("All");
    await expect(page.getByTestId("trends-context-toggle")).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    await expect(page.getByTestId("trends-context-controls")).toBeVisible();
    // And the charts came with it (the tiles re-render under the new range).
    await expect(page.getByTestId("saved-tiles")).toBeVisible();
  });
});

test.describe("the bar rides the shell chrome (F + #1416)", () => {
  test("hides on scroll-down with the navbar and returns on scroll-up", async ({
    page,
  }) => {
    await page.goto("/trends");
    const bar = await barReady(page);
    const chrome = page.getByTestId("shell-chrome");
    await expect(bar).toHaveAttribute("data-hidden", "false");

    // It is genuinely sticky on a phone — the premise of "the label sticks with
    // the navbar".
    await expect
      .poll(() =>
        page.getByTestId(BAR).evaluate((el) => getComputedStyle(el).position)
      )
      .toBe("sticky");

    const deep = await scrollTo(page, 600);
    expect(deep, "Trends should be scrollable at phone width").toBeGreaterThan(
      200
    );
    // ONE state, two elements: the bar hides because the navbar does.
    await expect(chrome).toHaveAttribute("data-hidden", "true");
    await expect(bar).toHaveAttribute("data-hidden", "true");
    // Transform-based, so the DOM still calls it visible — assert the travel.
    await expect
      .poll(async () => (await bar.boundingBox())?.y ?? 0)
      .toBeLessThan(0);

    // Any upward scroll brings both straight back, still deep in the page…
    await scrollTo(page, deep - 300);
    await expect(chrome).toHaveAttribute("data-hidden", "false");
    await expect(bar).toHaveAttribute("data-hidden", "false");
    // …and the label is back on screen, stuck under the navbar: mid-scroll, the
    // charts you are reading are still named.
    await expect
      .poll(async () => (await bar.boundingBox())?.y ?? -1)
      .toBeGreaterThan(0);
    await expect(page.getByTestId("trends-context-label")).toBeInViewport();
    // The SECTION CHIPS come back with it (#1644): on one long page, the only way
    // to reach another section mid-scroll is the strip riding the chrome.
    await expect(page.getByTestId("trends-section-chips")).toBeInViewport();
    await expect(page.getByTestId("chart-jump-nutrition")).toBeInViewport();
  });

  test("a chip tapped from deep in the page jumps to its section", async ({
    page,
  }) => {
    // The long-scroll trade #1644 accepted, proven where it is paid: scroll into
    // the Body census, reveal the chrome, and the strip is still the navigation.
    await page.goto("/trends");
    const bar = await barReady(page);
    const deep = await scrollTo(page, 1200);
    expect(deep, "Trends should be long at phone width").toBeGreaterThan(600);
    await expect(bar).toHaveAttribute("data-hidden", "true");
    await scrollTo(page, deep - 200);
    await expect(bar).toHaveAttribute("data-hidden", "false");

    const chip = page.getByTestId("chart-jump-insights");
    await expect(chip).toBeInViewport();
    await chip.click();
    await expect(page).toHaveURL(/#insights$/);
    await expect(page.getByTestId("trends-section-insights")).toBeInViewport();
  });
});

test.describe("the heading band is given up below sm (F)", () => {
  test("no visible title or subtitle, but the h1 is still there for AT", async ({
    page,
  }) => {
    await page.goto("/trends");

    // The h1 is `sr-only`: present in the accessibility tree (so the page is still
    // named) and occupying no visual band.
    const h1 = page.getByRole("heading", { name: "Trends", level: 1 });
    await expect(h1).toHaveCount(1);
    const box = await h1.boundingBox();
    expect(box!.height).toBeLessThan(4);

    // The two-line subtitle is removed, not shrunk.
    await expect(page.getByText("Your analytics lens —")).toBeHidden();
  });

  test("the first chart clears the wave's ~400px target", async ({ page }) => {
    // The arc's acceptance number (#1485). Measured, not asserted qualitatively:
    // the point of F is a specific band of chrome, and a regression that quietly
    // re-adds 130px would still pass "the tile is in the viewport".
    await page.goto("/trends");
    const tile = page.getByTestId("trend-mini-card").first(); // first-ok: the grid's topmost tile IS the measurement's subject
    await expect(tile).toBeVisible();
    const box = await tile.boundingBox();
    // A ceiling with headroom for ordinary content changes, well under the 646px
    // this wave started from.
    expect(box!.y, "first chart offset on the Trends head").toBeLessThan(430);
    await expect(tile).toBeInViewport();
  });
});

test.describe("desktop keeps the classic pills-and-tabs layout (F)", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("no toggle, controls always shown, heading intact", async ({ page }) => {
    await page.goto("/trends");

    // The collapse is a phone affordance only — from `sm` up there is nothing to
    // expand, and this is ONE component tree responding to width, not a
    // hand-mirrored desktop copy.
    await expect(page.getByTestId("trends-context-toggle")).toBeHidden();
    await expect(page.getByTestId("trends-context-controls")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "90D", exact: true })
    ).toBeVisible();
    await expect(page.getByTestId("chart-jump-starred")).toBeVisible();

    // The heading band is untouched on desktop.
    await expect(
      page.getByRole("heading", { name: "Trends", level: 1 })
    ).toBeVisible();
    await expect(page.getByText("Your analytics lens —")).toBeVisible();
  });
});
