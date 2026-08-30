import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { followLink } from "./helpers";
import { loginAs } from "./nav";
import { expandTrendsContext } from "./trends-chrome";
import { E2E_LOGIN_VITALS_DAY, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// The Timeline handoff, the 1D (intraday) window and the full-bleed mobile HR chart
// (issue #1466) — RE-POINTED to the merged body census by #1486, which retired the
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
//     the questions that are about a DAY'S DATA (the intraday charts and Timeline
//     handoff). Its vitals live nowhere else, so --repeat-each and a neighbour's
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

// The fixture's day IS the profile's today; read it off the Body-head link rather
// than recomputing the run's frozen clock here.
async function todayFromBodyLink(page: Page): Promise<string> {
  const href = await page
    .getByTestId("body-timeline-link")
    .getAttribute("href");
  const match = /from=(\d{4}-\d{2}-\d{2})/.exec(href ?? "");
  expect(match, `no day in timeline link href: ${href}`).not.toBeNull();
  return match![1];
}

test.describe("the 1D pill is scoped to the surface that owns the census (B)", () => {
  test("the landing surface offers it and the other tabs do not", async ({
    page,
  }) => {
    const pill = page.getByRole("link", { name: "1D", exact: true });

    // The pill moved to Body with the vitals it exists for (#1486) and followed the
    // census onto the Overview landing surface (#1644). Since #1485 F the whole
    // pill row is behind the phone context bar, so each check opens it.
    await page.goto("/trends");
    await expandTrendsContext(page);
    await expect(pill).toBeVisible();

    // And the RETIRED ?tab=body / ?tab=vitals still land on that same surface,
    // pill and all — through the default fallback, with no shim (#1635/#1644).
    for (const retired of ["/trends?tab=body", "/trends?tab=vitals"]) {
      await page.goto(retired);
      await expandTrendsContext(page);
      await expect(page.getByTestId("trends-section-body")).toBeVisible();
      await expect(pill).toBeVisible();
    }

    // On a daily-grain series a one-day window is a single dot — worse than
    // useless — so no other TAB may advertise it. The shared pills stay shared.
    for (const tab of ["/trends?tab=nutrition", "/trends?tab=insights"]) {
      await page.goto(tab);
      await expandTrendsContext(page);
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

test.describe("1D keeps Overview tiles-only on mobile (#2152)", () => {
  test("the intraday full charts stay off Overview and the tiles remain", async ({
    browser,
  }) => {
    test.slow(); // local `next dev` compiles the Trends route on first hit
    const member = await vitalsDayPage(browser);
    try {
      // `view=all` is intentionally ignored on phones at every range.
      await member.goto("/trends?view=all");
      await expandTrendsContext(member);
      // The windowed daily view is what 1D replaces.
      await expect(member.getByTestId("body-tile-systolic")).toBeVisible();

      await followLink(
        member,
        member.getByRole("link", { name: "1D", exact: true }),
        /from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/
      );

      await expect(member.getByTestId("vitals-intraday-hr")).not.toBeVisible();
      await expect(member.getByTestId("vitals-intraday-bp")).not.toBeVisible();
      await expect(
        member.getByTestId("vitals-intraday-spo2")
      ).not.toBeVisible();
      await expect(member.getByTestId("body-metric-tiles")).toBeVisible();
      await expect(
        member
          .getByTestId("trends-overview")
          .locator('[data-testid="chart-card-plot"]:visible')
      ).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });
});

test.describe("the retired Today strip (#3387)", () => {
  test("renders no duplicate snapshot and keeps the Timeline day link at the Body head", async ({
    browser,
  }) => {
    test.slow();
    const member = await vitalsDayPage(browser);
    try {
      await member.goto("/trends");
      await expect(member.getByTestId("vitals-today-strip")).toHaveCount(0);
      const link = member.getByTestId("body-timeline-link");
      await expect(link).toBeVisible();
      await expect(link).toHaveText("View today on Timeline");

      const day = await todayFromBodyLink(member);
      await followLink(member, link, new RegExp(`/history\\?day=${day}`));

      // The retired card's destination remains reachable from the Body section.
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
