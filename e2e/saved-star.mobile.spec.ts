import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import { settledClick, settledPickOption } from "./helpers";

// The unified save gesture (#1456) end-to-end: ONE star, membership everywhere.
//
// Before this, a biomarker you cared about needed TWO gestures on two surfaces — the
// ★ on its detail page (status card + passport summary) and a separate PIN on Trends
// (the only way it earned a chart tile). Both stores are now one `saved_items` table,
// so the assertion that matters is a NEGATIVE one no other tier can make: after
// starring on the detail page, the Trends Overview chart tile is there with NO second
// gesture in between.
//
// #1487 extended that to metrics: Overview renders the saved set and NOTHING
// unconditionally, so the four standard tiles are saved rows too (seeded at profile
// creation / by migration 114). The second test below is what changed — it used to
// assert "a metric save is promotion, every metric tile renders either way", the
// premise #1487 deleted. It now asserts membership; the REMOVAL half is proven on a
// dedicated fixture in trends-overview-curated.mobile.spec.ts, since unstarring a
// shared-seed tile here would reorder the grid every other Trends spec reads.
//
// Runs in the `mobile` project (390×844, #1420) by its file name alone.
//
// Fixture (#868 hygiene): CREATE-AND-CLEAN on the shared seed. It stars an analyte the
// seed deliberately leaves UNSAVED (the seeded saves are LDL Cholesterol, ApoB, hs-CRP,
// Lipoprotein(a) + the weight metric and the four standard metric seeds) and un-stars
// it again through the tile's own control, restoring the seed state — so the spec is
// repeat-safe under `--repeat-each` and perturbs no neighbour. No exact count of a
// shared-seed row is asserted.

// A seeded biomarker WITH readings that the seed does not star.
const ANALYTE = "HDL Cholesterol";
const DETAIL_URL = `/results/readings/view?name=${encodeURIComponent(ANALYTE)}`;

// A tile's controls live in its corner ⋯ menu since #1485 B, and the panel is
// PORTALED to <body> — so it is located on the page, never inside the card.
async function tileMenu(page: Page, tile: Locator): Promise<Locator> {
  await tile.getByTestId("overflow-menu-trigger").click();
  const menu = page.getByTestId("trend-tile-menu");
  await expect(menu).toBeVisible();
  return menu;
}

