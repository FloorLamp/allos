import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { settledClick } from "./helpers";
import { expandTrendsContext } from "./trends-chrome";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_TRENDS_COMPARE,
  E2E_MEMBER_PASSWORD,
  TRENDS_COMPARE_VIEW,
} from "./fixture-logins";

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
//     min-training-age gate, with weight + resting HR on shared dates and a saved
//     view stored under the retired `tab: "compare"`) for the gate move and the
//     saved-view resolution. It owns its readings and its view, so a neighbour's
//     write and `--repeat-each` can't move them.
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };

const TAB_ORDER = ["Overview", "Body", "Fitness", "Nutrition", "Insights"];
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

test.describe("A — the tab strip is five chips in frequency order", () => {
  test("renders the new order, without a Compare chip", async ({ page }) => {
    await page.goto("/trends");
    // The strip collapses into the #1485 F context bar at phone width.
    await expandTrendsContext(page);
    const strip = tabStrip(page);
    await expect(strip.getByRole("tab")).toHaveText(TAB_ORDER);

    // Compare is no longer a tab anywhere in the strip. `exact` is load-bearing:
    // Playwright matches an accessible name by case-insensitive SUBSTRING, and the
    // Body tab's source-comparison section is headed "Compare sources".
    await expect(
      page.getByRole("tab", { name: "Compare", exact: true })
    ).toHaveCount(0);
  });

  test("all five chips fit 390px — the strip never scrolls", async ({
    page,
  }) => {
    await page.goto("/trends");
    await expandTrendsContext(page);
    const strip = tabStrip(page);
    await expect(strip.getByRole("tab")).toHaveCount(TAB_ORDER.length);

    // The strip is an `overflow-x-auto` row, so a sixth chip would not CLIP — it
    // would silently hide off the right edge, which is the failure #1489 removes.
    // scrollWidth fitting clientWidth is the direct expression of "nothing hidden";
    // the per-chip check names which chip overflowed if one ever does.
    const fits = await strip.evaluate(
      (el) => el.scrollWidth <= el.clientWidth + 1
    );
    expect(fits, "the Trends tab strip overflows a 390px viewport").toBe(true);

    const overflowing = await strip.evaluate((el) =>
      Array.from(el.querySelectorAll('[role="tab"]'))
        .filter(
          (t) =>
            t.getBoundingClientRect().right >
            document.documentElement.clientWidth + 1
        )
        .map((t) => t.textContent)
    );
    expect(overflowing, overflowing.join(", ")).toEqual([]);
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
        "Body",
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

  test("a saved view stored under the retired tab name still resolves", async ({
    browser,
  }) => {
    test.slow();
    const member = await comparePage(browser);
    try {
      await member.goto("/trends");
      // The saved-views bar rides the chip row, which the #1485 F context bar
      // collapses on a phone.
      await expandTrendsContext(member);
      // Applying a view is a Server Action that redirects to the hub's own param
      // vocabulary — including the `tab=compare` the row was stored with.
      await settledClick(
        member,
        member.getByRole("button", { name: TRENDS_COMPARE_VIEW, exact: true })
      );

      await expect(member).toHaveURL(/tab=compare/);
      await expect(member).toHaveURL(/cmpA=metric%3Aweight/);
      await expandTrendsContext(member);
      await expect(
        member.getByRole("tab", { name: "Insights", exact: true })
      ).toHaveAttribute("aria-selected", "true");
      await expect(member.getByTestId("compare-chart")).toBeVisible();
    } finally {
      await member.context().close();
    }
  });
});
