import { test, expect } from "./fixtures";
import type { Locator } from "@playwright/test";
import { expectNoClippedContent, hydratedClick, settledBoxes } from "./helpers";

// Content clipped inside its own container at 390px (issue #2614).
//
// Four independent surfaces, one shared rule: wide content scrolls inside its own
// container or REFLOWS — it never sits past an edge with no way to it, and the
// page never scrolls sideways to compensate. The existing `expectNoClippedContent`
// guard cannot see any of these, by design: it tolerates anything inside a working
// scroller, and each of these was inside one. So the assertions here are about the
// content's own box against the box that holds it, which is the thing a reader
// experiences and a screenshot only hints at.
//
// Fixture (#868 hygiene): READ-ONLY over the shared seed. Nothing is written, no
// seeded row is exact-counted, and no assertion names a specific analyte or date.

// The right edge of `locator` against the right edge of the box that contains it,
// with the container NOT scrolled. Positive means the content hangs past the edge.
async function overhangWithin(inner: Locator, outer: Locator): Promise<number> {
  // `settledBoxes` and not two `boundingBox()` reads: a relative assertion built
  // from independent round-trips can describe a layout that never existed.
  const [innerBox, outerBox] = await settledBoxes([inner, outer]);
  return innerBox.x + innerBox.width - (outerBox.x + outerBox.width);
}

// How far a scroll container could be scrolled sideways. Zero means everything it
// holds is laid out inside it.
async function scrollableBy(locator: Locator): Promise<number> {
  return locator.evaluate((node) => node.scrollWidth - node.clientWidth);
}

test.describe("mobile clipping batch (#2614)", () => {
  test("item 1: every Trends tab is laid out inside the strip beside the range control", async ({
    page,
  }) => {
    await page.goto("/trends");
    const strip = page.getByTestId("trends-tabs");
    await expect(strip).toBeVisible();

    // The four-tab set fits the column the range trigger leaves it. #640 gave this
    // strip its own `overflow-x-auto` and that fix is intact — but a scroller is
    // the fallback, not the answer: "Insights" used to sit past the edge on first
    // paint with no affordance, so a whole tab of four read as absent.
    expect(await scrollableBy(strip)).toBeLessThanOrEqual(1);
    const insights = strip.getByRole("tab", { name: "Insights" });
    await expect(insights).toBeVisible();
    expect(await overhangWithin(insights, strip)).toBeLessThanOrEqual(1);
    // It is not merely visible — it selects, without the reader hunting for it.
    // Deliberately NOT `followLink`: a tab strip keeps the same named tab on the
    // destination, which is the locator shape that re-clicks itself (#2631).
    await hydratedClick(page, insights);
    await expect(insights).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/tab=insights/);
  });

  test("item 1b: a strip that DOES overflow says so, instead of reading as a clip", async ({
    page,
  }) => {
    // The affordance is the fallback for a strip a shorter viewport cannot hold —
    // the same mask ScrollFade paints on the range pills one row down (#1485 D).
    // Narrow the viewport until the four tabs genuinely cannot fit, and the strip
    // must declare its scrollable edge rather than simply cutting off.
    await page.setViewportSize({ width: 280, height: 844 });
    await page.goto("/trends");
    const strip = page.getByTestId("trends-tabs");
    await expect(strip).toBeVisible();
    expect(await scrollableBy(strip)).toBeGreaterThan(1);
    await expect(strip).toHaveAttribute("data-fade-right", "true");
    await expect
      .poll(() => strip.evaluate((node) => getComputedStyle(node).maskImage))
      .not.toBe("none");
  });

  test("item 2: the sleep log's MOOD reads in full, with no sideways swipe", async ({
    page,
  }) => {
    await page.goto("/sleep");
    const history = page.getByTestId("sleep-mood-history");
    await expect(history).toBeVisible();
    // Stacked-card presentation below `sm`: the header strip is gone and each cell
    // carries its own label, so nothing depends on a column the phone cannot show.
    await expect(history.locator("thead")).toBeHidden();
    expect(
      await scrollableBy(page.getByTestId("sleep-history-scroll-fade"))
    ).toBeLessThanOrEqual(1);

    // MOOD is the cell the census caught mid-glyph ("🙂 Good (4") at the card
    // edge. It is a labelled card line now, laid out inside the card it belongs to.
    const mood = history.getByTestId("sleep-history-mood").first(); // first-ok: the claim is about the mood cell's SHAPE, not about which night
    await expect(mood).toBeVisible();
    await expect(mood.locator(".card-cell-label")).toHaveText("Mood");
    const card = page.getByTestId("sleep-mood-history-row").first(); // first-ok: same row as the cell above — the card that holds it
    expect(await overhangWithin(mood, card)).toBeLessThanOrEqual(1);
  });

  test("item 3: the import Labs table shows its REFERENCE band on the card", async ({
    page,
  }) => {
    // Document 908 is the e2e seed's produced-rows fixture (e2e/seed-events.ts),
    // the same one the desktop records-browser specs read. Nothing is counted here.
    await page.goto("/import/908");

    const table = page.getByTestId("extracted-observations");
    await expect(table).toBeVisible();
    await expect(table.locator("thead")).toBeHidden();
    expect(
      await scrollableBy(page.getByTestId("extracted-observations-scroll"))
    ).toBeLessThanOrEqual(1);

    // The reference band — cut to "3.5-5.|" by the old eight-column grid — is a
    // labelled card line when the row has one. An analyte tab that happens to
    // carry none proves nothing, so the assertion is conditional on presence and
    // the tab's own card shape is asserted unconditionally above.
    const reference = table.locator('td[data-card="meta"]', {
      has: page.locator(".card-cell-label", { hasText: "Reference" }),
    });
    if ((await reference.count()) > 0) {
      const cell = reference.first(); // first-ok: one labelled band proves the round-trip; which analyte owns it is irrelevant
      await expect(cell).toBeVisible();
      const card = cell.locator("xpath=..");
      expect(await overhangWithin(cell, card)).toBeLessThanOrEqual(1);
    }
  });

  test("item 4: the home Recent-labs label keeps its identity when the value is long", async ({
    page,
  }) => {
    await page.goto("/");
    const rows = page.getByTestId("recent-lab-row");
    await expect(rows.first()).toBeVisible(); // first-ok: the widget renders rows; the assertion below is over ALL of them

    // No label is crushed to an ellipsis-with-two-letters. The row wraps its
    // value/age pair to a second line instead of spending the name column, so the
    // rendered name is never narrower than a couple of characters' worth.
    const crushed = await rows.evaluateAll((nodes) =>
      nodes.flatMap((node) => {
        const link = node.querySelector("a");
        if (!link) return [];
        const box = link.getBoundingClientRect();
        // `scrollWidth` is the untruncated text width; a name whose rendered box
        // shows less than half of it has been sacrificed to the value column.
        return box.width * 2 < link.scrollWidth
          ? [
              `${link.textContent?.trim()} rendered at ${Math.round(box.width)}px`,
            ]
          : [];
      })
    );
    expect(crushed, crushed.join("\n")).toEqual([]);
  });
});

// Fixing a clip must never be paid for by letting content out of the viewport,
// which is the part the census found already correct everywhere. The blessed
// element-level guard: it names the offending box rather than asserting a
// document width the app shell clips anyway (#1543).
test.describe("no surface pays for its fix with content past the edge (#2614)", () => {
  for (const path of ["/", "/trends", "/sleep", "/import/908"] as const) {
    test(`${path} keeps every box inside the viewport`, async ({ page }) => {
      await page.goto(path);
      await expectNoClippedContent(page);
    });
  }
});
