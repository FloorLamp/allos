import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { chartsSettled } from "./helpers";

const PHONE = { width: 390, height: 844 };

// The harness's three ABSENCE cards and the sentence each one renders (#2399).
// Shared by both tests here so neither can measure a roster the other does not.
const emptyCards = [
  ["ordinary-empty-card", "No data yet"],
  ["no-overlap-empty-card", "No overlapping data in this range"],
  ["no-paired-empty-card", "No paired data yet"],
] as const;

function plot(card: Locator): Locator {
  return card.getByTestId("chart-card-plot");
}

async function expectSquareFootprint(card: Locator) {
  const box = await plot(card).boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box!.width - box!.height)).toBeLessThanOrEqual(1);
  return box!;
}

test("chart absences release the 390px plot footprint while chart states retain it", async ({
  page,
}: {
  page: Page;
}) => {
  await page.setViewportSize(PHONE);
  await page.goto("/e2e-fixtures/chart-empty");

  for (const [testid, message] of emptyCards) {
    const card = page.getByTestId(testid);
    const empty = plot(card).locator(":scope > [data-empty-state]");
    await expect(empty).toHaveText(message);
    const box = await plot(card).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThan(box!.width / 2);
  }

  const populated = page.getByTestId("populated-card");
  await expect(plot(populated).getByRole("application")).toBeVisible();
  await expectSquareFootprint(populated);

  const loading = page.getByTestId("loading-card");
  await expect(loading.getByText("Loading chart…")).toBeAttached();
  await expectSquareFootprint(loading);

  const error = page.getByTestId("error-card");
  await expect(error.getByText(/Chart unavailable/)).toBeVisible();
  await expectSquareFootprint(error);
});

// ── AND THE SQUARE IS FILLED, NOT MERELY RESERVED (#3574) ────────────────────
//
// The assertions above measure the PLOT BOX. That is half the contract, and the
// half that cannot see the defect this block exists for: a card can reserve a
// perfect 324x324 phone square and render a 256px chart inside it, leaving a band
// of empty card under the x-axis on every phone view. `expectSquareFootprint`
// passes on that all day.
//
// The mechanism, measured 2026-08-26 at 390px on `/trends/metric/weight`:
// `.chart-card-plot > *` in app/globals.css sets `height: 100%` on the plot's
// direct child — but `*` is the universal selector and contributes NOTHING to
// specificity, so the rule was (0,1,0), exactly tied with `.h-64`, and Tailwind
// emitted `.h-64` last. Every chart whose child kept the default height lost the
// tie: the chart itself, and `ChartLoading` / `ChartUnavailable`, which default to
// `h-64` too. The selector is `& > *:not([data-empty-state])` now — (0,2,0) — and
// this is the reading that says so.
//
// READ AS A DELTA IN PIXELS, never as a class list: #3466 shipped a green
// computed-style guard over a wrong render on this very kind of question.
const FILL_TOLERANCE_PX = 1;

/**
 * Every `chart-card-plot` on the page, with the height its direct child actually
 * rendered at. The child is the unit because that is exactly what the card's rule
 * reaches — a card that puts a wrapper in between passes `CHART_PLOT_FILL` down
 * instead, and then the wrapper is the child this reads.
 */
async function plotFills(page: Page) {
  return page.evaluate(() => {
    const out: {
      testid: string;
      plotHeight: number;
      childHeight: number;
      empty: boolean;
      childClass: string;
    }[] = [];
    for (const plot of Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="chart-card-plot"]')
    )) {
      const child = plot.firstElementChild as HTMLElement | null;
      if (!child) continue;
      const card = plot.closest<HTMLElement>(
        "[data-testid]:not([data-testid='chart-card-plot'])"
      );
      out.push({
        testid: card?.dataset.testid ?? "(unnamed card)",
        plotHeight: plot.getBoundingClientRect().height,
        childHeight: child.getBoundingClientRect().height,
        empty: child.hasAttribute("data-empty-state"),
        childClass: String(child.className).slice(0, 60),
      });
    }
    return out;
  });
}

function expectFilled(
  rows: Awaited<ReturnType<typeof plotFills>>,
  where: string
) {
  expect(
    rows.length,
    `${where}: no chart card plots were measured, so this verdict is about nothing`
  ).toBeGreaterThan(0);
  const dead = rows
    .filter((r) => !r.empty)
    .filter((r) => r.plotHeight - r.childHeight > FILL_TOLERANCE_PX)
    .map(
      (r) =>
        `${r.testid}: ${Math.round(r.plotHeight)}px plot holding a ` +
        `${Math.round(r.childHeight)}px child (${Math.round(r.plotHeight - r.childHeight)}px ` +
        `of dead card) — child class "${r.childClass}"`
    );
  expect(dead, `${where}\n${dead.join("\n")}`).toEqual([]);
}

