import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { expandTrendsContext } from "./trends-chrome";
import {
  E2E_LOGIN_TRENDS_COMPARE,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { loginAs } from "./nav";
import { followLink } from "./helpers";

// Trends tab order + the Compare fold (issue #1489).
//
// Two changes, one surface:
//   A. the strip is THREE chips in frequency order — Overview | Nutrition |
//      Insights — after Body folded into Overview and Fitness moved to Training;
//   B. Compare stopped being a tab and became a SECTION of Insights, and with it
//      body self-history analytics remain available for a school-age minor.
//
// Runs in the `mobile` project (390×844) by its file name alone; the desktop
// project testIgnores `*.mobile.spec.ts`. The chip-fit assertion is only
// observable at phone width, and the rest of the fold is asserted in the same
// viewport so the whole change is proven where it is tightest.
//
// Fixtures (#868 hygiene), both read-only:
//   • the shared seed (profile 1, an adult) for the strip and the legacy deep
//     link — navigation only, no writes, no exact count of a shared-seed row;
//   • the dedicated E2E_LOGIN_TRENDS_COMPARE minor profile, with weight + resting
//     HR on shared dates. It owns its readings, so a neighbour's write and
//     `--repeat-each` can't move them.
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };

// THREE since #3512 retired Fitness into Training → Analyze.
const TAB_ORDER = ["Overview", "Nutrition", "Insights"];
// Data-independent marker of the Insights tab's AI half.
const INSIGHTS_MARKER = "Date to analyze";

// `loginAs` opens its own context, which does NOT inherit the project's `use`
// block — so the phone viewport has to be passed explicitly or the member page
// would render the desktop shell.
async function comparePage(browser: Parameters<typeof loginAs>[0]) {
  return loginAs(
    browser,
    { username: E2E_LOGIN_TRENDS_COMPARE, password: E2E_MEMBER_PASSWORD },
    PHONE
  );
}

// The hub's tab strip, located by the chip that is in it for every profile —
// scoping by containment rather than by position keeps this honest if the page
// ever grows a second tablist.
function tabStrip(page: Page) {
  return page
    .getByRole("tablist")
    .filter({ has: page.getByRole("tab", { name: "Overview", exact: true }) });
}

test.describe("A — the tab strip is three chips in frequency order", () => {
  test("renders the new order, without a Compare, Body, or Fitness chip", async ({
    page,
  }) => {
    await page.goto("/trends");
    const strip = tabStrip(page);
    await expect(strip.getByRole("tab")).toHaveText(TAB_ORDER);

    // Neither retired tab is in the strip. `exact` is load-bearing: Playwright
    // matches accessible names by case-insensitive substring.
    for (const gone of ["Compare", "Body", "Fitness"]) {
      await expect(
        page.getByRole("tab", { name: gone, exact: true })
      ).toHaveCount(0);
    }
  });

  test("the one-row strip shows every tab beside the range trigger, and keeps its scroller for a set that would not fit", async ({
    page,
  }) => {
    await page.goto("/trends");
    const strip = tabStrip(page);
    await expect(strip.getByRole("tab")).toHaveCount(TAB_ORDER.length);

    // The range trigger owns the fixed right edge, leaving the primary tabs one
    // stable horizontal scroller instead of hiding them inside that trigger. #640
    // gave the strip that scroller and it is still here — asserted as the PROPERTY
    // (an overflow-x scroller) rather than as "there is something to scroll right
    // now", because #2614 made the tab set actually FIT the column the trigger
    // leaves it. A strip that needs no swipe is the better outcome, and it is what
    // the clause below has always been about.
    await expect(strip).toHaveCSS("overflow-x", "auto");
    expect(
      await strip.evaluate((el) => el.scrollWidth - el.clientWidth)
    ).toBeLessThanOrEqual(1);

    // The LAST chip is reachable — the clause this test owns, impossible when the
    // strip clipped instead of scrolling. Reachable with no swipe at all now: in
    // the viewport as rendered, with nothing scrolled into view first.
    const insights = strip.getByRole("tab", { name: "Insights" });
    await expect(insights).toBeInViewport();
    await followLink(page, insights, /tab=insights/);
    await expect(strip.getByRole("tab", { name: "Insights" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });
});

test.describe("B — Compare folded into Insights", () => {
  test("a retired ?tab=compare deep link lands on Insights with the comparison rendered", async ({
    page,
  }) => {
    // The link an old bookmark or a shared URL carries. A
    // vocabulary mapping in lib/trends-tabs.ts resolves it — no redirect — so the
    // cmpA/cmpB params ride along untouched.
    await page.goto(
      "/trends?tab=compare&cmpA=metric:weight&cmpB=metric:resting_hr"
    );
    await expect(page).toHaveURL(/tab=compare/);
    await expandTrendsContext(page);
    await expect(
      page.getByRole("tab", { name: "Insights", exact: true })
    ).toHaveAttribute("aria-selected", "true");

    // The comparison itself renders — same chart, same dual axis (#400) as it drew
    // on its own tab.
    const chart = page.getByTestId("compare-chart");
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute("data-axis-mode", "dual");

    // …alongside the AI half, since profile 1 is an adult: the tab is BOTH now.
    await expect(page.getByTestId("insights-ai")).toBeVisible();
  });
});

test.describe("C — school-age self-history analytics stay available", () => {
  test("a school-age minor gets the complete Insights surface", async ({
    browser,
  }) => {
    test.slow(); // local `next dev` compiles the Trends route on first hit
    const member = await comparePage(browser);
    try {
      await member.goto("/trends");
      await expandTrendsContext(member);
      const strip = tabStrip(member);
      await expect(strip.getByRole("tab")).toHaveText(TAB_ORDER);

      await member.goto(
        "/trends?tab=insights&cmpA=metric:weight&cmpB=metric:resting_hr"
      );
      await expandTrendsContext(member);
      await expect(
        member.getByRole("tab", { name: "Insights", exact: true })
      ).toHaveAttribute("aria-selected", "true");

      // Compare WORKS for the minor: two of its own series, overlaid.
      const chart = member.getByTestId("compare-chart");
      await expect(chart).toBeVisible();
      await expect(chart).toHaveAttribute("data-axis-mode", "dual");

      await expect(member.getByTestId("insights-ai")).toBeVisible();
      await expect(member.getByText(INSIGHTS_MARKER)).toBeVisible();
      await expect(member.getByTestId("recap-narrative-form")).toBeVisible();
    } finally {
      await member.context().close();
    }
  });
});
