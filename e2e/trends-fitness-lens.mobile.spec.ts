import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { expandTrendsContext } from "./trends-chrome";
import { expectNoClippedContent, followLink } from "./helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_TRENDS_FITNESS,
  TRENDS_FITNESS_LIFT,
  TRENDS_FITNESS_OLD_LIFT,
} from "./fixture-logins";

// #1492 — Trends → Fitness became the WINDOWED ANALYTICS LENS.
//
// The audit measured this tab worse than anything else on the page: the first
// chart sat at 1,776px (Strength) / 2,031px (Cardio) on a 390×844 phone, behind a
// 12-month heatmap and a 14-row PR list, under a NESTED `?ftab=` tab strip, and
// none of it honored the hub's shared range. So the four things this spec pins are
// exactly the four things that were wrong:
//
//   1. a range change RE-WINDOWS every chart (the tab is not full-history any more)
//   2. NO nested tab strip renders (sections, not tabs-in-tabs)
//   3. the first chart is inside the first viewport-height at the 90D default
//   4. the PR block is 3 rows + a "show all" link into /training
//
// …plus the compatibility clause: an old `?tab=fitness&ftab=cardio` deep link (the
// coaching engine's zone nudge shipped one for months) still lands on Fitness.
//
// Fixture (#868 hygiene): a dedicated read-only member/profile whose training data
// STRADDLES the 90-day window — recent sessions inside it, a deep-past block
// (2026-01-*) only reachable at All time. Without a straddling fixture "the range
// re-windows the charts" can't be observed, only asserted. Read-only: the spec
// navigates and taps range pills, so --repeat-each stays clean.

// The range pills are links; match EXACTLY (a bare "90D" also substring-matches the
// movers digest's "… over 90d" chips on other tabs — the #1485 G note).
const rangePill = (page: Page, label: string) =>
  page.getByRole("link", { name: label, exact: true });

async function openFitness(page: Page): Promise<void> {
  await page.goto("/trends#fitness");
  // The chip strip AND the range pills collapse into the #1485 F context bar at
  // phone width; every assertion below reads one or the other, so open it once.
  await expandTrendsContext(page);
  await expect(page.getByTestId("trends-section-fitness")).toBeVisible();
  await expect(page.getByTestId("trends-fitness")).toBeVisible();
}

async function signIn(browser: Parameters<typeof loginAs>[0]): Promise<Page> {
  return loginAs(browser, {
    username: E2E_LOGIN_TRENDS_FITNESS,
    password: E2E_MEMBER_PASSWORD,
  });
}

