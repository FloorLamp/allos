import { test, expect } from "./fixtures";
import {
  expectNoClippedContent,
  hydratedClick,
  settledClick,
  settledFill,
} from "./helpers";
import { expandTrendsContext } from "./trends-chrome";

// The Trends arc's last three seams (issues #1493 A/B/C and #1485 D), all of them
// layout or state that only a browser at 390px can see.
//
// What each clause is a regression class FOR:
//
//   • #1493 A — the event / protocol-window toggles used to render as a wrapped
//     two-line pill row directly above the charts: ~60px of STANDING chrome on
//     every Body visit, for a control touched about once a session. They now live
//     in the context bar's expanded controls. So this pins BOTH halves: nothing
//     above the charts when the bar is collapsed, AND the control still works
//     (toggling a kind removes its markers from the plot). A "relocation" that
//     quietly broke the toggle would pass a purely positional test.
//   • #1485 D(a) — the pill row SCROLLED but said nothing about it, so the sixth
//     pill read as a hard-clipped "Custo…". The fade is a mask, so it is asserted
//     as a computed style at both scroll positions rather than by pixel.
//   • #1485 D(b) — training volume is a per-day total whose rest days are real
//     zeros; it now draws bars. Asserted as MARKS in the DOM (bar rectangles, and
//     no line path in that tile), because "it looks less noisy" is not testable.
//   • #1493 C — "Save current" must capture the FULL state. The round-trip is the
//     only honest test: save on Body + tiles + a one-day window, navigate away,
//     re-apply, and assert every part came back.
//
// Fixture (#868 hygiene): the read-only clauses ride the shared seed and
// exact-count nothing. The saved-view clauses OWN their fixture — a uniquely-named
// view created and deleted inside the test — so a repeat run or a neighbour is
// never perturbed (re-saving the same name overwrites in place, so a repeat is
// idempotent by construction).

const VIEW_NAME = "w9 roundtrip";
const LEGACY_VIEW_NAME = "w9 legacy vocab";

// Save the current hub state under `name` through the expanded context bar's
// "Save current" affordance — the #1493 C requirement that the control costs no
// standing chrome is exactly why this has to go through the bar.
async function saveCurrentView(
  page: import("@playwright/test").Page,
  name: string
) {
  await expandTrendsContext(page);
  await hydratedClick(page, page.getByRole("button", { name: "Save current" }));
  await settledFill(page, page.getByPlaceholder("View name…"), name);
  await settledClick(
    page,
    page.getByRole("button", { name: "Save", exact: true })
  );
  await expandTrendsContext(page);
  await expect(applyButton(page, name)).toBeVisible();
}

// The chip's accessible name is the VIEW NAME (its text content); the "Apply …"
// wording lives in the title attribute, which never becomes the name while the
// button has content.
function applyButton(page: import("@playwright/test").Page, name: string) {
  return page.getByRole("button", { name, exact: true });
}

async function deleteView(page: import("@playwright/test").Page, name: string) {
  await page.goto("/trends");
  await expandTrendsContext(page);
  const del = page.getByRole("button", { name: `Delete view ${name}` });
  if (await del.isVisible().catch(() => false)) {
    await settledClick(page, del);
    await expect(del).toHaveCount(0);
  }
}

