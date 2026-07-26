import { test, expect, type Page } from "@playwright/test";
import { followLink } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_VITALS_DAY,
  E2E_MEMBER_PASSWORD,
  VITALS_DAY_BP_LATER,
  VITALS_DAY_BP_LATER_TIME,
  VITALS_DAY_RESTING_HR,
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

test.describe("the 1D pill is scoped to the Body tab (B)", () => {
  test("Body offers it and the other tabs do not", async ({ page }) => {
    const pill = page.getByRole("link", { name: "1D", exact: true });

    // The pill moved to Body with the vitals it exists for (#1486).
    await page.goto("/trends?tab=body");
    await expect(pill).toBeVisible();

    // And the RETIRED ?tab=vitals still lands on that same tab, pill and all —
    // a vocabulary mapping, not a redirect (#1486).
    await page.goto("/trends?tab=vitals");
    await expect(page.getByRole("tab", { name: "Body" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(pill).toBeVisible();

    // On a daily-grain series a one-day window is a single dot — worse than
    // useless — so no other tab may advertise it. The shared pills stay shared.
    for (const tab of [
      "/trends",
      "/trends?tab=nutrition",
      "/trends?tab=insights",
    ]) {
      await page.goto(tab);
      // Exact, like the 1D locators above: the movers digest renders LINK chips
      // labelled "… over 30d" (lib/trends-digest), and Playwright's default
      // accessible-name matching is a case-insensitive SUBSTRING, so a bare
      // { name: "30D" } can resolve to two elements on the run dates where a
      // mover's series spans exactly the window.
      await expect(
        page.getByRole("link", { name: "30D", exact: true })
      ).toBeVisible();
      await expect(pill).toHaveCount(0);
    }
  });

  test("lighting 1D neither opens the Custom panel nor prints a summary chip", async ({
    page,
  }) => {
    // 1D matches no SHARED quick range, so without the extra-ranges half of
    // isCustomRange it would read as a hand-picked window and re-introduce both
    // of the chrome regressions #1455 D removed.
    await page.goto("/trends?tab=body");
    await followLink(
      page,
      page.getByRole("link", { name: "1D", exact: true }),
      /from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/
    );

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
      // view=all pins the classic chart stack on the phone too (#1067 Phase 2 made
      // tiles the mobile default), which is where the vitals charts live.
      await member.goto("/trends?tab=body&view=all");
      // The windowed daily view is what 1D replaces.
      await expect(member.getByTestId("vitals-systolic")).toBeVisible();

      await followLink(
        member,
        member.getByRole("link", { name: "1D", exact: true }),
        /from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/
      );

      // The swap: intraday cards in, the daily windowed ones out.
      await expect(member.getByTestId("vitals-intraday-hr")).toBeVisible();
      await expect(member.getByTestId("vitals-intraday-bp")).toBeVisible();
      await expect(member.getByTestId("vitals-intraday-spo2")).toBeVisible();
      await expect(member.getByTestId("vitals-systolic")).toHaveCount(0);

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
          doc: document.documentElement.scrollWidth,
        };
      });
      expect(geometry.left).toBe(0);
      expect(geometry.width).toBe(geometry.inner);
      expect(geometry.doc).toBe(geometry.inner);

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
      await member.goto("/trends?tab=body");

      const strip = member.getByTestId("vitals-today-strip");
      await expect(strip).toBeVisible();

      // The LATER of the fixture's two timed BP pairs wins "latest today", with
      // its clock time — the whole point of the strip over a chart's last point.
      const bp = strip.getByTestId("vitals-today-bp");
      await expect(bp).toContainText(VITALS_DAY_BP_LATER);
      await expect(bp).toContainText(VITALS_DAY_BP_LATER_TIME);

      // A day-granular aggregate has a value but no clock time, and is deliberately
      // in the strip rather than charted at 1D.
      const restingHr = strip.getByTestId("vitals-today-resting-hr");
      await expect(restingHr).toContainText(VITALS_DAY_RESTING_HR);
      await expect(restingHr).toContainText("today");

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
