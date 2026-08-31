import { test, expect } from "./fixtures";
import type { Locator } from "@playwright/test";
import { shiftDateStr } from "@/lib/date";
import {
  expectAtomicCardPairs,
  expectNoClippedContent,
  expectNoEscapingOverflow,
  hydratedClick,
  overflowStory,
  settledBoxes,
  touchSwipe,
} from "./helpers";
import { frozenNow } from "./worker-env";

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

// How many naps one wake-day must carry for the sleep history to be ABLE to show
// the #3517 defect, in nap lines on a single card.
//
// The unit is nap nodes in one meta cell, and the number is measured rather than
// chosen: at 390px, three naps ran the row 29px past its own right edge and one
// ran it 0px. Two is the first count that puts a second flex item on the line, so
// two would already be a real test — three is what the regression was actually
// found at, and it leaves the margin that says the failure is the layout rather
// than a rounding edge. The fixture that satisfies this lives in
// `e2e/seed/sleep.ts`; if it drifts back to one nap, the assertion using this
// constant fails and names the fixture instead of passing over a page that
// cannot be wrong.
const MIN_NAPS_TO_EXPRESS_THE_DEFECT = 3;

// The wake-day `e2e/seed/sleep.ts` builds that fixture on: `today-2`, profile-local.
// The suite's pinned zone always reads 13:mm local (e2e/pinned-timezone.ts), so the
// profile-local date and the frozen instant's UTC date are the same day by
// construction — see that file.
const NAP_FIXTURE_WAKE_DAY = shiftDateStr(
  frozenNow().toISOString().slice(0, 10),
  -2
);

// The seed's own claim, read back off the page, SEPARATELY from the layout claim
// (#3636). Item 2b's `MIN_NAPS...` expectation was doing both jobs and fired first,
// so when the fixture broke — three naps that merged into one fragmented night and
// left the cell empty — the run reported a layout failure and sent the reader to
// ResponsiveTable instead of to the seed. This names the seed.
//
// A NIGHT *AND* THREE NAPS, because the two are one fact: a wake-day with no ≥6h
// block does not have three naps on it at all, whatever was inserted. `napSessions`
// is the inverse of `mainSleepPeriod`, so without the night the same three rows are
// co-equal fragments of one merged night and the nap count is zero.
//
// Exactly three: the #160 SRI block now resolves its 28 windows through the profile
// timezone (#3644), so its stored wake-day and computed wake-day agree and no
// neighbouring night can be misclassified as a fourth nap on this row.
async function expectSeededNapFixture(history: Locator): Promise<void> {
  const row = history.locator(
    `[data-testid="sleep-mood-history-row"][data-date="${NAP_FIXTURE_WAKE_DAY}"]`
  );
  await expect(
    row,
    `e2e/seed/sleep.ts seeds the #3517 night-plus-naps fixture on wake-day ` +
      `${NAP_FIXTURE_WAKE_DAY}, which must be a row on page 1 of the sleep log`
  ).toHaveCount(1);
  const seeded = await row.evaluate((node) => ({
    // The row's headline duration cell — the main sleep period for the wake-day.
    duration: (
      node.querySelector('[data-card="value"] span')?.textContent ?? ""
    ).trim(),
    // One `·` per rendered "start → end · duration" nap line, the same count item
    // 2b takes below.
    naps: (
      node.querySelector('[data-testid="sleep-history-naps"]')?.textContent ??
      ""
    ).match(/·/g)?.length,
  }));
  const hours = Number(/^(\d+)h/.exec(seeded.duration)?.[1] ?? NaN);
  expect(
    hours,
    `wake-day ${NAP_FIXTURE_WAKE_DAY} reads "${seeded.duration}" as its main ` +
      `sleep. e2e/seed/sleep.ts must give it a block of at least 6h that ENDS on ` +
      `it in the profile's zone — under that, mainSleepPeriod's siesta guard does ` +
      `not fire and the day's sessions merge into one fragmented night instead`
  ).toBeGreaterThanOrEqual(6);
  expect(
    seeded.naps ?? 0,
    `wake-day ${NAP_FIXTURE_WAKE_DAY} renders ${seeded.naps ?? 0} nap line(s). ` +
      `e2e/seed/sleep.ts seeds three afternoon naps there; a lower count means ` +
      `the seed drifted, not that the layout regressed`
  ).toBe(MIN_NAPS_TO_EXPRESS_THE_DEFECT);
}