test.describe("annotation + protocol-window toggles under the new chrome (#1493 A)", () => {
  test("cost no standing chrome, and still filter the charts from the bar", async ({
    page,
  }) => {
    // `view=all` is the layout that actually carries the annotated chart stack on a
    // phone (the Body default is the tile grid), so it is where the old pill row
    // was standing chrome.
    await page.goto("/trends?tab=body&view=all&range=all");

    // Collapsed: the toggles are genuinely put away — `hidden`, so they are out of
    // the accessibility tree too, not merely scrolled past.
    await expect(page.getByTestId("trends-context-bar")).toHaveAttribute(
      "data-expanded",
      "false"
    );
    await expect(page.getByTestId("trend-annotation-controls")).toBeHidden();

    // Expanded: they are THERE, and they are inside the bar's controls — the whole
    // point is that they moved, not that they were deleted.
    await expandTrendsContext(page);
    const controls = page.getByTestId("trend-annotation-controls");
    await expect(controls).toBeVisible();
    await expect(
      page
        .getByTestId("trends-context-controls")
        .getByTestId("trend-annotation-controls")
    ).toBeVisible();

    // …and the control still controls. Protocol windows are the #660 half, so it is
    // the one asserted end-to-end: turning "Protocols" off must remove the shaded
    // regions from the plots.
    const protocols = page.getByRole("button", { name: "Protocols" });
    await expect(protocols).toHaveAttribute("aria-pressed", "true");
    const shaded = page.locator(".recharts-reference-area");
    await expect
      .poll(async () => await shaded.count(), {
        message: "the seeded protocol windows should be shaded to begin with",
      })
      .toBeGreaterThan(0);

    await hydratedClick(page, protocols);
    await expect(protocols).toHaveAttribute("aria-pressed", "false");
    await expect(shaded).toHaveCount(0);

    await hydratedClick(page, protocols);
    await expect(protocols).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => await shaded.count()).toBeGreaterThan(0);
  });

  test("window labels are at the legibility floor, never below it (#1445)", async ({
    page,
  }) => {
    // #1493 A asks this to be CONFIRMED rather than assumed: #1445 raised the
    // 9px `ReferenceArea`/`ReferenceLine` label to the 10px floor, and the
    // question is whether that reached the protocol windows. It did — pinned here
    // so a future label tweak can't quietly drop back under the floor on the
    // surface where it matters most (a ~326px-wide phone plot).
    await page.goto("/trends?tab=body&view=all&range=all");
    // The premise: this page really does shade protocol windows.
    await expect
      .poll(async () => await page.locator(".recharts-reference-area").count())
      .toBeGreaterThan(0);

    // recharts renders a ReferenceArea/ReferenceLine's LABEL in its own z-index
    // layer rather than inside the mark, so the honest assertion is the invariant
    // #1445 actually states: nothing drawn in a chart goes under the 10px floor.
    const sizes = await page
      .locator(".recharts-wrapper svg text")
      .evaluateAll((els) =>
        els.map((el) => parseFloat(getComputedStyle(el).fontSize))
      );
    expect(sizes.length, "the charts should be drawing text").toBeGreaterThan(
      0
    );
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(10);
  });

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
    await page.goto("/trends?tab=body&range=all");
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

test.describe("saved views capture the whole state (#1493 C)", () => {
  test.afterEach(async ({ page }) => {
    await deleteView(page, VIEW_NAME);
    await deleteView(page, LEGACY_VIEW_NAME);
  });

  test("save on Body / tiles / a one-day window, reopen, identical state", async ({
    page,
  }) => {
    // A deep-linked one-day window is exactly what the "1D" pill produces (#1466):
    // from = to = the chosen day. Deep-past dates so no seed growth can move them.
    const day = "2026-01-15";
    await page.goto(`/trends?tab=body&view=tiles&from=${day}&to=${day}`);
    await expect(page.getByTestId("body-tiles-view")).toBeVisible();

    // The control lives in the EXPANDED bar — it must not cost standing chrome.
    await expect(
      page.getByRole("button", { name: "Save current" })
    ).toBeHidden();
    await saveCurrentView(page, VIEW_NAME);

    // Leave — a different tab AND a different window, so nothing about the
    // restored state could be left over from the page we saved on.
    await page.goto("/trends?range=all");
    await expect(page.getByTestId("trends-context-label")).toHaveText(
      "Overview · All time"
    );

    await expandTrendsContext(page);
    await settledClick(page, applyButton(page, VIEW_NAME));

    // Every captured part came back: the tab, the window, AND the Body layout —
    // the piece a "save current" that drops state would silently lose.
    await expect(page).toHaveURL(
      new RegExp(`tab=body.*from=${day}.*to=${day}.*view=tiles`)
    );
    // A one-day window has no pill to name it, so the label falls back to the
    // shared range summary — which collapses from == to to the single date.
    await expect(page.getByTestId("trends-context-label")).toHaveText(
      `Body · ${day}`
    );
    await expect(page.getByTestId("body-tiles-view")).toBeVisible();
    // …and the layout is genuinely the tile grid, not merely a URL that says so.
    await expect(page.getByTestId("body-charts-all")).toBeHidden();
  });

  test("a view saved under the pre-#1486 tab vocabulary still resolves", async ({
    page,
  }) => {
    // `?tab=vitals` is a RETIRED name that a stored view can still carry (#1486
    // merged Vitals into Body; #1489 did the same to Compare). The bar snapshots
    // the tab straight off the URL, so saving here produces a genuinely
    // old-vocabulary view — and applying it must land on the tab that absorbed it
    // rather than silently on Overview.
    await page.goto("/trends?tab=vitals&range=all");
    await expect(page.getByTestId("trends-context-label")).toHaveText(
      "Body · All time"
    );
    await saveCurrentView(page, LEGACY_VIEW_NAME);

    await page.goto("/trends");
    await expandTrendsContext(page);
    await settledClick(page, applyButton(page, LEGACY_VIEW_NAME));

    // The URL keeps the stored vocabulary; the PAGE resolves it through the alias.
    await expect(page).toHaveURL(/tab=vitals/);
    await expect(page.getByTestId("trends-context-label")).toHaveText(
      "Body · All time"
    );
    await expect(page.getByTestId("trends-body")).toBeVisible();
  });
});
