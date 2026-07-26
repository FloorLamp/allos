import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import { settledClick } from "./helpers";

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
const DETAIL_URL = `/biomarkers/view?name=${encodeURIComponent(ANALYTE)}`;

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

  // …and the SAME star, now in the tile's ⋯ menu, un-stars it (one gesture both ways).
  const menu = await tileMenu(
    page,
    savedRow.getByTestId("trend-mini-card").filter({ hasText: ANALYTE })
  );
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
  const picker = page.getByTestId("save-trend-picker");
  await expect(picker).toBeVisible();

  await picker.getByRole("combobox").selectOption(`bio:${ANALYTE_2}`);
  await settledClick(page, picker.getByRole("button", { name: "Star" }));

  const tile = page
    .getByTestId("trend-mini-card")
    .filter({ hasText: ANALYTE_2 });
  await expect(tile).toHaveCount(1);

  const menu = await tileMenu(page, tile);
  await settledClick(page, menu.getByTestId("star-toggle"));
  await expect(
    page.getByTestId("trend-mini-card").filter({ hasText: ANALYTE_2 })
  ).toHaveCount(0);
});
