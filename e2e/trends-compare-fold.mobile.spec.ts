import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { expandTrendsContext } from "./trends-chrome";
import {
  E2E_LOGIN_TRENDS_COMPARE,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { loginAs } from "./nav";

// Trends tab order + the Compare fold (issue #1489).
//
// Two changes, one surface:
//   A. the strip is FIVE chips in frequency order — Overview | Body | Fitness |
//      Nutrition | Insights — which is what makes it fit a 390px phone unclipped;
//   B. Compare stopped being a tab and became a SECTION of Insights, and with it
//      the age gate moved from the TAB to the sections: a training-restricted
//      profile now SEES the Insights tab carrying only its (age-neutral) compare
//      section, while Fitness keeps its wholly-gated tab-level splice.
//
// Runs in the `mobile` project (390×844) by its file name alone; the desktop
// project testIgnores `*.mobile.spec.ts`. The chip-fit assertion is only
// observable at phone width, and the rest of the fold is asserted in the same
// viewport so the whole change is proven where it is tightest.
//
// Fixtures (#868 hygiene), both read-only:
//   • the shared seed (profile 1, an adult) for the strip and the legacy deep
//     link — navigation only, no writes, no exact count of a shared-seed row;
//   • the dedicated E2E_LOGIN_TRENDS_COMPARE profile (a MINOR under the seeded
//     min-training-age gate, with weight + resting HR on shared dates) for the
//     gate move. It owns its readings, so a neighbour's write and
//     `--repeat-each` can't move them.
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };

// FOUR since #1644 folded Body into Overview; permanent by owner ruling.
const TAB_ORDER = ["Overview", "Fitness", "Nutrition", "Insights"];
// Data-independent markers of the Insights tab's AI half (the age-gated content).
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
// ever grows a second tablist (the Fitness tab has a nested one).
function tabStrip(page: Page) {
  return page
    .getByRole("tablist")
    .filter({ has: page.getByRole("tab", { name: "Overview", exact: true }) });
}

test.describe("A — the tab strip is four chips in frequency order", () => {
  test("renders the new order, without a Compare or Body chip", async ({
    page,
  }) => {
    await page.goto("/trends");
    const strip = tabStrip(page);
    await expect(strip.getByRole("tab")).toHaveText(TAB_ORDER);

    // Neither retired tab is in the strip. `exact` is load-bearing: Playwright
    // matches accessible names by case-insensitive substring.
    for (const gone of ["Compare", "Body"]) {
      await expect(
        page.getByRole("tab", { name: gone, exact: true })
      ).toHaveCount(0);
    }
  });

  test("the one-row strip scrolls and brings a later selected tab into view", async ({
    page,
  }) => {
    await page.goto("/trends");
    const strip = tabStrip(page);
    await expect(strip.getByRole("tab")).toHaveCount(TAB_ORDER.length);

    // The range trigger owns the fixed right edge, leaving the primary tabs one
    // stable horizontal scroller instead of hiding them inside that trigger.
    const scrolls = await strip.evaluate(
      (el) => el.scrollWidth > el.clientWidth
    );
    expect(scrolls).toBe(true);

    const insights = strip.getByRole("tab", { name: "Insights" });
    await insights.click();
    await expect(insights).toHaveAttribute("aria-selected", "true");
    await expect
      .poll(() =>
        insights.evaluate((tab) => {
          const scroller = tab.parentElement;
          if (!scroller) return false;
          const tabRect = tab.getBoundingClientRect();
          const stripRect = scroller.getBoundingClientRect();
          return (
            tabRect.left >= stripRect.left && tabRect.right <= stripRect.right
          );
        })
      )
      .toBe(true);
  });
});

test.describe("B — Compare folded into Insights", () => {
  test("a retired ?tab=compare deep link lands on Insights with the comparison rendered", async ({
    page,
  }) => {
    // The link an old bookmark, a shared URL or a stored saved view carries. A
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

test.describe("C — the age gate moved from the tab to the sections", () => {
  test("a restricted profile gets the Insights tab with compare and no insight content", async ({
    browser,
  }) => {
    test.slow(); // local `next dev` compiles the Trends route on first hit
    const member = await comparePage(browser);
    try {
      await member.goto("/trends");
      await expandTrendsContext(member);
      const strip = tabStrip(member);
      // Fitness — wholly age-gated content — keeps its TAB-level splice; Insights
      // no longer does.
      await expect(strip.getByRole("tab")).toHaveText([
        "Overview",
        "Nutrition",
        "Insights",
      ]);

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

      // …and the gated half is not on the page at all — no situation analytics, no
      // recap cards, and above all no AI generate form.
      await expect(member.getByTestId("insights-ai")).toHaveCount(0);
      await expect(member.getByText(INSIGHTS_MARKER)).toHaveCount(0);
      await expect(member.getByTestId("recap-narrative-form")).toHaveCount(0);

      // The surviving tab-level gate still bounces its tab to the default.
      await member.goto("/trends?tab=fitness");
      await expandTrendsContext(member);
      await expect(
        member.getByRole("tab", { name: "Overview", exact: true })
      ).toHaveAttribute("aria-selected", "true");
      await expect(
        member.getByRole("tab", { name: "Fitness", exact: true })
      ).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });
});