test.describe("mobile clipping batch (#2614)", () => {
  test("item 1: every Trends tab is laid out inside the strip beside the range control", async ({
    page,
  }) => {
    await page.goto("/trends");
    const strip = page.getByTestId("trends-tabs");
    await expect(strip).toBeVisible();

    // The three-tab set fits the column the range trigger leaves it. #640 gave this
    // strip its own `overflow-x-auto` and that fix is intact — but a scroller is
    // the fallback, not the answer: "Insights" used to sit past the edge on first
    // paint with no affordance, so a whole tab read as absent.
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
    // Narrow the viewport until the three tabs genuinely cannot fit, and the strip
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

  // ── THE NAPS CELL, WHICH IS WHERE THE PRIMITIVE ACTUALLY BROKE (#3517) ──────
  //
  // `scanCardMetaPairs` shipped in #3516 guarding card-mode meta pairs, asserted
  // from two specs — and NOT from the one surface that had really regressed. The
  // sleep history passed its naps as loose sibling `<div>`s. Valid under the old
  // block flow, which stacked them; a flex line does not, so a three-nap day ran
  // its row 29px past its own right edge. No spec saw it and no page-level check
  // could: the same width comparison taken on the ROOT element read ZERO the whole
  // time. The `<tr>` scrolls; the document does not — which is why the scan
  // measures each cell against ITS OWN ROW, and why item 2 above (a clean
  // `sleep-history-scroll-fade`) was green over the defect too.
  //
  // IT LIVES HERE RATHER THAN IN A NEW SPEC FILE ON PURPOSE. #3517 expected this
  // to cost a new file and therefore a re-partition of all twelve duration-balanced
  // e2e shards. It does not: this spec already renders the sleep history in card
  // mode at 390px (item 2, right above), and its subject — "content clipped inside
  // its own container" — IS the naps failure exactly. So the coverage lands with
  // the shard plan untouched.
  //
  // THE FIXTURE IS REAL, NOT FORGED. The seed used to carry ONE nap on the day the
  // hero reads, and one nap cannot express the defect at any viewport: a single
  // flex item wraps inside itself. `e2e/seed/sleep.ts` now seeds a genuine
  // three-nap wake-day on an OLDER history date, so this test measures a page that
  // can actually be wrong. Forging three nodes here would have proved the SCAN
  // works, which is a different claim from the page being correct.
  test("item 2b: a multi-nap sleep card keeps its naps inside its own row (#3517)", async ({
    page,
  }) => {
    await page.goto("/sleep");
    const history = page.getByTestId("sleep-mood-history");
    await expect(history).toBeVisible();
    // Wait for a rendered naps CELL, never the table: a region that has not painted
    // its content satisfies every geometry claim made about it (#3384), and an
    // empty naps corpus is the state that flatters this test.
    await expect(
      history.getByTestId("sleep-history-naps").first() // first-ok: any painted naps cell proves the rows rendered; the reads below are over ALL of them
    ).toBeVisible();

    // The fixture first, in its own words: this test can only judge the layout of a
    // page that has something to lay out.
    await expectSeededNapFixture(history);

    // One settled read over every naps cell on the page: how many nap lines the
    // value holds, and how far the row it sits in could be scrolled sideways.
    const cells = await history.evaluate((root) =>
      Array.from(
        root.querySelectorAll<HTMLElement>('[data-testid="sleep-history-naps"]')
      ).map((cell) => {
        const label = cell.querySelector(".card-cell-label");
        const text = (cell.textContent ?? "").trim();
        const row = cell.closest("tr");
        return {
          labelled: !!label,
          // Naps counted from the RENDERED TEXT, one `·` per "start → end ·
          // duration" line, NOT from the value's node structure. Counting nodes
          // would make this fixture check shape-dependent, and the shape is
          // exactly what the geometry assertion below is here to judge: under the
          // regression it read zero, so the test went red on "the seed drifted"
          // and would have sent the next reader to e2e/seed/sleep.ts instead of to
          // the layout. A count that survives both shapes lets the right assertion
          // be the one that fires.
          naps: (text.match(/·/g) ?? []).length,
          rowScroll: row ? row.scrollWidth - row.clientWidth : 0,
          text: text.slice(0, 60),
        };
      })
    );

    // THE FIXTURE HAS TO BE ABLE TO EXPRESS THE DEFECT. One nap cannot: a single
    // flex item shrinks and wraps inside itself at any viewport. The seed used to
    // carry exactly one, so a green test here would have proved nothing about the
    // page — `e2e/seed/sleep.ts` now seeds a genuine three-nap wake-day, and this
    // is the assertion that fails, naming the fixture, if it ever drifts back.
    const labelled = cells.filter((c) => c.labelled);
    expect(
      Math.max(0, ...labelled.map((c) => c.naps)),
      `naps cells seen: ${labelled.map((c) => `${c.naps}× ${c.text}`).join(" | ")}`
    ).toBeGreaterThanOrEqual(MIN_NAPS_TO_EXPRESS_THE_DEFECT);

    // Measured the way the defect was found, and the only way it CAN be found: the
    // row's own scroller. This read 29 with three naps and 0 with one, while
    // the same comparison taken on the ROOT element read ZERO throughout — the
    // `<tr>` scrolls, the document does not, which is why item 2's clean
    // `sleep-history-scroll-fade` was green over the defect as well.
    expect(
      labelled.filter((c) => c.rowScroll > 1).map((c) => c.text),
      "a sleep history row scrolls sideways. Its naps are flex items on the " +
        "cell's single line, so several loose sibling nodes sit side by side " +
        "instead of stacking (components/ResponsiveTable.tsx, where `label` is " +
        "documented). Pass the naps as ONE node."
    ).toEqual([]);

    // …and the full pair scan over the same history, with the discriminator that
    // keeps an absence assertion honest (#3509): the labels it must have SEEN, then
    // a break forged on purpose that it must flag, then the control after restore.
    await expectAtomicCardPairs(history, ["Naps", "Mood"]);
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
    // On this fixture the seated draws are inside the ruled 30-day collection window
    // (#4232), so they are FRESH and claim Standing's attention tier — the same rows,
    // the same anatomy, the band above the fold instead of the one behind it.
    const family = page.locator(
      '[data-standing-band="attention"] [data-standing-family="clinical-results"]'
    );
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

  test("item 5: the passport's immunizations table FITS the card instead of scrolling (#3242)", async ({
    page,
  }) => {
    // The passport is a print-and-hand-over surface, so the rule here is stronger
    // than the batch's usual one: a working scroller is not good enough. Every dose
    // line used to be `whitespace-nowrap` ("2024–25 season: Jul 15, 2025"), which
    // set the DOSES column's min-content and pushed the table far past a 390px
    // card — at `scrollLeft: 0` the header read "DOSE" and the dates cut
    // mid-character with nothing saying sideways scroll existed.
    await page.goto("/profile");
    const table = page.getByTestId("passport-immunizations");
    await expect(table).toBeVisible();
    // Wait for a real dose cell, not the container: a table measured before its
    // rows are laid out fits any width (the #3384 lesson).
    const doses = table.locator("tbody tr td:last-child");
    await expect(doses.first()).toBeVisible(); // first-ok: presence proves the rows rendered; the assertions below read ALL of them
    await expect(doses.filter({ hasText: "season" }).first()).toBeVisible(); // first-ok: the seeded labelled flu dose — the longest line in the column, and the one that used to set the min-content width

    // It fits: nothing to scroll sideways to, inside its own scroller OR the card.
    expect(await scrollableBy(table)).toBeLessThanOrEqual(1);
    const card = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Immunizations" }) });
    expect(
      await overhangWithin(table.locator("table"), card)
    ).toBeLessThanOrEqual(1);

    // …and no dose value bought that fit by being CUT. A wrapped line's box is
    // narrower than its text Range, so width cannot answer this — but a clipped one
    // has `scrollWidth > clientWidth` on the cell that holds it, and a wrapped one
    // does not.
    const clipped = await doses.evaluateAll((cells) =>
      cells
        .filter((cell) => cell.scrollWidth > cell.clientWidth + 1)
        .map((cell) => `${cell.textContent?.trim()} clipped`)
    );
    expect(clipped, clipped.join("\n")).toEqual([]);

    // The page keeps exactly ONE heading at page scale (#1449/#3242). The identity
    // name is an h1 only on /share, where this component IS the page; here it is an
    // h2 under "Health passport", and it used to be BOTH a second h1 and — at 24px
    // against the header's 20px below `md` — the larger of the two.
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Health passport"
    );
    const pageScale = await page.evaluate(
      () =>
        [...document.querySelectorAll("h1,h2")].filter(
          (h) => parseFloat(getComputedStyle(h).fontSize) >= 20
        ).length
    );
    expect(pageScale).toBe(1);
  });

  test("item 6: Training → Analyze's day-history calendar scrolls instead of running past the edge (#3712)", async ({
    page,
  }) => {
    // The #3502 phone sweep measured three 24px day buttons 4px past the 390px
    // viewport here, and the mechanism is this file's thesis in its purest form:
    // the calendar HAS an `overflow-x-auto` scroller, and the scroller had grown
    // to its own content's width, so there was nothing to swipe. Its band was a
    // bare `grid`, whose implicit `auto` track takes its floor from the items'
    // min-content — and the calendar's min-content is its whole grid (a 30px
    // weekday gutter + 13 columns of 24px cells and 3px gaps = 378px at the
    // default quarter window), 20px more than the 358px the shell leaves.
    //
    // So this asks the two questions in order: does the CONTAINER fit, and is
    // the content it holds REACHABLE. Either one alone passes on the defect —
    // the cells were "reachable" in the sense that a scroller existed.
    await page.goto("/training?tab=analyze");
    const calendar = page.getByTestId("day-history-calendar");
    await expect(calendar).toBeVisible();

    // WAIT FOR THE CELLS, NOT THE SCROLLER (#3384). The calendar sizes its own
    // cells from its container in an effect after mount, so a box read before
    // they land is a box that fits any width — and every assertion below is an
    // ABSENCE, the direction an unrendered page flatters.
    const days = calendar.getByTestId("day-history-day");
    await expect(days.first()).toBeVisible(); // first-ok: presence proves the grid laid out; the assertions below read ALL of them
    const panel = page.getByTestId("day-history-calendar-panel");

    // 1. THE CONTAINER FITS. The panel is the grid item that used to be sized by
    // its content; the scroller is the box that must hold everything.
    const viewport = page.viewportSize()!;
    const [panelBox, calendarBox] = await settledBoxes([panel, calendar]);
    expect(
      panelBox.x + panelBox.width,
      "the calendar panel's right edge is past the phone viewport"
    ).toBeLessThanOrEqual(viewport.width + 1);
    expect(
      calendarBox.x + calendarBox.width,
      "the calendar scroller's own right edge is past the phone viewport, so " +
        "nothing inside it can be reached by scrolling it"
    ).toBeLessThanOrEqual(viewport.width + 1);

    // 2. AND EVERY CELL IS INSIDE IT. Measured, not asserted from the container:
    // this is the reading the sweep took, and the one the fix has to move.
    const escaping = await days.evaluateAll((cells, vw) => {
      const out: string[] = [];
      for (const cell of cells) {
        const box = cell.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        if (box.right <= vw + 1) continue;
        out.push(
          `${cell.getAttribute("data-date") ?? "?"} right=${Math.round(box.right)}`
        );
      }
      return out;
    }, viewport.width);
    expect(
      escaping,
      `day-history buttons past the ${viewport.width}px viewport: ${escaping.join(", ")}`
    ).toEqual([]);

    // 3. NO CELL WAS MADE SMALLER OR MADE TO OVERLAP to buy that fit — #3712's
    // own constraint on the fix. 24px is the calendar's floor cell
    // (`CAL_CELL` in components/DayHistory.tsx, from which cells GROW toward 34
    // on a short window); the hit box adds the 3px gap the day owns, measured
    // 24x27 at the default quarter window on 2026-08-26.
    const geometry = await days.evaluateAll((cells) =>
      cells.map((cell) => {
        const box = cell.getBoundingClientRect();
        return {
          date: cell.getAttribute("data-date") ?? "?",
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
        };
      })
    );
    const undersized = geometry.filter(
      (cell) => cell.width < 24 - 0.01 || cell.height < 24 - 0.01
    );
    expect(
      undersized.map((c) => `${c.date} ${c.width}x${c.height}`),
      "a day cell rendered under the calendar's 24px floor"
    ).toEqual([]);
    const overlapping: string[] = [];
    for (let a = 0; a < geometry.length; a += 1) {
      for (let b = a + 1; b < geometry.length; b += 1) {
        const x = geometry[a],
          y = geometry[b];
        const over =
          x.left < y.right - 0.5 &&
          y.left < x.right - 0.5 &&
          x.top < y.bottom - 0.5 &&
          y.top < x.bottom - 0.5;
        if (over) overlapping.push(`${x.date} overlaps ${y.date}`);
      }
    }
    expect(
      overlapping,
      `day-history targets overlap: ${overlapping.join(", ")}`
    ).toEqual([]);

    // 4. THE SWIPE IS REAL. The whole point of a scroller that fits is that the
    // columns it cannot show are still reachable; a scroller with nothing to
    // scroll is how the defect looked from the inside.
    expect(
      await scrollableBy(calendar),
      "the calendar has no horizontal scroll range, so the week columns it " +
        "cannot fit are unreachable rather than swipeable"
    ).toBeGreaterThan(0);
  });
});

// Fixing a clip must never be paid for by letting content out of the viewport,
// which is the part the census found already correct everywhere. The blessed
// element-level guard: it names the offending box rather than asserting a
// document width the app shell clips anyway (#1543).
test.describe("no surface pays for its fix with content past the edge (#2614)", () => {
  for (const path of [
    "/",
    "/trends",
    "/sleep",
    "/import/908",
    // #3712: the day-history calendar overhung by 4px here, invisibly, because
    // `<main>`'s clip absorbed it and no page-level reading could see it.
    "/training?tab=analyze",
  ] as const) {
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

  // `overflowStory` USED TO LIVE HERE, inline, and #3395 moved it to
  // e2e/helpers.ts so the guard below can run it over every dialog body instead
  // of over this one sheet. The comment explaining what it ranks and why the
  // computed-overflow filter is load-bearing moved with it.

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

// NO DIALOG BODY OVERFLOWS SIDEWAYS, AT A COARSE-POINTER VIEWPORT (#3395).
//
// The two tests above pin ONE sheet and the HOST's refusal. Neither one would
// have caught the defect that produced this issue arriving in a different body,
// and that is the shape of the thing: `tap-target`'s `inset: -6px` hit-area
// extension is invisible three ways at once — it paints nothing, `overflow-x:
// hidden` stops it scrolling, and `<main>`'s clip hides the same shape
// everywhere a person is more likely to look. The only symptom is a dialog body
// a thumb can nudge, with (per #3360) no way back.
//
// So this runs the probe as an ASSERTION over each body, and the trigger it
// guards is not "someone adds a bad element" — it is any change that removes
// horizontal padding from a container holding a flush-edge compact control,
// which is exactly what #3361's body-chrome rule encourages.
//
// THE VIEWPORT IS WHY THIS FILE. `*.mobile.spec.ts` runs in the phone project
// with `hasTouch`, so `@media (pointer: coarse)` MATCHES and the extension is
// actually applied. At 1280×900 with a mouse there is nothing to measure: the
// rule that creates the overflow does not apply, and the same assertions pass
// while looking at a different box.
//
// TEN BODIES, AND TEN IS A CHOICE RATHER THAN WHERE THE WRITER STOPPED. The nine
// quick-entry forms plus the add-visit record dialog: one host with the app's
// widest spread of unrelated CONTENT mounted into one `data-sheet-content`, plus a
// second host reached from a real route. That is the population this defect draws
// from — bodies made largely of compact controls — and all ten share proven
// openers, so the guard costs one page load each and cannot rot into a maintenance
// tax nobody pays.
//
// Roughly thirty other ModalShell consumers are reachable in e2e and are NOT here.
// Each needs a bespoke opener, which is the cost that turns a guard into a chore,
// and a full sweep would want its own spec file — which re-partitions all twelve
// shards (below). If a body outside these ten is found overflowing, the answer is
// to add THAT body here, not to conclude the guard was wrong to stop.
//
// NO NEW SPEC FILE, deliberately. Adding one re-partitions all twelve
// duration-balanced shards and changes which neighbours every other spec runs
// beside (#3388). These belong beside the probe they use.
//
// Fixture hygiene (#868): read-only. Every case opens a sheet, measures it and
// navigates away; nothing is submitted.
test.describe("no dialog body overflows sideways at a phone viewport (#3395)", () => {
  // One host, nine bodies. The quick-entry sheet is the app's widest single
  // spread of dialog CONTENT — nine unrelated forms mounted into one
  // `data-sheet-content` — which is the right unit for a defect that belongs to
  // the body rather than to the host. Each row names a child of the MOUNTED
  // form, never the container: `quick-entry-body` renders a loading paragraph
  // while its form arrives, and a paragraph fits any width, so a check taken
  // there passes for a reason that has nothing to do with the sheet. That race
  // resolves toward the empty DOM, which fails toward GREEN — it sailed through
  // twenty-four shards on #3384 without ever examining the form it named.
  const QUICK_ENTRY_BODIES: {
    id: string;
    label: string;
    /**
     * A named child of the MOUNTED form.
     *
     * A locator factory rather than a selector string so the two rows with two
     * legitimate shapes can say `.or(...)` instead of a comma selector narrowed
     * to whichever match came first. Narrowing to the first match on a shared
     * surface is banned by the hygiene guard, and rightly: it turns "this exact
     * thing" into "whichever of these happened to render first".
     */
    ready: (sheet: Locator) => Locator;
  }[] = [
    {
      id: "log-food",
      label: "food",
      ready: (sheet) => sheet.getByTestId("food-log-bar"),
    },
    {
      id: "log-measurements",
      label: "measurements",
      ready: (sheet) => sheet.getByTestId("measurements-quick-add"),
    },
    {
      id: "log-dose",
      label: "doses",
      // Either the list or its empty state — both are the mounted form, and
      // which one the seed produces is not this guard's business.
      ready: (sheet) =>
        sheet
          .getByTestId("quick-entry-dose-list")
          .or(sheet.getByTestId("quick-entry-dose-empty")),
    },
    {
      id: "log-practice",
      label: "practices",
      ready: (sheet) => sheet.getByTestId("quick-entry-practice-list"),
    },
    {
      id: "log-mood",
      label: "mood",
      ready: (sheet) => sheet.getByTestId("quick-mood-checkin"),
    },
    {
      id: "log-period",
      label: "cycle",
      ready: (sheet) => sheet.getByTestId("quick-cycle-panel"),
    },
    {
      id: "log-stool",
      label: "stool",
      ready: (sheet) => sheet.getByTestId("quick-entry-stool"),
    },
    {
      id: "log-substance",
      label: "substances",
      ready: (sheet) =>
        sheet
          .getByTestId("quick-entry-substance-list")
          .or(sheet.getByTestId("quick-entry-substance-error")),
    },
    {
      id: "add-document",
      label: "document upload",
      ready: (sheet) => sheet.getByTestId("medical-upload-choose"),
    },
  ];

  for (const body of QUICK_ENTRY_BODIES) {
    test(`the ${body.label} sheet holds everything it contains`, async ({
      page,
    }) => {
      await page.goto(`/?quick=${body.id}`);
      const sheet = page.getByTestId("quick-entry-sheet");
      await expect(sheet).toBeVisible();

      // THE PRECONDITION, not scenery. Both halves: the placeholder is gone AND
      // a named child of the real form is on screen. The second is what carries
      // it — an absence assertion alone would be satisfied by a body that never
      // rendered the placeholder at all.
      await expect(page.getByTestId("quick-entry-loading")).toHaveCount(0);
      await expect(body.ready(sheet)).toBeVisible();

      const content = sheet.locator("[data-sheet-content]");
      await expect(content).toBeVisible();
      await expectNoEscapingOverflow(content, `the ${body.label} sheet`);
    });
  }

  test("a record dialog opened from a page holds everything it contains", async ({
    page,
  }) => {
    // A SECOND HOST ON A REAL ROUTE, not a deep link. The visit form is a
    // summary-first chip row (#3223) inside a ModalShell — a body made almost
    // entirely of compact controls, which is the population this defect draws
    // from. Same opener the convergence spec uses.
    await page.goto("/records/history/visits");
    await expect(page.getByTestId("visits-upcoming")).toBeVisible();
    await hydratedClick(page, page.getByTestId("add-visit-panel-toggle"));
    const dialog = page.getByRole("dialog", { name: "Add visit" });
    await expect(dialog).toBeVisible();
    // The chip row, not the panel — the same precondition as above, and here it
    // is the row of compact controls that has to be laid out before its extent
    // means anything.
    await expect(dialog.getByTestId("visit-fact-row")).toBeVisible();

    const content = dialog.locator("[data-sheet-content]");
    await expect(content).toBeVisible();
    await expectNoEscapingOverflow(content, "the add-visit dialog");
  });

  // PROOF THE GUARD CAN SEE, in the shape the defect actually takes. A guard
  // green over a complying tree says nothing about what it can see, and the two
  // halves of this one are separable: `expectNoEscapingOverflow` could be
  // measuring the right box and reporting the wrong element, or ranking
  // correctly over a region it never reads.
  test("the probe names a flush-edge tap-target that escapes, and stays silent on a clipped one", async ({
    page,
  }) => {
    await page.goto("/?quick=log-food");
    const sheet = page.getByTestId("quick-entry-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("food-log-bar")).toBeVisible();
    const content = sheet.locator("[data-sheet-content]");
    await expect(content).toBeVisible();

    // A clean body first — the control the guard exists for reports nothing
    // while its container gives the extension room (#3392's `pr-1.5`).
    expect(await overflowStory(content)).toBe("nothing overflows");

    // NOW REPRODUCE #3384, BY THE MECHANISM THE ISSUE NAMES: not an over-wide
    // box, but a container that LOST its horizontal room while holding a
    // flush-edge control whose hit-area extension needs it.
    //
    // The forgery has to take the room away, and that is not a workaround for the
    // guard — it is the trigger, stated. Since #3938 every control carries the
    // extension, so the room is reserved once on this region
    // (`pointer-coarse:pr-1.5` in components/BottomSheet.tsx) and a correctly
    // sized control can no longer escape a body that still has it. What CAN still
    // happen is the thing #3384 was: the reserve goes away — a refactor drops it,
    // a body re-declares its own padding — and every flush control in every
    // dialog starts pushing 6px of nothing past the edge at once. So the forgery
    // removes the reserve first, and the assertions below are then measuring the
    // real regression rather than a control nobody would write.
    await content.evaluate((node) => {
      node.style.paddingRight = "0px";
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.justifyContent = "flex-end";
      const button = document.createElement("button");
      button.setAttribute("data-testid", "e2e-flush-tap-target");
      button.className = "tap-target";
      button.style.height = "40px";
      button.style.width = "40px";
      node.appendChild(row);
      row.appendChild(button);
    });
    const story = await overflowStory(content);
    expect(
      story,
      "the probe must NAME the control, not just count pixels"
    ).toContain("e2e-flush-tap-target");
    expect(story).toMatch(/region overflows by \d+px/);
    expect(story).toMatch(/reaches \d+px past/);

    // …and the assertion built on it actually fails on this body, rather than
    // reporting a story nobody checks.
    await expect(
      expectNoEscapingOverflow(content, "the forged body")
    ).rejects.toThrow(/the forged body/);

    // SILENCE ON THE BENIGN NEIGHBOUR, which is the half that keeps the guard
    // alive. A `truncate` label overruns its own box by a mile and CLIPS every
    // pixel of it, so it can never make the region scrollable. Without the
    // computed-overflow filter three innocent labels topped this list.
    await content.evaluate((node) => {
      node.querySelector('[data-testid="e2e-flush-tap-target"]')?.remove();
      const clipped = document.createElement("div");
      clipped.setAttribute("data-testid", "e2e-clipped-label");
      clipped.className = "truncate";
      clipped.style.overflow = "hidden";
      clipped.style.whiteSpace = "nowrap";
      clipped.textContent = "an extremely long label ".repeat(20);
      node.appendChild(clipped);
    });
    expect(
      await overflowStory(content),
      "a clipped overrun is not a suspect — it cannot make the region scrollable"
    ).toBe("nothing overflows");
  });
});