test("every phone chart square is FILLED by its child, in every chart state (#3574)", async ({
  page,
}: {
  page: Page;
}) => {
  await page.setViewportSize(PHONE);
  await page.goto("/e2e-fixtures/chart-empty");

  // WAIT FOR THE CHART, NOT THE CARD (#3384). A plot measured before its lazy
  // chunk evaluates holds a loading box, and this is an ABSENCE assertion — the
  // direction an unrendered page flatters. The populated card is the one that
  // proves the chunk landed; the harness's loading and error cards are supposed
  // to keep their fallbacks, so they are not waited on.
  // Scoped to the populated card, not the page: this harness renders a loading
  // card and an error card ON PURPOSE, and a page-wide sweep for "Loading chart"
  // would be waiting for a fallback that is supposed to stay.
  const populatedCard = page.getByTestId("populated-card");
  await chartsSettled(populatedCard, populatedCard);
  await expect(
    page.getByTestId("loading-card").getByText("Loading chart…")
  ).toBeAttached();
  await expect(
    page.getByTestId("error-card").getByText(/Chart unavailable/)
  ).toBeVisible();
  // …and the three absences, EACH ONE, before the roster below is read. Their
  // empty states arrive with their own lazy chunks: measured 2026-08-26, a run
  // that read the roster without this waited on nothing and came back with five
  // cards instead of six, because `no-paired-empty-card`'s plot had no child yet.
  // A missing card is silently DROPPED by a fill sweep, which is the absence
  // direction an unrendered page flatters.
  for (const [testid, message] of emptyCards) {
    await expect(
      page
        .getByTestId(testid)
        .getByTestId("chart-card-plot")
        .locator(":scope > [data-empty-state]")
    ).toHaveText(message);
  }

  const rows = await plotFills(page);
  // The harness is the whole tenant vocabulary in one place: three absences, a
  // populated chart, the lazy loading fallback, and the offline/error fallback.
  expect(rows.map((r) => r.testid).sort()).toEqual([
    "error-card",
    "loading-card",
    "no-overlap-empty-card",
    "no-paired-empty-card",
    "ordinary-empty-card",
    "populated-card",
  ]);
  // An ABSENCE is not a plot (#2399) — the three empty cards must NOT fill, and
  // saying so here is what keeps the fill rule from swallowing that exception.
  for (const row of rows.filter((r) => r.empty)) {
    expect(
      row.plotHeight,
      `${row.testid} reserved a full plot for an empty state`
    ).toBeLessThan(row.childHeight * 2);
  }
  expectFilled(rows, "/e2e-fixtures/chart-empty at 390px");
});

// THE TENANT SWEEP — #3574's audit, mechanised instead of written down once.
//
// The harness above is the STATE vocabulary; this is the CALL-SITE one. Every
// route in the tree that mounts a `ChartCard` with data behind it, measured at
// phone width, so "every ChartCard tenant either fills the phone square or the
// square is released for it deliberately" is a reading rather than a claim in a
// PR body. Derived 2026-08-26 from `git grep -l ChartCard app components`: the
// eight importers are BodySection, NutritionSection, TrendMetricCharts,
// FitnessZonesSection, TrainingZonesSection, GrowthChartsCard, PracticeTrends and
// this file's own harness.
//
// `/trends` (BodySection) is NOT here and the reason is the one that matters: at
// 390px its cards sit inside collapsed disclosures, so every plot measures 0x0 —
// a route that would pass this sweep by having nothing in it. It is covered on
// desktop by its own specs and by the `CHART_PLOT_FILL` it already passes.
// GrowthChartsCard needs a child profile the shared fixture does not act as.
const TENANT_ROUTES = [
  {
    path: "/trends/metric/weight",
    why: "TrendMetricCharts — the mount #3574 was reported on",
    card: "metric-detail-chart",
  },
  {
    path: "/trends?tab=nutrition",
    why: "NutritionSection's macros chart",
    card: "nutrition-macros-chart",
  },
  {
    path: "/training?tab=analyze",
    why: "TrainingZonesSection and FitnessZonesSection, two cards on one route",
    card: "fitness-cardio-volume",
  },
  {
    path: "/wellness",
    why: "PracticeTrends — the one tenant whose plotHeightClass is SHORTER than its child's default, so it is where a height rule that shrinks rather than floors would show up",
    card: "practice-cadence-card",
    // Its charts live behind the practice card's own disclosure, so the sweep
    // opens it the way a reader does (e2e/trends-practices.spec.ts, same shape).
    reveal: async (page: Page) => {
      const trends = page.getByTestId("wellness-practice-trends").first(); // first-ok: any practice with a trend block serves; the sweep then reads EVERY plot on the page
      await expect(trends).toBeVisible();
      await trends.locator("summary").click();
    },
  },
] as const;

for (const tenant of TENANT_ROUTES) {
  test(`${tenant.path} fills its phone chart squares (#3574)`, async ({
    page,
  }: {
    page: Page;
  }) => {
    test.slow(); // next start compiles each route on its first hit
    await page.setViewportSize(PHONE);
    await page.goto(tenant.path);
    if ("reveal" in tenant) await tenant.reveal(page);
    // WAIT FOR THE CHART, NOT THE CARD (#3384): a plot read before its lazy chunk
    // evaluates holds a loading box, and every assertion below is an ABSENCE.
    const card = page.getByTestId(tenant.card);
    await expect(card, tenant.why).toBeVisible();
    await chartsSettled(page, card);
    expectFilled(
      await plotFills(page),
      `${tenant.path} at 390px — ${tenant.why}`
    );
  });
}
