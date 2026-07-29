import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_TRENDS_RANK_PEDS,
  E2E_LOGIN_TRENDS_RANK_GOAL,
  E2E_LOGIN_TRENDS_RANK_PLAIN,
} from "./fixture-logins";

// Ranked DEFAULT chart-card order on Trends → Body (#1490), re-sequenced
// everyday-first by #1659.
//
// A profile whose ★-pinned set does not decide a card's slot gets an order from
// STABLE subject facts — life stage, live goals, monitored conditions, data
// presence — over the base layout. Nothing reshuffles live. The USER's half of the
// order (a ★ leads the stack) is e2e/trends-card-pin.spec.ts.
//
// #1659 changed what "the base layout" means here: it used to run the clinical
// vitals block first, so a wearable profile — for which SpO₂ is rich the moment
// steps is — led with SpO₂-class charts on a pure presence TIE. The base is now
// composition → daily activity → clinical, and the runs follow it: Composition leads
// Vitals whenever no signal says otherwise.
//
// Three dedicated read-only fixtures (#868), one per scenario:
//   PEDS  — ~6-year-old with heights → the growth-percentile card leads the stack.
//   GOAL  — adult with a LIVE weight goal → BMI, the goal's other card, climbs out
//           of the synced tail past the vitals.
//   PLAIN — the SAME data shape as GOAL, minus the goal → the static layout,
//           EXACTLY. The identity case is the regression guard: it fails the moment
//           a signal starts firing for a profile the app knows nothing about.
//
// GOAL and PLAIN are read against BMI rather than the Composition run: under the
// everyday-first base that run leads for BOTH, so a section-order assertion would no
// longer be a controlled contrast between them.

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
  await page.goto("/trends?view=all");
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

    // The separate percentile tiles occupy the same ranked `growth` slot rather
    // than being appended independently by the tile renderer.
    await page.goto("/trends?view=tiles");
    await expect(page.getByTestId("body-tile-growth-height")).toBeVisible();
    expect(
      await domOrder(page, ["body-tile-growth-height", "body-tile-height"])
    ).toEqual(["body-tile-growth-height", "body-tile-height"]);
  });

  test("an adult with a live weight goal lifts BMI out of the synced tail", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_RANK_GOAL,
      password: E2E_MEMBER_PASSWORD,
    });
    await openBodyStack(page);

    // The goal-tracked card's whole RUN leads: promoting `weight` inside a
    // Composition run pinned below Vitals would be an invisible promotion. (Under
    // #1659's base that run also leads for the PLAIN twin — see the note above.)
    expect(
      await domOrder(page, [
        "body-section-vitals",
        "body-section-body-composition",
      ])
    ).toEqual(["body-section-body-composition", "body-section-vitals"]);
    expect(
      await domOrder(page, ["body-chart-weight", "vitals-systolic"])
    ).toEqual(["body-chart-weight", "vitals-systolic"]);

    // BMI is the goal's OTHER card, and its base slot is the synced tail — behind
    // steps. The goal boost carries it to the front of that tail, which is the one
    // position only the goal can explain (the PLAIN twin below has it last).
    expect(await domOrder(page, ["bmi", "steps"])).toEqual(["bmi", "steps"]);

    // The tile grid reads the SAME order, so the two view modes can't disagree.
    await page.goto("/trends?view=tiles");
    await expect(page.getByTestId("body-metric-tiles")).toBeVisible();
    expect(
      await domOrder(page, [
        "body-tile-weight",
        "body-tile-bmi",
        "body-tile-steps",
        "body-tile-systolic",
      ])
    ).toEqual([
      "body-tile-weight",
      "body-tile-bmi",
      "body-tile-steps",
      "body-tile-systolic",
    ]);
  });

  test("a profile with no signals gets today's layout EXACTLY", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_RANK_PLAIN,
      password: E2E_MEMBER_PASSWORD,
    });
    await openBodyStack(page);

    // Same data shape as the GOAL fixture, minus the goal: an adult, no monitored
    // condition, evenly tracked. Every card falls back to the static layout —
    // composition first, then the vitals run in its declared sequence, then the
    // synced charts. This is the "ranked default == the base layout" proof, and
    // since #1659 it is also the proof that a both-rich tie no longer leads with
    // clinical vitals: `steps` precedes every BP card.
    expect(
      await domOrder(page, [
        "body-section-vitals",
        "body-section-body-composition",
      ])
    ).toEqual(["body-section-body-composition", "body-section-vitals"]);

    expect(
      await domOrder(page, [
        "vitals-systolic",
        "vitals-diastolic",
        "vitals-hrv",
        "body-chart-weight",
        "steps",
      ])
    ).toEqual([
      "body-chart-weight",
      "vitals-hrv",
      "vitals-systolic",
      "vitals-diastolic",
      "steps",
    ]);

    // Without the goal, BMI stays where the base layout puts it: the synced tail,
    // behind steps. This is the controlled half of the GOAL assertion above.
    expect(await domOrder(page, ["bmi", "steps"])).toEqual(["steps", "bmi"]);

    await page.goto("/trends?view=tiles");
    await expect(page.getByTestId("body-metric-tiles")).toBeVisible();
    expect(
      await domOrder(page, [
        "body-tile-weight",
        "body-tile-steps",
        "body-tile-systolic",
        "body-tile-bmi",
      ])
    ).toEqual([
      "body-tile-weight",
      "body-tile-steps",
      "body-tile-systolic",
      "body-tile-bmi",
    ]);

    // No growth card for an adult, and nothing pediatric leaked in.
    await expect(page.getByTestId("growth-charts-card")).toHaveCount(0);
  });
});
