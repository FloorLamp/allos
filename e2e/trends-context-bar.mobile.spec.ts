import { test, expect, type Page } from "@playwright/test";
import { hydratedClick, followLink } from "./helpers";
import { expandTrendsContext } from "./trends-chrome";

// The Trends phone chrome (issue #1485 F): the range pills and the tab strip
// collapse into ONE line — "Overview · 90D ▾" — that expands on tap, rides the
// #1416 navbar's hide/reveal, and replaces the heading band below `sm`.
//
// Why only a browser can see this: every clause is layout and scroll behaviour at a
// specific viewport. `npm run build` and the unit tier both pass on a page whose
// context bar never appears, never expands, or covers the first chart.
//
// What is pinned, and why each is a real regression class:
//   • The LABEL is always visible. The whole trade F makes is "hide the control,
//     keep the context" — a chart drawn over a 90-day window that a reader takes for
//     all time is a wrong answer, not a cosmetic one. So the label is asserted at the
//     top AND mid-scroll, and its text is asserted to name the window.
//   • Expanding restores the full controls, and a range change through them
//     re-windows the page and RE-LABELS the bar. A collapsed control that can't be
//     opened is a removed feature.
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

test.describe("the collapsed context bar (F)", () => {
  test("names the tab and the window before any chart, with the controls put away", async ({
    page,
  }) => {
    await page.goto("/trends");

    // The label is the ONE thing that survives the collapse.
    await expect(page.getByTestId("trends-context-label")).toHaveText(
      "Overview · 90D"
    );
    await expect(page.getByTestId(BAR)).toHaveAttribute(
      "data-expanded",
      "false"
    );
    // …and the controls it hides are genuinely put away, not merely off-screen:
    // `hidden` keeps a collapsed disclosure out of the accessibility tree too.
    await expect(page.getByTestId("trends-context-controls")).toBeHidden();
    // `exact` is load-bearing on every pill locator: Playwright matches an
    // accessible name by case-insensitive SUBSTRING, and the movers digest on this
    // page renders chips labelled "… over 90d" (lib/trends-digest).
    await expect(
      page.getByRole("link", { name: "90D", exact: true })
    ).toBeHidden();
    await expect(
      page.getByRole("tab", { name: "Body", exact: true })
    ).toHaveCount(0);

    // The label sits ABOVE the first chart — the invariant, stated positionally.
    const label = await page.getByTestId("trends-context-label").boundingBox();
    const tile = page.getByTestId("trend-mini-card").first(); // first-ok: the grid's topmost tile is the subject — "is the window named above the FIRST chart?"
    await expect(tile).toBeVisible();
    const tileBox = await tile.boundingBox();
    expect(label!.y).toBeLessThan(tileBox!.y);
  });

  test("the window in the label follows the window in force", async ({
    page,
  }) => {
    // A deep link naming a custom window: the label has no pill to borrow a name
    // from and says the dates instead, so the chart below it can't read as "all
    // time" (or as the 90D default).
    await page.goto("/trends?from=2026-01-01&to=2026-02-01");
    await expect(page.getByTestId("trends-context-label")).toHaveText(
      "Overview · 2026-01-01 → 2026-02-01"
    );

    // …and the tab half follows the tab.
    await page.goto("/trends?tab=body");
    await expect(page.getByTestId("trends-context-label")).toHaveText(
      "Body · 90D"
    );
  });

  test("tapping it expands to the full pill row and tab strip, and closes again", async ({
    page,
  }) => {
    await page.goto("/trends");
    const toggle = page.getByTestId("trends-context-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    await hydratedClick(page, toggle);

    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("trends-context-controls")).toBeVisible();
    // Both halves come back: the range pills…
    await expect(
      page.getByRole("link", { name: "90D", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "All time", exact: true })
    ).toBeVisible();
    // …and the tab strip, which stays HERE rather than moving to a bottom sheet
    // (explicitly rejected: primary nav stays discoverable and the bottom edge
    // belongs to the workout dock).
    await expect(
      page.getByRole("tab", { name: "Body", exact: true })
    ).toBeVisible();
    // The #1455 Custom… collapse still nests inside it.
    await expect(page.getByTestId("custom-range-toggle")).toBeVisible();
    // The label never leaves — expanded or not, the window is named.
    await expect(page.getByTestId("trends-context-label")).toBeVisible();

    await hydratedClick(page, toggle);
    await expect(page.getByTestId("trends-context-controls")).toBeHidden();
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

    // The label — collapsed again after the navigation — now names the new window.
    await expect(page.getByTestId("trends-context-label")).toHaveText(
      "Overview · All time"
    );
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
    expect(box!.y, "first chart offset on Trends → Overview").toBeLessThan(430);
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
    await expect(
      page.getByRole("tab", { name: "Overview", exact: true })
    ).toBeVisible();

    // The heading band is untouched on desktop.
    await expect(
      page.getByRole("heading", { name: "Trends", level: 1 })
    ).toBeVisible();
    await expect(page.getByText("Your analytics lens —")).toBeVisible();
  });
});
