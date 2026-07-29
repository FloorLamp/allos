import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { censusRevealed } from "./trends-chrome";
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
  // The census streams in (#1644): wait for its section to hold it before the
  // unscoped card queries below.
  await censusRevealed(page, "body", "trends-body");
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

    // The growth card LEADS the flat stack — the retired planBodyCharts
    // `growthCardFirst` fork, now a consequence of the life-stage signal alone
    // (#1674 retired `growthCardLeads` with the boxes: the card leads because it
    // ranks first, not because a predicate floated it).
    expect(
      await domOrder(page, [
        "growth-charts-card",
        "body-chart-height",
        "body-chart-weight",
        "vitals-systolic",
      ])
    ).toEqual([
      "growth-charts-card",
      // …and height leads weight for a growing child, with the clinical cards
      // trailing both — one stack, one order, no run to lift.
      "body-chart-height",
      "body-chart-weight",
      "vitals-systolic",
    ]);

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

    // The promoted CARD leads — nothing lifts a box around it any more (#1674).
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
    // composition, then daily activity and the heart-rate family, then the daily
    // subjective/environment cards, then the clinical vitals, then the synced tail.
    // This is the "ranked default == the base layout" proof, and since #1659 it is
    // also the proof that a both-rich tie no longer leads with clinical vitals.
    //
    // #1674 is what makes the last clause OBSERVABLE at last: with the titled boxes
    // gone, `steps` is ranked against the clinical cards instead of sitting in a
    // block structurally below them, so it renders above SpO₂ and BP — the exact
    // case reported on that issue.
    expect(
      await domOrder(page, [
        "vitals-systolic",
        "vitals-diastolic",
        "vitals-spo2",
        "vitals-hrv",
        "body-chart-weight",
        "steps",
      ])
    ).toEqual([
      "body-chart-weight",
      "steps",
      "vitals-hrv",
      "vitals-systolic",
      "vitals-diastolic",
      "vitals-spo2",
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