test.describe("Trends → Fitness, the windowed lens (#1492)", () => {
  test("the four sections render and no nested tab strip does", async ({
    browser,
  }) => {
    const page = await signIn(browser);
    await openFitness(page);

    // Exactly the four PINNED sections (owner-decided composition).
    await expect(page.getByTestId("fitness-volume")).toBeVisible();
    await expect(page.getByTestId("fitness-zones")).toBeVisible();
    await expect(page.getByTestId("fitness-strength")).toBeVisible();
    await expect(page.getByTestId("fitness-sport")).toBeVisible();

    // The nested Strength|Cardio|Sport strip is GONE, and since #1644 there is no
    // tab level above it either — the navigation is plain in-page anchors all the
    // way down, so no tab by those names (or any name) exists.
    for (const name of ["Strength", "Cardio", "Sport"]) {
      await expect(page.getByRole("tab", { name, exact: true })).toHaveCount(0);
    }
    // Four consecutive headed subsections do not need a navigation layer of their
    // own on phones: the page's chips are the only strip, and the long-page
    // shortcut inside the census is a desktop-only dropdown.
    await expect(page.getByTestId("chart-jump-chips")).toHaveCount(0);
    await expect(page.getByTestId("chart-jump-menu")).not.toBeVisible();

    // The old un-windowed content is gone with its apology: the tab used to say
    // "Strength, cardio, and sport progress (full history)" beside a "Full
    // Training →" link, on a hub promising one shared date range.
    await expect(page.getByText("(full history)")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Full Training/ })).toHaveCount(
      0
    );

    await page.close();
  });

  test("the first chart is inside the first viewport-height at the 90D default", async ({
    browser,
  }) => {
    const page = await signIn(browser);
    await openFitness(page);

    // No ?from/?to → the hub's 90D default (#1485 G), which is the state the audit
    // measured. The first chart is the volume section's, and it must be reachable
    // without scrolling past a pre-chart wall.
    const firstChart = page
      .getByTestId("fitness-volume")
      .locator(".card")
      .first(); // first-ok: the volume card IS the section's first card — the measurement's subject
    const box = await firstChart.boundingBox();
    expect(box).not.toBeNull();
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    // The card's TOP inside the first screen (the audit's 1,776px → under 844px).
    expect(box!.y).toBeLessThan(viewport!.height);

    // And nothing is pushed past the right edge at 390px — measured per element
    // (#1543), since the app shell clips the overflow a page-level width
    // comparison would look for.
    await expectNoClippedContent(page);

    await page.close();
  });

  test("the PR block shows three rows and links the rest to /training", async ({
    browser,
  }) => {
    const page = await signIn(browser);
    await openFitness(page);

    const prs = page.getByTestId("fitness-window-prs");
    await expect(prs).toBeVisible();
    await expect(prs).toContainText("PRs this window");
    // The compact movers treatment: at most three rows, never the 14-row list.
    const rows = prs.getByRole("listitem");
    expect(await rows.count()).toBeLessThanOrEqual(3);
    expect(await rows.count()).toBeGreaterThan(0);

    // "Show all" leaves the lens for the do-surface.
    const showAll = prs.getByTestId("fitness-prs-show-all");
    await expect(showAll).toBeVisible();
    await expect(showAll).toHaveAttribute("href", /\/training/);

    await page.close();
  });

  test("a range change re-windows every chart", async ({ browser }) => {
    const page = await signIn(browser);
    await openFitness(page);

    // ── At the 90D default: only the in-window training shows. ────────────────
    const strength = page.getByTestId("fitness-strength");
    await expect(strength).toContainText(TRENDS_FITNESS_LIFT);
    // The deep-past lift (2026-01) is outside a 90-day window, so nothing on the
    // tab names it — not the est-1RM lead, not the movers list.
    await expect(strength).not.toContainText(TRENDS_FITNESS_OLD_LIFT);

    // The heatmap is scoped to the window too: ~13 week columns, not 12 months.
    // Its earliest drawn cell can precede the window by up to a week (the grid is
    // week-column aligned), never by months.
    const ninetyDayFirstCell = await page
      .getByTestId("workout-heatmap-section")
      .locator("[data-date]")
      .first() // first-ok: the grid's oldest cell — the measurement's subject, order is the grid's own
      .getAttribute("data-date");
    expect(ninetyDayFirstCell).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // The sport section counts only the window's matches.
    await expect(page.getByTestId("fitness-sport")).toContainText("2 sessions");

    // ── Switch to All time: the deep-past block appears everywhere. ───────────
    await followLink(page, rangePill(page, "All time"), /range=all/);
    await expect(page.getByTestId("trends-fitness")).toBeVisible();
    // The navigation re-renders the page with the bar collapsed again.
    await expandTrendsContext(page);

    // Strength: the old lift is now in the window, so it reaches the movers list.
    await expect(page.getByTestId("fitness-strength")).toContainText(
      TRENDS_FITNESS_OLD_LIFT
    );
    // Sport: the deep-past match joins the count.
    await expect(page.getByTestId("fitness-sport")).toContainText("3 sessions");
    // Cadence: the heatmap widened back to its 12-month cap, so its oldest cell is
    // strictly older than the 90-day grid's.
    const allTimeFirstCell = await page
      .getByTestId("workout-heatmap-section")
      .locator("[data-date]")
      .first() // first-ok: same subject as above — the grid's oldest cell
      .getAttribute("data-date");
    expect(allTimeFirstCell! < ninetyDayFirstCell!).toBe(true);

    // ── And back to 90D: the window closes again (not a one-way widening). ────
    await followLink(page, rangePill(page, "90D"), /from=/);
    await expandTrendsContext(page);
    await expect(page.getByTestId("fitness-strength")).not.toContainText(
      TRENDS_FITNESS_OLD_LIFT
    );
    await expect(page.getByTestId("fitness-sport")).toContainText("2 sessions");

    await page.close();
  });

  test("an old ?ftab= deep link still reaches the zone content", async ({
    browser,
  }) => {
    const page = await signIn(browser);

    // The retired nested vocabulary (#1492), now on a page whose OUTER strip is
    // retired too (#1644): the param names nothing and is ignored — no redirect,
    // no 404 — and the zone content it wanted is simply a subsection of the census
    // on the page it lands on.
    await page.goto("/trends?ftab=cardio");
    await expandTrendsContext(page);
    await expect(page.getByTestId("fitness-zones")).toBeVisible();
    await expect(page.getByTestId("training-zones")).toBeVisible();
    // The URL is left exactly as the old link wrote it (ignored, not rewritten).
    await expect(page).toHaveURL(/ftab=cardio/);

    // And its `#zones` anchor — the one the coaching engine links — resolves.
    await page.goto("/trends#zones");
    await expect(page.locator("#zones")).toBeInViewport();

    await page.goto("/trends?ftab=sport");
    await expandTrendsContext(page);
    await expect(page.getByTestId("fitness-sport")).toBeVisible();

    await page.close();
  });
});
