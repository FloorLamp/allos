import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { expectNoClippedContent, followLink } from "./helpers";
import { loginAs } from "./nav";
import { expandTrendsContext } from "./trends-chrome";
import {
  E2E_LOGIN_VITALS_DAY,
  E2E_MEMBER_PASSWORD,
  VITALS_DAY_BP_LATER,
  VITALS_DAY_BP_LATER_TIME,
  VITALS_DAY_BODY_FAT,
  VITALS_DAY_RESTING_HR,
  VITALS_DAY_STEPS,
  VITALS_DAY_WEIGHT_KG,
} from "./fixture-logins";

// The Today strip, the 1D (intraday) window and the full-bleed mobile HR chart
// (issue #1466) — RE-POINTED to the merged Body tab by #1486, which retired the
// Vitals tab into Body's first section. Same layer, same fixtures, one tab.
//
// Runs in the `mobile` project (390×844) by its file name alone; the desktop
// project testIgnores `*.mobile.spec.ts`. All three behaviours are only observable
// at phone width, and two of them are layout-shaped — nothing below the browser
// tier can see them.
//
// Fixtures (#868 hygiene). Two kinds, both read-only:
//   • the shared seed, for the questions that are about the SURFACE (which tabs
//     offer a 1D pill) — navigation only, no writes, no exact count of a
//     shared-seed row;
//   • the dedicated E2E_LOGIN_VITALS_DAY profile seeded by e2e/seed-events.ts, for
//     the questions that are about a DAY'S DATA (the intraday charts, the strip's
//     values). Its vitals live nowhere else, so --repeat-each and a neighbour's
//     writes can't move them.
//
// `loginAs` opens its own context, which does NOT inherit the project's `use`
// block — so the phone viewport has to be passed explicitly or the member page
// would render the desktop shell and every mobile assertion below would be
// meaningless.
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };

async function vitalsDayPage(browser: Parameters<typeof loginAs>[0]) {
  return loginAs(
    browser,
    { username: E2E_LOGIN_VITALS_DAY, password: E2E_MEMBER_PASSWORD },
    PHONE
  );
}

// The fixture's day IS the profile's today; read it off the Today strip's link
// rather than recomputing the run's frozen clock here.
async function todayFromStrip(page: Page): Promise<string> {
  const href = await page
    .getByTestId("vitals-today-timeline-link")
    .getAttribute("href");
  const match = /from=(\d{4}-\d{2}-\d{2})/.exec(href ?? "");
  expect(match, `no day in timeline link href: ${href}`).not.toBeNull();
  return match![1];
}

test.describe("the 1D pill and the intraday swap it exists for (B)", () => {
  test("the hub offers 1D, and it swaps exactly one section", async ({
    page,
  }) => {
    const pill = page.getByRole("link", { name: "1D", exact: true });

    // The pill moved to Body with the vitals it exists for (#1486). Since #1485 F
    // the whole chip row is behind the phone context bar, so each check opens it.
    // #1644 made the hub one page: the pill is offered once, at the page's shared
    // range control, because the census it swaps is always on the page. What used
    // to be "no OTHER tab advertises it" is now the stronger, still-observable
    // claim below — exactly one section changes shape when it is lit.
    await page.goto("/trends");
    await expandTrendsContext(page);
    await expect(pill).toBeVisible();
    await expect(
      page.getByRole("link", { name: "30D", exact: true })
    ).toBeVisible();
    // Exactly one 1D pill on the page — one shared range control, not one per
    // section.
    await expect(pill).toHaveCount(1);

    // Lighting it swaps the BODY census to its clock-axis view and leaves the
    // daily-grain sections alone.
    await followLink(page, pill, /from=\d{4}-\d{2}-\d{2}/);
    await expect(page.getByTestId("body-intraday-view")).toBeVisible();
    await expect(page.getByTestId("body-tiles-view")).toHaveCount(0);
    await expect(page.getByTestId("trends-section-nutrition")).toBeVisible();
  });

  test("lighting 1D neither opens the Custom panel nor prints a summary chip", async ({
    page,
  }) => {
    // 1D matches no SHARED quick range, so without the extra-ranges half of
    // isCustomRange it would read as a hand-picked window and re-introduce both
    // of the chrome regressions #1455 D removed.
    await page.goto("/trends");
    await expandTrendsContext(page);
    await followLink(
      page,
      page.getByRole("link", { name: "1D", exact: true }),
      /from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/
    );
    await expandTrendsContext(page);

    await expect(page.getByTestId("custom-range-panel")).toBeHidden();
    await expect(page.getByTestId("custom-range-toggle")).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    await expect(page.getByTestId("range-summary-chip")).toHaveCount(0);
  });
});

