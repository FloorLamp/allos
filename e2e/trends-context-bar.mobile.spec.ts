import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { bandStory, hydratedClick, followLink, settledBoxes } from "./helpers";
import { expandTrendsContext } from "./trends-chrome";

// The Trends phone chrome: primary tabs stay visible in one scrolling row while
// the active chart range is a fixed trigger at the right. Tapping that trigger
// expands only the range controls beneath the stable tabs. The whole row rides
// the #1416 navbar's hide/reveal and replaces the heading band below `sm`.
//
// Why only a browser can see this: every clause is layout and scroll behaviour at a
// specific viewport. `npm run build` and the unit tier both pass on a page whose
// context bar never appears, never expands, or covers the first chart.
//
// What is pinned, and why each is a real regression class:
//   • Tabs and the range LABEL are always visible. A chart drawn over a 90-day
//     window that a reader takes for all time is a wrong answer, and primary
//     navigation must not be hidden behind a filter disclosure.
//   • Expanding restores the range controls without moving/hiding the tabs, and
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

test.describe("the tab-and-range context bar", () => {
  test("shows primary tabs and the window before any chart, with range controls put away", async ({
    page,
  }) => {
    await page.goto("/trends");

    await expect(page.getByTestId("trends-context-label")).toHaveText("90D");
    await expect(page.getByTestId(BAR)).toHaveAttribute(
      "data-expanded",
      "false"
    );
    // Only the range controls are put away; the section tabs stay discoverable.
    await expect(page.getByTestId("trends-context-controls")).toBeHidden();
    // `exact` is load-bearing on every pill locator: Playwright matches an
    // accessible name by case-insensitive SUBSTRING, and the movers digest on this
    // page renders chips labelled "… over 90d" (lib/trends-digest).
    await expect(
      page.getByRole("link", { name: "90D", exact: true })
    ).toBeHidden();
    await expect(
      page.getByRole("tab", { name: "Overview", exact: true })
    ).toBeVisible();

    // The navigation row is full bleed like the other mobile tab-first pages:
    // no second 16px page gutter outside the tabs or range trigger. The expanded
    // range controls retain their own readable gutter below.
    const [tabsBox, toggleBox, barBox, shellBox] = await settledBoxes([
      page.getByTestId("trends-tabs"),
      page.getByTestId("trends-context-toggle"),
      page.getByTestId(BAR),
      page.getByTestId("shell-chrome"),
    ]);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(tabsBox.x).toBeCloseTo(0, 0);
    expect(toggleBox.x + toggleBox.width).toBeCloseTo(viewportWidth, 0);
    // NAMED, not just measured (#3364). This has gone red on CI three times —
    // `Expected: 57  Received: 187`, always the same 130px — on three PRs whose
    // diffs render nothing on this route, and each sighting cost a full diagnosis
    // because the message says only how far off it was. The band is `-mt-4`'d
    // against the content container's `pt-4`, so ANY element rendered above
    // `{children}` (the two banners in app/(app)/layout.tsx) displaces the bar by
    // its own height. bandStory names it. KEEP THIS: it is what makes the fourth
    // sighting a diagnosis instead of a fourth investigation.
    expect(
      barBox.y,
      await bandStory(page.getByTestId("shell-chrome"), page.getByTestId(BAR))
    ).toBeCloseTo(shellBox.y + shellBox.height, 0);

    // The label sits ABOVE the first chart — the invariant, stated positionally.
    const tile = page.getByTestId("trend-mini-card").first(); // first-ok: the grid's topmost tile is the subject — "is the window named above the FIRST chart?"
    await expect(tile).toBeVisible();
    const [labelBox, tileBox] = await settledBoxes([
      page.getByTestId("trends-context-label"),
      tile,
    ]);
    expect(labelBox.y).toBeLessThan(tileBox.y);
  });

  test("the range trigger follows the window in force", async ({ page }) => {
    // A deep link naming a custom window: the label has no pill to borrow a name
    // from and says the dates instead, so the chart below it can't read as "all
    // time" (or as the 90D default).
    await page.goto("/trends?from=2026-01-01&to=2026-02-01");
    await expect(page.getByTestId("trends-context-label")).toHaveText(
      "2026-01-01 → 2026-02-01"
    );

    // The selected tab is communicated by the always-visible tab itself, not
    // duplicated in the range trigger. (#1644 retired ?tab=body: the census rides
    // the default view, which the Overview chip selects.)
    await page.goto("/trends");
    await expect(page.getByTestId("trends-context-label")).toHaveText("90D");
    await expect(
      page.getByRole("tab", { name: "Overview", exact: true })
    ).toHaveAttribute("aria-selected", "true");
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
    // …while the tab strip stays visible in the row above.
    await expect(
      page.getByRole("tab", { name: "Overview", exact: true })
    ).toBeVisible();
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
    await expect(
      page.getByRole("tab", { name: "Overview", exact: true })
    ).toBeVisible();
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
    await expect(page.getByTestId("body-metric-tiles")).toBeVisible();
  });
});