test("starring a biomarker gives it a Trends chart tile with no second gesture", async ({
  page,
}) => {
  // 1. Its detail page: unstarred, and no tile on Trends yet.
  await page.goto("/trends");
  const tile = page.getByTestId("trend-mini-card").filter({ hasText: ANALYTE });
  await expect(tile).toHaveCount(0);

  await page.goto(DETAIL_URL);
  const star = page.getByTestId("star-toggle");
  await expect(star).toHaveAttribute("aria-pressed", "false");

  // 2. ONE gesture.
  await settledClick(page, star);
  await expect(star).toHaveAttribute("aria-pressed", "true");

  // 3. The chart tile is on Trends — nothing else was clicked. This is the whole
  // issue: the pin gesture that used to be required here is gone.
  await page.goto("/trends");
  const savedRow = page.getByTestId("saved-tiles");
  await expect(savedRow).toBeVisible();
  await expect(savedRow.getByText(ANALYTE, { exact: true })).toBeVisible();
  const savedTile = savedRow
    .getByTestId("trend-mini-card")
    .filter({ hasText: ANALYTE });

  // This fixture has one HDL reading in the default 90-day window. A one-point
  // line has no slope, so the card uses the deliberate single-reading marker
  // instead of an invisible sparkline plus duplicate Low/High values.
  const singleReading = savedTile.getByTestId("trend-mini-single-reading");
  await expect(singleReading).toBeVisible();
  const singleMarker = singleReading.getByTestId("trend-mini-single-marker");
  await expect(singleMarker).toBeVisible();
  const singleMarkerBox = await singleMarker.boundingBox();
  expect(singleMarkerBox).not.toBeNull();
  expect(singleMarkerBox!.height).toBeGreaterThanOrEqual(80);
  await expect(singleReading).toHaveAttribute("data-reading-scope", "inside");
  await expect(singleReading).toContainText("Single reading ·");
  const insideDate = singleReading.locator("time");
  await expect(insideDate).toBeVisible();
  await expect(insideDate).toHaveAttribute("datetime", /\d{4}-\d{2}-\d{2}/);
  await expect(savedTile.getByTestId("trend-mini-range")).toHaveCount(0);
  const singleReadingTileBox = await savedTile.boundingBox();
  expect(singleReadingTileBox).not.toBeNull();
  const rowPeerBoxes = await savedRow
    .getByTestId("trend-mini-card")
    .evaluateAll(
      (cards, targetY) =>
        cards
          .map((card) => card.getBoundingClientRect())
          .filter((box) => Math.abs(box.y - Number(targetY)) < 2)
          .map((box) => ({ height: box.height })),
      singleReadingTileBox!.y
    );
  expect(rowPeerBoxes).toHaveLength(2);
  expect(
    Math.abs(singleReadingTileBox!.height - rowPeerBoxes[0].height) +
      Math.abs(singleReadingTileBox!.height - rowPeerBoxes[1].height)
  ).toBeLessThan(2);

  // The stale-value caption occupies the same footer line as a plotted card's
  // Low/High values, even when the cards happen to sit in different grid rows.
  const outsideCard = savedRow
    .getByTestId("trend-mini-card")
    .filter({ hasText: "E2E APOE Genotype" });
  const plottedCard = savedRow
    .getByTestId("trend-mini-card")
    .filter({ hasText: "Weight" });
  const [outsideBox, latestCaptionBox, plottedBox, rangeBox] =
    await Promise.all([
      outsideCard.boundingBox(),
      outsideCard.getByText(/Latest recorded ·/).boundingBox(),
      plottedCard.boundingBox(),
      plottedCard.getByTestId("trend-mini-range").boundingBox(),
    ]);
  expect(outsideBox).not.toBeNull();
  expect(latestCaptionBox).not.toBeNull();
  expect(plottedBox).not.toBeNull();
  expect(rangeBox).not.toBeNull();
  const latestBottomGap =
    outsideBox!.y +
    outsideBox!.height -
    (latestCaptionBox!.y + latestCaptionBox!.height);
  const rangeBottomGap =
    plottedBox!.y + plottedBox!.height - (rangeBox!.y + rangeBox!.height);
  expect(Math.abs(latestBottomGap - rangeBottomGap)).toBeLessThan(2);
  const [latestTypography, rangeTypography] = await Promise.all([
    outsideCard.getByText(/Latest recorded ·/).evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        color: style.color,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        fontVariantNumeric: style.fontVariantNumeric,
      };
    }),
    plottedCard.getByTestId("trend-mini-range").evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        color: style.color,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        fontVariantNumeric: style.fontVariantNumeric,
      };
    }),
  ]);
  expect(latestTypography).toEqual(rangeTypography);
  const outsideDate = outsideCard.locator("time");
  await expect(outsideDate).toBeVisible();
  await expect(outsideDate).toHaveAttribute("datetime", /\d{4}-\d{2}-\d{2}/);

  // …and the SAME star, now in the tile's ⋯ menu, un-stars it (one gesture both ways).
  const menu = await tileMenu(page, savedTile);
  const tileStar = menu.getByTestId("star-toggle");
  await expect(tileStar).toHaveAttribute("aria-checked", "true");
  await settledClick(page, tileStar);

  // Cleanup is the assertion: the tile is gone, the seed state is restored.
  await expect(
    page.getByTestId("trend-mini-card").filter({ hasText: ANALYTE })
  ).toHaveCount(0);
  await page.goto(DETAIL_URL);
  await expect(page.getByTestId("star-toggle")).toHaveAttribute(
    "aria-pressed",
    "false"
  );
});