test.describe("1D swaps in the intraday charts (B + C)", () => {
  test("the heart-rate plot spans the viewport and the daily cards step aside", async ({
    browser,
  }) => {
    test.slow(); // local `next dev` compiles the Trends route on first hit
    const member = await vitalsDayPage(browser);
    try {
      // `view=all` is intentionally ignored on phones: an ordinary range stays on
      // tiles, while 1D replaces that grid with the dedicated intraday lens.
      await member.goto("/trends?view=all");
      await expandTrendsContext(member);
      // The windowed daily view is what 1D replaces.
      await expect(member.getByTestId("body-tile-systolic")).toBeVisible();

      await followLink(
        member,
        member.getByRole("link", { name: "1D", exact: true }),
        /from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/
      );

      // The swap: intraday cards in, the daily windowed ones out.
      await expect(member.getByTestId("vitals-intraday-hr")).toBeVisible();
      await expect(member.getByTestId("vitals-intraday-bp")).toBeVisible();
      await expect(member.getByTestId("vitals-intraday-spo2")).toBeVisible();
      await expect(member.getByTestId("body-metric-tiles")).toHaveCount(0);

      // C — full-bleed: the plot box spans the whole viewport (not the gutter-inset
      // content column), and doing so widens nothing (no horizontal page scroll).
      const plot = member.getByTestId("vitals-intraday-hr-plot");
      await expect(plot).toBeVisible();
      const geometry = await plot.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return {
          left: Math.round(box.left),
          width: Math.round(box.width),
          inner: window.innerWidth,
        };
      });
      expect(geometry.left).toBe(0);
      expect(geometry.width).toBe(geometry.inner);
      // "…and widens nothing" is an ELEMENT-level claim (#1543): the shell clips
      // horizontal overflow, so a page-level width comparison would pass even if
      // the full-bleed plot spilled a hundred pixels past the right edge.
      await expectNoClippedContent(member);

      // And it is a real chart, taller than the standard h-48 windowed cards.
      const chart = plot.locator(".recharts-responsive-container");
      await expect(chart).toBeVisible();
      const height = await chart.evaluate((el) =>
        Math.round(el.getBoundingClientRect().height)
      );
      expect(height).toBeGreaterThan(192);
    } finally {
      await member.context().close();
    }
  });
});

test.describe("the Today strip (A)", () => {
  test("shows the day's latest reading per vital and links to the day view", async ({
    browser,
  }) => {
    test.slow();
    const member = await vitalsDayPage(browser);
    try {
      // The strip is the merged tab's FIRST section — above the fold on a phone,
      // before any chart or logging affordance (#1486).
      await member.goto("/trends");

      const strip = member.getByTestId("vitals-today-strip");
      await expect(strip).toBeVisible();

      // The LATER of the fixture's two timed BP pairs wins "latest today", with
      // its clock time — the whole point of the strip over a chart's last point.
      const bp = strip.getByTestId("vitals-today-bp");
      await expect(bp.locator("dt")).toHaveText("Blood Pressure");
      await expect(bp).toContainText(VITALS_DAY_BP_LATER);
      await expect(bp).toContainText(VITALS_DAY_BP_LATER_TIME);

      // A day-granular aggregate has a value but no clock time, and is deliberately
      // in the strip rather than charted at 1D.
      const restingHr = strip.getByTestId("vitals-today-resting-hr");
      await expect(restingHr.locator("dt")).toHaveText("Resting Heart Rate");
      await expect(restingHr).toContainText(VITALS_DAY_RESTING_HR);
      await expect(restingHr).toContainText("today");
      const weight = strip.getByTestId("vitals-today-weight");
      const bodyFat = strip.getByTestId("vitals-today-body-fat");
      await expect(weight.locator("dt")).toHaveText("Weight");
      await expect(bodyFat.locator("dt")).toHaveText("Body Fat");
      await expect(weight).toContainText(
        new RegExp(`${VITALS_DAY_WEIGHT_KG}\\s*kg`)
      );
      await expect(bodyFat).toContainText(
        new RegExp(`${VITALS_DAY_BODY_FAT}\\s*%`)
      );
      const steps = strip.getByTestId("vitals-today-steps");
      await expect(steps.locator("dt")).toHaveText("Daily Steps");
      await expect(steps).toContainText(
        new RegExp(`${VITALS_DAY_STEPS.toLocaleString("en-US")}\\s*steps`)
      );
      // Oxygen and respiratory rate have seeded readings and remain available in
      // their charts, but the concise Body snapshot intentionally excludes them.
      await expect(strip.getByTestId("vitals-today-spo2")).toHaveCount(0);
      await expect(
        strip.getByTestId("vitals-today-respiratory-rate")
      ).toHaveCount(0);
      await expect(strip.getByTestId("vitals-today-timeline-link")).toHaveText(
        "View timeline"
      );

      // The day's answers read as one balanced row, not a loose horizontally
      // scrolling string of values inside an oversized card.
      const stripBox = await strip.boundingBox();
      const weightBox = await weight.boundingBox();
      const bodyFatBox = await bodyFat.boundingBox();
      expect(stripBox).not.toBeNull();
      expect(weightBox).not.toBeNull();
      expect(bodyFatBox).not.toBeNull();
      expect(Math.abs(weightBox!.y - bodyFatBox!.y)).toBeLessThan(4);
      expect(weightBox!.width).toBeGreaterThan(stripBox!.width * 0.4);
      expect(bodyFatBox!.width).toBeGreaterThan(stripBox!.width * 0.4);

      const day = await todayFromStrip(member);
      await followLink(
        member,
        strip.getByTestId("vitals-today-timeline-link"),
        new RegExp(`/timeline\\?from=${day}&to=${day}`)
      );

      // The strip's destination is the surface it exists to make reachable: the
      // Timeline day view's intraday panel (#1068).
      await expect(member.getByTestId("intraday-panel")).toBeVisible();
      await expect(member.getByTestId("intraday-panel")).toHaveAttribute(
        "data-intraday-date",
        day
      );
    } finally {
      await member.context().close();
    }
  });
});