// A device zone the run's pin can never equal: `pinnedTimezone` only ever returns
// `UTC` or an `Etc/GMT±N`, so any named city zone is guaranteed to differ from the
// profile's. Set on the browser CONTEXT — the signal the product actually reads —
// so nothing is written and this file stays read-only over the shared seed.
const DEVICE_AWAY_ZONE = "Asia/Tokyo";

test.describe("a band above the bar names itself (#3364)", () => {
  // THIS TEST IS NOT ABOUT THE TRAVEL BANNER — it has its own spec
  // (e2e/travel-timezone.spec.ts). It exists to prove the DIAGNOSTIC on the
  // geometry assertion above can actually see an insertion.
  //
  // Every run of this file on a healthy tree exercises bandStory's "nothing sits
  // between them" branch and nothing else, so the branch that matters — the one
  // that runs on the day CI is 130px out — would be an untested string, and would
  // stay untested precisely because the failure it describes is rare. The forged
  // band below is the only place it runs.
  //
  // FORGED ON PURPOSE, and distinguishable from a real sighting: this test puts
  // the banner there itself by moving the DEVICE, in its own context. A real
  // sighting appears in the first describe's assertion message with nobody having
  // asked for it.
  test("a banner between the shell and the bar is named, and the bar moves by exactly its height", async ({
    browser,
  }) => {
    // The state nine `own-zone` fixtures are in by design (e2e/fixture-timezones.ts
    // says so in its own header), and the state a leaked profile switch or a leaked
    // `profile_settings` timezone row would put the shared profile in: the device is
    // somewhere the profile's day is not, so the layout grows a banner above the
    // page content.
    const context = await browser.newContext({
      timezoneId: DEVICE_AWAY_ZONE,
    });
    const page = await context.newPage();
    try {
      await page.goto("/trends");
      const banner = page.getByTestId("travel-timezone-banner");
      // A NAMED CEILING, not a sleep — the banner cannot exist until React has
      // hydrated and the device-zone effect has run, and on a loaded runner that
      // chain outlasts the 5 s default (the same 20 s travel-timezone.spec.ts
      // measured for the same wait). This is a PRESENCE assertion, so the ceiling
      // costs nothing if the banner genuinely never comes.
      await expect(banner).toBeVisible({ timeout: 20_000 });

      const [shellBox, barBox] = await settledBoxes([
        page.getByTestId("shell-chrome"),
        page.getByTestId(BAR),
      ]);
      // What the NEXT red would print. Two claims: it names the element, and it
      // names it by testid rather than by a bare tag, which is the difference
      // between "a div" and "the travel banner".
      const story = await bandStory(
        page.getByTestId("shell-chrome"),
        page.getByTestId(BAR)
      );
      expect(story, "the band diagnostic must name what it saw").toContain(
        'data-testid="travel-timezone-banner"'
      );

      // And the displacement is the banner's own outer height — box plus the
      // margins it displaces with (`mb-5`), read from the element rather than
      // hard-coded, so a restyle cannot make this pass for the wrong reason. This
      // is the arithmetic the failing CI message never got to do: 187 − 57 is a
      // banner, not a mystery.
      const displacement = await banner.evaluate((el) => {
        const style = getComputedStyle(el);
        return (
          el.getBoundingClientRect().height +
          parseFloat(style.marginTop || "0") +
          parseFloat(style.marginBottom || "0")
        );
      });
      expect(barBox.y - (shellBox.y + shellBox.height), story).toBeCloseTo(
        displacement,
        0
      );
    } finally {
      await context.close();
    }
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
    //
    // The same #3364 diagnostic as above, for the same reason: this ceiling is the
    // OTHER assertion a band above the content moves, and 130px of banner would
    // push a 300px offset to 430 without naming what arrived.
    expect(
      box!.y,
      `first chart offset on Trends → Overview; ` +
        (await bandStory(page.getByTestId("shell-chrome"), tile))
    ).toBeLessThan(430);
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
