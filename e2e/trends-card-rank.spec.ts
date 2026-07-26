import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_TRENDS_RANK_PEDS,
  E2E_LOGIN_TRENDS_RANK_GOAL,
  E2E_LOGIN_TRENDS_RANK_PLAIN,
} from "./fixture-logins";

// Ranked DEFAULT chart-card order on Trends → Body (#1490).
//
// A profile that has never arranged the tab gets an order decided from STABLE
// subject facts — life stage, live goals, monitored conditions, data presence.
// Nothing reshuffles live, and an arranged tab is never re-ranked at all (that half
// is pinned at the action tier, lib/__action_tests__/trends-card-order.actions.test.ts,
// since the drag affordance that writes an arrangement is #1485-C's extension).
//
// Three dedicated read-only fixtures (#868), one per scenario:
//   PEDS  — ~6-year-old with heights → the growth-percentile card leads the stack.
//   GOAL  — adult with a LIVE weight goal → Composition (and weight) leads Vitals.
//   PLAIN — the SAME data shape as GOAL, minus the goal → the static layout,
//           EXACTLY. The identity case is the regression guard: it fails the moment
//           a signal starts firing for a profile the app knows nothing about.

// Read the DOM order of a set of cards, keeping only the ones present. Document
// order IS the assertion here, so this compares positions rather than counting
// anything a neighbour could change. Cards are named by testid, except the synced
// daily charts, which carry a stable in-page anchor id instead (`#steps`).
async function domOrder(page: Page, names: string[]): Promise<string[]> {
  return page.evaluate((ids) => {
    const found = ids
      .map((id) => ({
        id,
        el:
          document.querySelector(`[data-testid="${id}"]`) ??
          document.getElementById(id),
      }))
      .filter((e): e is { id: string; el: Element } => e.el != null);
    found.sort((a, b) =>
      a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1
    );
    return found.map((e) => e.id);
  }, names);
}

async function openBodyStack(page: Page): Promise<void> {
  // `view=all` is the classic chart stack — the layout whose sequence this issue
  // decides (the tile grid reads the same order, asserted below).
  await page.goto("/trends?tab=body&view=all");
  await expect(page.getByTestId("trends-body")).toBeVisible();
}

test.describe("Trends → Body ranked default card order (#1490)", () => {
  test("a pediatric profile leads with the growth-percentile card", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_RANK_PEDS,
      password: E2E_MEMBER_PASSWORD,
    });
    await openBodyStack(page);

    const growth = page.getByTestId("growth-charts-card");
    await expect(growth).toBeVisible();

    // The growth card sits ABOVE the chart runs — the retired planBodyCharts
    // `growthCardFirst` fork, now a consequence of the life-stage signal. The
    // Composition run follows it, ahead of Vitals, because height (the priority
    // datapoint for a growing child) lives there: the same life-stage signal
    // carries the card AND its run, so the promotion is actually visible.
    expect(
      await domOrder(page, [
        "growth-charts-card",
        "body-section-vitals",
        "body-section-body-composition",
      ])
    ).toEqual([
      "growth-charts-card",
      "body-section-body-composition",
      "body-section-vitals",
    ]);

    // …and inside the composition run, height leads weight for a growing child.
    expect(
      await domOrder(page, ["body-chart-height", "body-chart-weight"])
    ).toEqual(["body-chart-height", "body-chart-weight"]);
  });

  test("an adult with a live weight goal leads with weight", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_RANK_GOAL,
      password: E2E_MEMBER_PASSWORD,
    });
    await openBodyStack(page);

    // The goal-tracked card's whole RUN leads: promoting `weight` inside a
    // Composition run pinned below Vitals would be an invisible promotion.
    expect(
      await domOrder(page, [
        "body-section-vitals",
        "body-section-body-composition",
      ])
    ).toEqual(["body-section-body-composition", "body-section-vitals"]);
    expect(
      await domOrder(page, ["body-chart-weight", "vitals-systolic"])
    ).toEqual(["body-chart-weight", "vitals-systolic"]);

    // The tile grid reads the SAME order, so the two view modes can't disagree.
    await page.goto("/trends?tab=body&view=tiles");
    await expect(page.getByTestId("body-metric-tiles")).toBeVisible();
    expect(
      await domOrder(page, ["body-tile-weight", "body-tile-systolic"])
    ).toEqual(["body-tile-weight", "body-tile-systolic"]);
  });

  test("a never-arranged profile with no signals gets today's layout EXACTLY", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_RANK_PLAIN,
      password: E2E_MEMBER_PASSWORD,
    });
    await openBodyStack(page);

    // Same data shape as the GOAL fixture, minus the goal: an adult, no monitored
    // condition, evenly tracked. Every card falls back to the static layout —
    // vitals run first in its declared sequence, then composition, then the synced
    // charts. This is the "ranked default == the layout you already had" proof.
    expect(
      await domOrder(page, [
        "body-section-vitals",
        "body-section-body-composition",
      ])
    ).toEqual(["body-section-vitals", "body-section-body-composition"]);

    expect(
      await domOrder(page, [
        "vitals-systolic",
        "vitals-diastolic",
        "vitals-hrv",
        "body-chart-weight",
        "steps",
      ])
    ).toEqual([
      "vitals-systolic",
      "vitals-diastolic",
      "vitals-hrv",
      "body-chart-weight",
      "steps",
    ]);

    // No growth card for an adult, and nothing pediatric leaked in.
    await expect(page.getByTestId("growth-charts-card")).toHaveCount(0);
  });
});
