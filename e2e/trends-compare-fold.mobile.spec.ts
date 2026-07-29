import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { expandTrendsContext } from "./trends-chrome";
import {
  E2E_LOGIN_TRENDS_COMPARE,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { loginAs } from "./nav";

// The Trends navigation strip + the Compare fold (issues #1489, #1644).
//
// Two changes, one surface:
//   A. the strip is FIVE chips in reading order — Starred | Body | Fitness |
//      Nutrition | Insights — which is what makes it fit a 390px phone unclipped.
//      Since #1644 they are SECTION anchors on one scrollable page rather than
//      tabs, in the same slot and at the same width.
//   B. Compare stopped being a tab and became a block of Insights, and with it the
//      age gate moved from the TAB to the sections: a training-restricted profile
//      SEES the Insights section carrying only its (age-neutral) compare block,
//      while Fitness keeps its wholly-gated section-level splice.
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

const CHIP_ORDER = ["Starred", "Body", "Fitness", "Nutrition", "Insights"];
// Data-independent marker of the Insights AI half (the age-gated content).
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

// The hub's section strip. Located by its own testid — the page carries exactly
// one, and the Body census's chart menu is a dropdown, not a second strip.
function chipStrip(page: Page) {
  return page.getByTestId("trends-section-chips");
}

test.describe("A — the section strip is five chips in reading order", () => {
  test("renders the section order, without a Compare chip", async ({
    page,
  }) => {
    await page.goto("/trends");
    const strip = chipStrip(page);
    await expect(strip.getByRole("link")).toHaveText(CHIP_ORDER);

    // Compare is no longer a top-level destination anywhere in the strip. `exact`
    // is load-bearing: Playwright matches accessible names by case-insensitive
    // substring.
    await expect(
      strip.getByRole("link", { name: "Compare", exact: true })
    ).toHaveCount(0);
    // Nor is there a tablist left on the hub at all.
    await expect(page.getByRole("tablist")).toHaveCount(0);
  });

  test("the one-row strip scrolls and its chips jump to their sections", async ({
    page,
  }) => {
    await page.goto("/trends");
    const strip = chipStrip(page);
    await expect(strip.getByRole("link")).toHaveCount(CHIP_ORDER.length);

    // The range trigger owns the fixed right edge, leaving the section chips one
    // stable horizontal scroller instead of hiding them inside that trigger.
    const scrolls = await strip.evaluate(
      (el) => el.scrollWidth > el.clientWidth
    );
    expect(scrolls).toBe(true);

    // A later chip is a plain in-page anchor: tapping it commits the hash and
    // brings its section into view on the one long page.
    const insights = page.getByTestId("chart-jump-insights");
    await insights.click();
    await expect(page).toHaveURL(/#insights$/);
    await expect(page.getByTestId("trends-section-insights")).toBeInViewport();
  });
});

test.describe("B — Compare folded into Insights", () => {
  test("a compare deep link renders the comparison in the Insights section", async ({
    page,
  }) => {
    // The link an old bookmark, a shared URL or a stored saved view carries. Its
    // `?tab=compare` died with the strip (#1644, no shim) but the cmpA/cmpB params
    // are read straight off the URL, so the comparison itself is untouched.
    await page.goto("/trends?cmpA=metric:weight&cmpB=metric:resting_hr");
    await expandTrendsContext(page);

    // The comparison itself renders — same chart, same dual axis (#400) as it drew
    // on its own tab.
    const chart = page.getByTestId("compare-chart");
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute("data-axis-mode", "dual");

    // …alongside the AI half, since profile 1 is an adult: the section is BOTH.
    await expect(page.getByTestId("insights-ai")).toBeVisible();
  });
});

test.describe("C — the age gate lives on the sections", () => {
  test("a restricted profile gets the Insights section with compare and no insight content", async ({
    browser,
  }) => {
    test.slow(); // local `next dev` compiles the Trends route on first hit
    const member = await comparePage(browser);
    try {
      await member.goto("/trends");
      await expandTrendsContext(member);
      const strip = chipStrip(member);
      // Fitness — wholly age-gated content — keeps its SECTION-level splice;
      // Insights no longer needs one.
      await expect(strip.getByRole("link")).toHaveText([
        "Starred",
        "Body",
        "Nutrition",
        "Insights",
      ]);
      // …and the splice is a real render gate, not just a missing chip.
      await expect(member.getByTestId("trends-section-fitness")).toHaveCount(0);
      await expect(member.getByTestId("trends-fitness")).toHaveCount(0);

      await member.goto("/trends?cmpA=metric:weight&cmpB=metric:resting_hr");
      await expandTrendsContext(member);
      await expect(member.getByTestId("trends-section-insights")).toBeVisible();

      // Compare WORKS for the minor: two of its own series, overlaid.
      const chart = member.getByTestId("compare-chart");
      await expect(chart).toBeVisible();
      await expect(chart).toHaveAttribute("data-axis-mode", "dual");

      // …and the gated half is not on the page at all — no situation analytics, no
      // recap cards, and above all no AI generate form.
      await expect(member.getByTestId("insights-ai")).toHaveCount(0);
      await expect(member.getByText(INSIGHTS_MARKER)).toHaveCount(0);
      await expect(member.getByTestId("recap-narrative-form")).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });
});
