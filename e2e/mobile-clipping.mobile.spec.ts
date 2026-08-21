import { test, expect } from "./fixtures";
import type { Locator } from "@playwright/test";
import {
  expectNoClippedContent,
  hydratedClick,
  settledBoxes,
  touchSwipe,
} from "./helpers";

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

  test("item 4: a home Clinical results label keeps its identity when the value is long", async ({
    page,
  }) => {
    // The RULE is unchanged from the census: a long clinical value may not cost the
    // reading its NAME at 390px. The SURFACE moved (#3186). This read
    // `recent-lab-row` — RecentLabReadout — and a Standing member never renders its
    // full atom node (DashboardStandingCluster renders the compact presentation
    // instead), so those rows were only ever the tail BEYOND the family cap: a
    // profile seating three markers and spilling none rendered zero of them. The
    // tail is no longer a dashboard fact, so the clinical rows a phone shows are
    // the family's own — and they are the worst case for this rule rather than a
    // milder one, because seating is flagged-first and the values carrying a
    // severity word are exactly the seated ones.
    await page.goto("/");
    const family = page.locator('[data-standing-family="clinical-results"]');
    await expect(family).toBeVisible();
    const rows = family.getByTestId("dashboard-candidate");
    await expect(rows.first()).toBeVisible(); // first-ok: presence proves the family rendered; the assertions below are over ALL of them

    // No name is sacrificed to the value column. The census measured this as the
    // rendered box against the text's own width; a Range says the same thing for an
    // inline span, whose `scrollWidth` is zero. A wrapped name reads the same either
    // way — the union of its line boxes IS its text — so only a name actually
    // clipped short of itself can fail this.
    const crushed = await rows.evaluateAll((nodes) =>
      nodes.flatMap((node) => {
        const label = node.querySelector('[data-testid="standing-label"]');
        if (!label) return [];
        const range = document.createRange();
        range.selectNodeContents(label);
        const box = label.getBoundingClientRect();
        return box.width * 2 < range.getBoundingClientRect().width
          ? [
              `${label.textContent?.trim()} rendered at ${Math.round(box.width)}px`,
            ]
          : [];
      })
    );
    expect(crushed, crushed.join("\n")).toEqual([]);

    // And nothing buys its fit by sitting past an edge instead: each name is laid
    // out inside its own row, and every row inside the card that holds it.
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      expect(
        await overhangWithin(row.getByTestId("standing-label"), row)
      ).toBeLessThanOrEqual(1);
    }
    expect(await scrollableBy(family)).toBeLessThanOrEqual(1);
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

// A DIALOG BODY IS NOT A SIDEWAYS SCROLLER (#3360).
//
// The shape above is a container that clips content it should scroll. This is the
// inverse, and it is worse: a container that SCROLLS when nothing asked it to.
// `overflow-y-auto` on the sheet's content region is not a y-only declaration —
// per CSS a non-`visible` `overflow-y` forces `overflow-x` to compute to `auto` —
// so any mounted body with a stray full-bleed negative margin handed the region
// real overflow. FoodLogBar's `-mx-2 px-2` header was the reported one: the owner
// logged a serving on a phone, the drag carried a few pixels of horizontal, and
// the whole sheet parked 8px left with no snap-back, no scrollbar on touch and no
// affordance back. Text with no padding of its own then clipped at the screen
// edge, so it read as "the header is broken" rather than "the sheet is scrolled".
//
// Two assertions, deliberately at two tiers: the consumer that was reported, and
// the HOST contract that retires the class. The host one injects its own over-wide
// child, so it keeps holding after every consumer's bleed is scoped away.
test.describe("a dialog body cannot be parked sideways (#3360)", () => {
  // What a parked sheet IS, asked of the element rather than of a screenshot: the
  // region can be scrolled sideways, and once dragged it stays there.
  async function parkSideways(content: Locator): Promise<number> {
    return content.evaluate((node) => {
      node.scrollLeft = 999;
      return node.scrollLeft;
    });
  }

  // WHAT IS STICKING OUT, not just how far. KEEP THIS even when the assertion it
  // annotates is green — a reviewer will read it as dead weight and it is the
  // opposite. `scrollWidth - clientWidth` is a number with no author: the first
  // time this went red on CI it said "Received: 5" and nothing else, and 5px in a
  // dialog body can be a bleed, a hit-area pseudo-element, sub-pixel rounding, or
  // a child that was transiently wide during mount. Those need different fixes.
  // This walks the region and names the deepest element whose own scroll extent
  // exceeds its box, which is where the overflow is actually born, so the NEXT
  // red arrives with its cause attached instead of a bare integer. (It found the
  // real one: a `tap-target` extension on the preferences button, #3384.)
  async function overflowStory(content: Locator): Promise<string> {
    return content.evaluate((node) => {
      const over = node.scrollWidth - node.clientWidth;
      if (over <= 0) return "nothing overflows";
      const edge = node.getBoundingClientRect().right;
      // RANKED BY REACH PAST THE REGION'S EDGE, not by "does this element
      // overflow at all". Nearly every `tap-target` in the sheet overflows its
      // own box by 6px — that is what the hit-area extension IS — and listing
      // them all buries the one that matters under a wall of innocents. Only an
      // element whose overflow actually arrives at the region's right edge can
      // make the region scrollable, so that is the question asked.
      const culprits = Array.from(node.querySelectorAll("*"))
        .filter(
          (el): el is HTMLElement =>
            el instanceof HTMLElement &&
            // Only overflow that ESCAPES can make the region scrollable. A
            // `truncate` span overruns its box by a mile and clips every pixel of
            // it, so it is not a suspect — including it put three innocent labels
            // at the top of this list the first time round.
            getComputedStyle(el).overflowX === "visible"
        )
        .map((el) => ({
          el,
          reach:
            el.getBoundingClientRect().right +
            (el.scrollWidth - el.clientWidth) -
            edge,
        }))
        .filter((c) => c.reach > -0.5)
        .sort((a, b) => b.reach - a.reach)
        .slice(0, 3)
        .map(
          ({ el, reach }) =>
            `<${el.tagName.toLowerCase()} data-testid="${
              el.getAttribute("data-testid") ?? ""
            }" class="${el.className}"> reaches ${Math.round(reach)}px past`
        );
      return `region overflows by ${over}px; ${
        culprits.join(" | ") ||
        "no element reaches the edge — check text, a pseudo-element, or a mid-mount width"
      }`;
    });
  }

  test("the quick-entry food sheet stays where it was opened", async ({
    page,
  }) => {
    await page.goto("/?quick=log-food");
    const sheet = page.getByTestId("quick-entry-sheet");
    await expect(sheet).toBeVisible();
    const content = sheet.locator("[data-sheet-content]");
    await expect(content).toBeVisible();

    // WAIT FOR THE FORM BEFORE MEASURING ANYTHING. `quick-entry-body` renders a
    // loading paragraph while the food form arrives, and a paragraph fits any
    // width — so the first version of this test measured the placeholder, passed
    // for a reason that had nothing to do with the sheet, and only went red once
    // CI happened to be past the mount. A race that resolves toward the EMPTY DOM
    // is the worst kind: it fails toward green, so the spec reports success
    // without ever having looked at the thing it names (#3384). These two waits
    // are the assertion's precondition, not scenery.
    const context = sheet.getByTestId("food-log-context");
    await expect(sheet.getByTestId("food-log-bar")).toBeVisible();
    await expect(context).toBeVisible();

    // Nothing to scroll to, because the mounted body fits: FoodLogBar's bleed is
    // scoped to the `md:sticky` widths where it earns its keep, and the tap
    // extension on its flush-right control has the room it needs.
    expect(
      await scrollableBy(content),
      await overflowStory(content)
    ).toBeLessThanOrEqual(0);
    // And the region refuses the offset even so — the acceptance criterion as
    // written: `scrollLeft = 999` leaves it at 0.
    expect(await parkSideways(content)).toBe(0);

    // The consequence the owner reported, stated as the thing they saw: the header
    // block is inside the sheet's box, not hanging off its left edge.
    const [contextBox, contentBox] = await settledBoxes([context, content]);
    expect(contextBox.x).toBeGreaterThanOrEqual(contentBox.x - 1);
    expect(await overhangWithin(context, content)).toBeLessThanOrEqual(1);
  });

  test("a dialog hosting a deliberately over-wide child still refuses", async ({
    page,
  }) => {
    // The generic half, and the one that survives its own consumer. Any body may
    // grow a full-bleed wrapper again; the host's job is that doing so costs a few
    // clipped pixels of background instead of a scrollable viewport.
    await page.goto("/?quick=log-food");
    const sheet = page.getByTestId("quick-entry-sheet");
    await expect(sheet).toBeVisible();
    // Same precondition as above: measure a mounted body, never the placeholder.
    await expect(sheet.getByTestId("food-log-bar")).toBeVisible();
    const content = sheet.locator("[data-sheet-content]");
    await expect(content).toBeVisible();

    await content.evaluate((node) => {
      const wide = document.createElement("div");
      // Wider than any phone, and negatively margined the way a full-bleed
      // wrapper is — the two ways a child can exceed its container.
      wide.style.width = "1200px";
      wide.style.marginLeft = "-40px";
      wide.style.height = "8px";
      wide.setAttribute("data-e2e-overwide", "true");
      node.appendChild(wide);
    });
    await expect(content.locator("[data-e2e-overwide]")).toHaveCount(1);

    // THE REPORTED GESTURE, on a body that genuinely overflows. This is the whole
    // guarantee: a `hidden` box is not user-scrollable, so the sideways component
    // of a logging tap moves nothing.
    const box = await content.boundingBox();
    expect(box).not.toBeNull();
    const y = box!.y + Math.min(80, box!.height / 2);
    await touchSwipe(
      page,
      { x: box!.x + box!.width - 40, y },
      { x: box!.x + 40, y }
    );
    expect(
      await content.evaluate((node) => node.scrollLeft),
      "a thumb drag across a dialog body must not park it sideways"
    ).toBe(0);

    // `hidden`, never `auto` or `scroll` — and never `visible`, which would put
    // the overflow back on the page. `clip` would be the stronger word and is not
    // available: with a scrolling value on the other axis, CSS uses `hidden` for
    // it, which Chromium confirms by reporting exactly that for `overflow-x-clip`
    // here. `hidden` is therefore the strongest this y-scroller can be, and the
    // reason #3360 also wanted bodies that do not overflow in the first place: a
    // SCRIPT can still write an offset onto a `hidden` box (measured: 802 with
    // this same injected child), even though no reader can.
    expect(
      await content.evaluate((node) => getComputedStyle(node).overflowX)
    ).toBe("hidden");
    // The y axis is still a real scroller with its overscroll contained — the
    // x-axis declaration must not have cost the sheet its own scrolling.
    expect(
      await content.evaluate((node) => getComputedStyle(node).overflowY)
    ).toBe("auto");
  });
});
