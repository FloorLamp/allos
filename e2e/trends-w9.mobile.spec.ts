import { test, expect } from "./fixtures";
import { expectNoClippedContent } from "./helpers";
import { expandTrendsContext } from "./trends-chrome";

// Mobile-only seams from issues #1493 and #1485.
//
// What each clause is a regression class FOR:
//
//   • #1493 A — tabs without annotated charts must not render dead annotation
//     controls. Full-chart behavior lives in the desktop annotation suite because
//     Body's mobile surface is now tiles-only.
//   • #1485 D(a) — the pill row SCROLLED but said nothing about it, so the sixth
//     pill read as a hard-clipped "Custo…". The fade is a mask, so it is asserted
//     as a computed style at both scroll positions rather than by pixel.
//   • #1485 D(b) — training volume is a per-day total whose rest days are real
//     zeros; it now draws bars. Asserted as MARKS in the DOM (bar rectangles, and
//     no line path in that tile), because "it looks less noisy" is not testable.
// Saved-view round-trip coverage lives in the desktop suite now that the control
// is deliberately absent from the mobile range row.

test.describe("annotation + protocol-window toggles under the new chrome (#1493 A)", () => {
  test("the toggles are absent on a tab whose charts carry no markers", async ({
    page,
  }) => {
    // A toggle for a kind with no markers is dead weight — the rule the per-chart
    // bar already held, kept now that the row is hoisted to a page-level slot.
    await page.goto("/trends");
    await expandTrendsContext(page);
    await expect(page.getByTestId("trends-context-controls")).toBeVisible();
    await expect(page.getByTestId("trend-annotation-controls")).toHaveCount(0);
  });
});

test.describe("the range-pill row says that it scrolls (#1485 D)", () => {
  test("carries the shared fade affordance on whichever edge has more", async ({
    page,
  }) => {
    // #1644: the body census rides the default view, so the window is all this URL
    // needs to name.
    await page.goto("/trends?range=all");
    await expandTrendsContext(page);
    const row = page.getByTestId("trends-chip-row");
    await expect(row).toBeVisible();

    // The premise: at 390px there IS more row than box. Asserted (not assumed) so
    // this can't pass vacuously if the row ever fits.
    const overflow = await row.evaluate(
      (el) => el.scrollWidth - el.clientWidth
    );
    expect(
      overflow,
      "the pill row should overflow at phone width"
    ).toBeGreaterThan(0);

    // At rest (scrollLeft 0) only the RIGHT edge has content past it, so only the
    // right fades — the mask is the app's one ScrollFade treatment, not a second
    // hand-rolled gradient, and it never paints on an edge with nothing behind it.
    await expect
      .poll(() => row.evaluate((el) => getComputedStyle(el).maskImage))
      .toContain("calc(100% - 28px)");
    await expect
      .poll(() => row.evaluate((el) => getComputedStyle(el).maskImage))
      .not.toContain("rgba(0, 0, 0, 0) 0px");

    // Scrolled into the middle, BOTH edges have more, so both fade.
    await row.evaluate((el) => {
      el.scrollLeft = Math.round((el.scrollWidth - el.clientWidth) / 2);
      el.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(() => row.evaluate((el) => getComputedStyle(el).maskImage))
      .toContain("0, 0) 28px");

    // And the row is a WORKING scroller, so it is not "clipped content" — the
    // element-level guard would say so otherwise.
    await expectNoClippedContent(page);
  });
});

test.describe("training volume draws bars, not a sawtooth (#1485 D)", () => {
  test("the volume tile renders bar marks where the level tiles render lines", async ({
    page,
  }) => {
    await page.goto("/trends?range=all");
    const volume = page
      .getByTestId("saved-tiles")
      .locator('[data-sparkline-shape="bar"]');
    // Exactly one bar-shaped tile in the seeded grid (training volume) — a count on
    // a SHAPE, not on a shared-seed row set, so it does not break when the seed
    // grows a biomarker.
    await expect(volume).toHaveCount(1);

    // The marks themselves: bars, and no line path inside that tile.
    await expect
      .poll(async () => volume.locator(".recharts-bar-rectangle").count())
      .toBeGreaterThan(1);
    await expect(volume.locator(".recharts-line")).toHaveCount(0);

    // The level tiles are untouched — the variant is applied to volume-shaped
    // series, not to every tile.
    const lines = page
      .getByTestId("saved-tiles")
      .locator('[data-sparkline-shape="line"]');
    await expect.poll(async () => lines.count()).toBeGreaterThan(0);
  });
});

test.describe("the compare block at 390px (#1493 B)", () => {
  test("pickers stack full-width and the normalize toggle clears the touch floor", async ({
    page,
  }) => {
    await page.goto(
      "/trends?tab=insights&cmpA=metric%3Aweight&cmpB=metric%3Aresting_hr&range=all"
    );
    const a = page.locator("#cmp-a");
    const b = page.locator("#cmp-b");
    await expect(a).toBeVisible();
    await expect(b).toBeVisible();

    // They stack (B below A) rather than sharing a cramped row, and each takes the
    // card's full content width — which is why they stayed native `<select>`s
    // instead of becoming a hand-built sheet: the OS picker IS the phone
    // affordance, and it is the accessible one.
    const boxA = (await a.boundingBox())!;
    const boxB = (await b.boundingBox())!;
    expect(boxB.y).toBeGreaterThan(boxA.y + boxA.height - 1);
    expect(boxA.width).toBeGreaterThan(280);
    expect(boxB.width).toBeGreaterThan(280);

    // The one control here you TAP rather than pick from: it was a ~28px label box,
    // under the ~44px floor the rest of the app holds.
    const normalize = page.getByTestId("compare-normalize");
    const box = (await normalize.boundingBox())!;
    expect(
      box.height,
      "the normalize toggle's tap target"
    ).toBeGreaterThanOrEqual(44);

    await expectNoClippedContent(page);
  });
});