test("starring a metric detail page adds that chart to Overview", async ({
  page,
}) => {
  // Steps is deliberately outside the legacy standard saved-metric set. This
  // proves detail-page stars work for the whole TREND_METRIC_META registry, not
  // only Weight / Body Fat / Resting Heart Rate.
  await page.goto("/trends/metric/steps");
  const star = page.getByTestId("star-toggle");
  await expect(star).toHaveAttribute("aria-pressed", "false");

  await settledClick(page, star);
  await expect(star).toHaveAttribute("aria-pressed", "true");

  await page.goto("/trends");
  const tile = page
    .getByTestId("saved-tiles")
    .getByTestId("trend-mini-card")
    .filter({ hasText: "Daily Steps" });
  await expect(tile).toHaveCount(1);
  await expect(tile.getByRole("link", { name: "Steps" })).toHaveAttribute(
    "href",
    "/trends/metric/steps"
  );

  // Create-and-clean: the same star in the saved tile removes the new row.
  const menu = await tileMenu(page, tile);
  await settledClick(page, menu.getByTestId("star-toggle"));
  await expect(tile).toHaveCount(0);

  await page.goto("/trends/metric/steps");
  await expect(page.getByTestId("star-toggle")).toHaveAttribute(
    "aria-pressed",
    "false"
  );
});

test("the standard metric tiles are saved rows, not a hardcoded sampler", async ({
  page,
}) => {
  // #1487: every tile on Overview is a SAVED tile. The standard metrics render
  // because they are seeded saves — so they all sit inside the saved row, nothing
  // renders outside it, and each carries the unstar + reorder controls any other
  // saved tile has.
  await page.goto("/trends");
  const savedRow = page.getByTestId("saved-tiles");
  await expect(savedRow).toBeVisible();

  const weight = savedRow
    .getByTestId("trend-mini-card")
    .filter({ hasText: "Weight" });
  await expect(weight).toHaveCount(1);
  // No unsaved grid any more: every tile on the page is inside the saved row.
  expect(await page.getByTestId("trend-mini-card").count()).toBe(
    await savedRow.getByTestId("trend-mini-card").count()
  );

  // The seed positions the weight metric first, and the reorder affordance (now the
  // menu's non-pointer fallback) is disabled at the top of the list — an end move is
  // a no-op, so it isn't offered.
  const menu = await tileMenu(page, weight);
  await expect(menu.getByTestId("star-toggle")).toBeVisible();
  await expect(menu.getByTestId("saved-move-up")).toBeDisabled();
});

test("the picker stars a biomarker straight from Trends", async ({ page }) => {
  // The old "Pin a biomarker" entry point now writes a SAVE — same store, same
  // gesture as the ★ anywhere else, and since #1487 it offers metrics too (the way
  // back after unstarring one). Create-and-clean: it stars an analyte the seed
  // leaves unsaved, then un-stars it from the tile.
  const ANALYTE_2 = "Triglycerides";
  await page.goto("/trends");
  await page.getByTestId("save-trend-picker-toggle").click();
  const picker = page.getByTestId("save-trend-picker");
  await expect(picker).toBeVisible();

  // settledPickOption, not a raw click: the picker is the shared Combobox since
  // #1675, and since #1644 the hub is one long streamed page, so hydration lands late
  // and a value set before React attaches would be reverted under the Star click.
  await settledPickOption(
    page,
    picker.locator('input[role="combobox"]'),
    ANALYTE_2
  );
  await settledClick(page, picker.getByRole("button", { name: "Star" }));

  const tile = page
    .getByTestId("trend-mini-card")
    .filter({ hasText: ANALYTE_2 });
  await expect(tile).toHaveCount(1);

  const menu = await tileMenu(page, tile);
  await settledClick(page, menu.getByTestId("star-toggle"));
  // The unstar's revalidation re-renders the WHOLE hub — head plus four streamed
  // censuses (#1644) — before the tile can leave the grid, so this settles later
  // than the default 5s allows on a loaded machine. A named ceiling, not a sleep:
  // the assertion still fails if the tile never goes.
  await expect(
    page.getByTestId("trend-mini-card").filter({ hasText: ANALYTE_2 })
  ).toHaveCount(0, { timeout: 20_000 });
});
