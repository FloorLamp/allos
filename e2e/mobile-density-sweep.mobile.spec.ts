import { test, expect } from "./fixtures";
import { settledBoxes } from "./helpers";
import { TAP_FLOOR_PX } from "@/lib/tap-floor-tokens";
import { NOTICE_TONE, type NoticeTone } from "@/components/Notice";
import type { Locator } from "@playwright/test";

// The phone density sweep (#3466), measured at 390×844 rather than read off a
// class list.
//
// Three spacing layers stack on this viewport — page gutter, card gutter, and
// whatever the card's contents pad AGAIN inside it. The first two are at the
// platform floor and #3466 leaves them there; the third is what steps down, along
// with the seams between page sections. So every assertion below is about a box
// against the box that CONTAINS it, read from two different elements: an inset
// compared to itself would be satisfied by any value at all, which is exactly how
// a one-gutter assertion went vacuous on a neighbouring lane the same week.
//
// The convention's DESKTOP half is not measured here and deliberately so. Every
// tier is a `max-sm:` override, so it emits only inside `@media (width < 40rem)`
// and contributes literally nothing at >=`sm`. That is a property of the compiled
// stylesheet, not of any one route, and it is checked once and structurally in
// lib/__tests__/mobile-density-convention.test.ts — where it cannot be satisfied
// by whichever 30 routes somebody remembered to look at.
//
// Fixture (#868 hygiene): READ-ONLY over the shared seed. Nothing is written and
// no seeded row is exact-counted.

// One computed length, in CSS pixels. Read from the element itself so a wrapper's
// box can never stand in for the padding being asserted.
async function px(locator: Locator, property: string): Promise<number> {
  return locator.evaluate(
    (node, prop) =>
      Number.parseFloat(getComputedStyle(node).getPropertyValue(prop)),
    property
  );
}

async function padding(locator: Locator): Promise<number[]> {
  return Promise.all(
    ["padding-top", "padding-right", "padding-bottom", "padding-left"].map(
      (p) => px(locator, p)
    )
  );
}

// A row IS the target on the hover-fill list idiom, so its own rendered height
// must meet the shared #3514 floor.

test("class A: a sub-panel inside a card pads less than the card does (#3466)", async ({
  page,
}) => {
  test.slow(); // next dev compiles the route on first hit
  await page.goto("/longevity");
  const main = page.getByRole("main");

  // WAIT FOR THE CONTENT, NOT THE CONTAINER. The pillar's own value is what makes
  // the box the size it is; a box measured before its contents arrive is a
  // measurement of a placeholder.
  const pillar = main.getByTestId("longevity-pillar-vo2max");
  await expect(
    pillar.getByTestId("longevity-pillar-vo2max-value")
  ).toBeVisible();

  // The pillar box is `p-2.5` (10px) on desktop and steps to 8 here — VERTICALLY.
  // #3673 took the horizontal half off every tier: the card below it spends no
  // inline gutter any more, so a sub-panel that still stepped its own `px` would
  // be the only thing left holding the page's text off the page gutter.
  const inset = await padding(pillar);
  expect(inset).toEqual([8, 0, 8, 0]);

  // …inside a card that keeps its #1416 vertical floor of 16 and spends the page
  // gutter horizontally: since #3920 the card's fill reaches the viewport edge and
  // re-spends that gutter inside itself, so there is still exactly ONE horizontal
  // inset between the viewport and this text — the card's. The card is a DIFFERENT
  // element, which is what makes this a comparison rather than a tautology.
  const card = main
    .getByTestId("longevity-fitness")
    .locator("xpath=ancestor-or-self::*[contains(@class,'card')][1]");
  const cardInset = await padding(card);
  expect(cardInset).toEqual([16, 16, 16, 16]);
  // The vertical step is still a step, and the sub-panel adds no second gutter to
  // the card's one: its box starts exactly where the card's content does.
  expect(inset[0]).toBeLessThan(cardInset[0]);
  const [pillarBox, cardBox] = await settledBoxes([pillar, card]);
  expect(pillarBox.x).toBe(cardBox.x + cardInset[3]);

  // The box did not become a worse target for being tighter.
  const box = await pillar.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
});

test("class C: a section seam is one notch tighter ON SCREEN, not just in the cascade (#3466)", async ({
  page,
}) => {
  test.slow();
  await page.goto("/longevity");
  const main = page.getByRole("main");

  const hero = main.getByTestId("bio-age-hero");
  await expect(hero.getByTestId("bio-age-value")).toBeVisible();

  // THE COMPUTED VALUE IS NOT THE SEAM, and this test used to assert only the
  // computed value — which passed identically whether the step reached the screen
  // or not. It did not: `bio-age-hero` is the ONLY child of its section, so its
  // bottom margin collapses straight through and meets the next stack sibling's
  // margin-top. Adjacent margins collapse to the LARGER, so a 16 that lands beside
  // an un-stepped 24 renders 24 and the computed 16 is a fact about the cascade
  // that no reader can see. `app/(app)/longevity/page.tsx`'s stack is stepped too
  // now, and the assertion below is the one that would have caught it.
  expect(await px(hero, "margin-bottom")).toBe(16);

  // The RENDERED gap, measured from the element that CARRIES the seam to the next
  // section — not from the wrapper around it. The wrapper (`longevity-bio-age`)
  // has no padding or border of its own today, so reading off it would give the
  // same number; but that is an UNPINNED PREMISE of exactly the shape this file
  // already refuses to accept on a card's own `p-0!` gutter. Give that wrapper a
  // `pb-2` and a wrapper-based reading still says 16 while the reader sees 24.
  // Measuring from the seam's own element needs no premise: whatever any ancestor
  // adds lands INSIDE the quantity and the assertion fails, which is what tight
  // means. Read with settledBoxes rather than two independent boundingBox calls,
  // which can describe a layout that never existed.
  const [heroBox, fitnessBox] = await settledBoxes([
    hero,
    main.getByTestId("longevity-fitness"),
  ]);
  const renderedGap = fitnessBox.y - (heroBox.y + heroBox.height);
  // An equality, not a ceiling: `<= 24` would also pass on a seam collapsed to
  // nothing, and `>= 16` would pass on the 24 this test exists to reject.
  //
  // ATTRIBUTION, because this number has TWO causes. Adjacent margins collapse to
  // the larger, so the gap reads 24 if EITHER the seam or the stack it lands
  // beside is unstepped — one mutant cannot tell those apart. The retained
  // `margin-bottom` assertion above is the discriminator: it fires only when the
  // SEAM is the missing half, and stays green when the STACK is. Both mutants are
  // run separately; see the PR.
  expect(renderedGap).toBe(16);
});

test("class A + the tap floor: appointment rows tighten without shrinking (#3466)", async ({
  page,
}) => {
  test.slow();
  await page.goto("/appointments");
  const main = page.getByRole("main");

  const row = main.getByTestId("appointment-row").first(); // first-ok: every row is the same component; the assertion is about the shape, not this appointment
  // The row's own title is the content the box is sized around.
  await expect(row).toBeVisible();
  await expect(row.locator("span").first()).toBeVisible(); // first-ok: the leading span is the row's title

  // `p-3` (12) on desktop, 10 here — and no horizontal gutter at all since #3673,
  // which is what puts the row's first character on the page gutter with every
  // other line on the page.
  expect(await padding(row)).toEqual([10, 0, 10, 0]);

  // And it is still a target. This is the acceptance criterion "no tap target
  // shrinks below 40px", asserted where the padding actually moved.
  const box = await row.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
});

test("class B: /data draws one border around each integration, not two (#3466)", async ({
  page,
}) => {
  test.slow();
  await page.goto("/data?section=import");
  const main = page.getByRole("main");

  const wrapper = main.locator("#integrations");
  const grid = wrapper.getByTestId("grid-available");
  // Wait for a real card inside the grid — the grid element exists before the
  // registry's cards do, and an empty grid would satisfy anything measured on it.
  const card = grid.getByTestId("integration-card-garmin");
  await expect(card).toBeVisible();

  // NEITHER draws one at 390px since #3673, and that is the whole ruling rather
  // than this test going quiet: the wrapper never should have (the #3466 nest),
  // and the card gives its frame up on a phone. What still separates one source
  // from the next is the card's own `--surface` fill against the page canvas —
  // asserted here, because "no border anywhere" alone is also what a card that
  // vanished into the background would report.
  expect(await px(card, "border-top-width")).toBe(0);
  expect(await px(wrapper, "border-top-width")).toBe(0);
  expect(await px(card, "border-top-left-radius")).toBe(0);
  const cardFill = await card.evaluate(
    (node) => getComputedStyle(node).backgroundColor
  );
  const canvas = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor
  );
  expect(cardFill).not.toBe(canvas);
  expect(cardFill).not.toBe("rgba(0, 0, 0, 0)");
  // …the wrapper spends no gutter of its own, which is the phone half of it, and
  // the card spends exactly one — its fill running edge to edge with the page
  // gutter re-spent inside it (#3920), on a route that is not the dashboard.
  expect(await padding(wrapper)).toEqual([0, 0, 0, 0]);
  expect(await px(card, "padding-left")).toBe(16);
  const fill = await card.boundingBox();
  expect([fill?.x, (fill?.x ?? 0) + (fill?.width ?? 0)]).toEqual([0, 390]);
});

// ── #3673: below `sm`, no card draws a frame ─────────────────────────────────
//
// The page gutter, once, and nothing else. `PAGE_GUTTER_PX` is the shell's own
// `pl-[max(1rem,env(safe-area-inset-left))]` on `app-content-container`, read here
// as the number every band, row and zone label must start at; `CONTENT_PX` is what
// a text line then gets on this viewport. Both are stated as what they measure
// rather than left as literals: 390 − 2×16 = 358, which is 91.8% of the viewport,
// against the 326px (83.6%) a framed card left it at (390 − 16 page − 16 card, both
// sides). That +32 is the reclaimed inset the issue's arithmetic names.
const PAGE_GUTTER_PX = 16;
const VIEWPORT_PX = 390;
const CONTENT_PX = VIEWPORT_PX - 2 * PAGE_GUTTER_PX;

// A CARD FRAME, as a browser draws one rather than as a class list spells it: a
// block box carrying BOTH a border and a corner radius, wide enough to be setting
// the page's left rag. Four silences are part of the definition and each one is a
// shape that ships today and is correct — a guard that cried wolf on any of them
// would be deleted within a week, taking the real guard with it:
//
//   * a CONTROL, and a box whose every child is a control (a segmented toggle).
//     Object-ness moved to the affordance; a button that stopped looking like a
//     button would be the sweep eating its own ruling.
//   * a PILL — radius at or past half the height. A badge or a chip is not a card.
//   * a MARK — anything narrower than half the content line. An adherence day cell
//     and a dashed legend swatch both draw a bordered rounded box and neither is a
//     frame around content; what this ban is about is the layer that pushed a text
//     line off the page gutter, and a 45px box is not in that layer.
//   * a NOTICE. Recognised by `data-notice`, which only `components/Notice.tsx`'s
//     exported primitive and its FindingCard sibling (built on the same closed
//     NOTICE_TONE map) emit. That is MODULE IDENTITY: there is no path list, no
//     testid list and no source match anywhere in this rule, and a surface joins
//     the exception by being RENDERED THROUGH one of those two components rather
//     than by being written down here. Not by "being a Notice" in the looser
//     sense: six other files import NOTICE_TONE and hand-roll the same markup
//     without going through either, and none of them emits the marker or is
//     forgiven by this rule (lib/__tests__/notice-block.test.ts carries that
//     list). Below `sm` an `embedded` FindingCard emits it too, because at that
//     width it draws the tinted frame its container no longer does (#3897).
//
// `forgeTestid` is the positive control's hook: the offender is created, scanned
// for and removed INSIDE this one evaluate. It used to be appended by a separate
// round trip, which is a race — a React re-render between the append and the scan
// takes the node with it and the control reports "the sweep saw nothing" as a
// FAILED DETECTION. That is the worst direction for a positive control to fail in,
// because the reading it invites is "the rule is broken" rather than "the node was
// never there". One evaluate leaves React no tick to intervene in, and the
// forgery cannot outlive the measurement it exists for.
async function cardFrames(
  page: import("@playwright/test").Page,
  forgeTestid?: string
) {
  return page.evaluate(
    ([contentPx, forge]: [number, string | undefined]) => {
      const found: string[] = [];
      const main = document.querySelector("main");
      if (!main) throw new Error("no <main> to sweep");
      let forged: HTMLElement | null = null;
      if (forge) {
        forged = document.createElement("div");
        forged.dataset.testid = forge;
        forged.style.cssText =
          "border:1.5px solid #888;border-radius:14px;padding:16px;height:80px";
        forged.textContent = "FORGED BY A SPEC on purpose — not a shipped card";
        main.append(forged);
      }
      for (const el of main.querySelectorAll<HTMLElement>("*")) {
        const style = getComputedStyle(el);
        const border = Number.parseFloat(style.borderTopWidth);
        const radius = Number.parseFloat(style.borderTopLeftRadius);
        if (!(border >= 1 && radius > 0)) continue;
        const box = el.getBoundingClientRect();
        if (!box.height || !box.width) continue;
        if (radius * 2 >= box.height) continue;
        if (box.width < contentPx / 2) continue;
        if (style.display.startsWith("inline")) continue;
        if (
          el.closest(
            "button,a,input,select,textarea,summary,label,[role='button'],[role='tab'],[role='switch'],[contenteditable]"
          )
        )
          continue;
        const children = [...el.children];
        if (
          children.length > 0 &&
          children.every((child) =>
            child.matches("button,a,input,select,label,[role='button']")
          )
        )
          continue;
        if (el.closest("[data-notice]")) continue;
        found.push(
          `${el.tagName}${el.dataset.testid ? `[${el.dataset.testid}]` : ""} border=${border} radius=${radius} class="${el.className}"`
        );
      }
      forged?.remove();
      return found;
    },
    [CONTENT_PX, forgeTestid] as [number, string | undefined]
  );
}

// Every element that draws a band or a row: the card primitives, the bands, and
// the stacked rows. Their CONTENT left edge is the page's left rag, and the set of
// distinct values it takes is the "one left edge" property, measured.
const BAND_SELECTOR =
  "main .card, main .card-quiet, main .band, main .table-cards tr";

async function contentEdges(page: import("@playwright/test").Page) {
  return page.evaluate((selector) => {
    const edges = new Map<string, number>();
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      if (!box.width) continue;
      const left = Math.round(box.left + Number.parseFloat(style.paddingLeft));
      const width = Math.round(
        box.width -
          Number.parseFloat(style.paddingLeft) -
          Number.parseFloat(style.paddingRight)
      );
      const key = `${left}/${width}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    // Sorted, because the assertion is about the SET of values and Map order is
    // DOM order — which would make the expectation depend on which band happens
    // to render first.
    return [...edges]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, BAND_SELECTOR);
}

// ── #3920: the fill is full-bleed, the content keeps the gutter ──────────────
//
// #3673's criterion measured a text run against the VIEWPORT and never against
// the fill it sits inside, and the defect it missed satisfies it exactly: with the
// card's padding gone and its `--surface` fill still inset by the page gutter, the
// text is at 16px AND flush against its own edge. So the criterion gains its other
// half rather than being replaced — every run still starts at the page gutter, and
// where it sits on a band's fill that fill reaches at least a gutter further left.
//
// The nearest FILLED band is what a run sits on; an unfilled row inside a filled
// card resolves to the card, which is the surface a reader actually sees under it.
const FILL_SELECTOR =
  "main .card, main .card-quiet, main .band, main .subpanel-inset, main .subpanel-inset-sm, main .subpanel-inset-xs";

// ── #3920 scope: FULL-BLEED IS AGAINST THE PAGE, OR IT IS NOT A BLEED ────────
//
// The cancel is a negative margin, and a negative margin does not know what it is
// escaping: it pulls the same 16px whether the box above is the page container or
// a grid cell that owns its own width. So a filled surface has exactly TWO legal
// shapes below `sm` and there is no third — it either spans the viewport, or it
// sits exactly inside the box that placed it. A card 32px wider than the cell it
// was placed in is the third state, and #3931 is what it looks like from outside:
// a census tile and its non-card picker peer stopped being the same size.
//
// STATED AS A LAW RATHER THAN A LIST, because the container that must opt out is
// not knowable from a selector — `main .card` inside a two-column census grid and
// `main .card` inside a page section are the same query. What separates them is
// where the box lands, which is the thing this reads.
async function misplacedBleeds(
  page: import("@playwright/test").Page,
  viewport: number
) {
  return page.evaluate(
    ([selector, width]: [string, number]) => {
      const offenders: string[] = [];
      const round = (value: number) => Math.round(value * 10) / 10;
      for (const el of document.querySelectorAll<HTMLElement>(selector)) {
        const box = el.getBoundingClientRect();
        const parent = el.parentElement;
        if (!box.width || !box.height || !parent) continue;
        const style = getComputedStyle(parent);
        const placed = parent.getBoundingClientRect();
        const left =
          placed.left +
          Number.parseFloat(style.borderLeftWidth) +
          Number.parseFloat(style.paddingLeft);
        const right =
          placed.right -
          Number.parseFloat(style.borderRightWidth) -
          Number.parseFloat(style.paddingRight);
        const bleeds =
          Math.abs(box.left) < 0.5 && Math.abs(box.right - width) < 0.5;
        const placedExactly =
          Math.abs(box.left - left) < 0.5 && Math.abs(box.right - right) < 0.5;
        if (bleeds || placedExactly) continue;
        offenders.push(
          `${el.tagName}${el.dataset.testid ? `[${el.dataset.testid}]` : ""} box ${round(box.left)}→${round(box.right)} is neither the viewport nor its parent's content box ${round(left)}→${round(right)} — class="${el.className}"`
        );
      }
      return offenders;
    },
    [FILL_SELECTOR, viewport] as [string, number]
  );
}

async function runsFlushWithTheirFill(
  page: import("@playwright/test").Page,
  gutter: number
) {
  return page.evaluate(
    ([selector, minimum]: [string, number]) => {
      const main = document.querySelector("main");
      if (!main) throw new Error("no <main> to sweep");
      const painted = (el: HTMLElement) => {
        const fill = getComputedStyle(el).backgroundColor;
        return fill !== "rgba(0, 0, 0, 0)" && fill !== "transparent";
      };
      const flush: string[] = [];
      const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue?.trim()) continue;
        let fill: HTMLElement | null = node.parentElement;
        while (fill && !(fill.matches(selector) && painted(fill)))
          fill = fill.parentElement;
        if (!fill) continue;
        // AN `sr-only` RUN HAS NO LEFT EDGE A READER CAN SEE, and it is the one
        // false positive this sweep meets: `sr-only` clips its host to a 1×1 box
        // and pulls it back by `margin: -1px`, so the range inside it reports its
        // full unclipped width one pixel LEFT of the gutter. Recognised by the
        // host box, not by the class name — DiagnosisChips, RecapLineAtom and the
        // Standing deltas each spell their own hidden label.
        let hidden = false;
        for (let el = node.parentElement; el; el = el.parentElement) {
          const host = el.getBoundingClientRect();
          if (host.width <= 1 || host.height <= 1) hidden = true;
          if (el === fill) break;
        }
        if (hidden) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const run = range.getBoundingClientRect();
        if (run.width < 2 || run.height < 2) continue;
        const clear = run.left - fill.getBoundingClientRect().left;
        if (clear + 0.5 >= minimum) continue;
        flush.push(
          `${clear}px of fill left of "${node.nodeValue.trim().slice(0, 40)}" on ${
            fill.tagName
          }${fill.dataset.testid ? `[${fill.dataset.testid}]` : ""} class="${fill.className}"`
        );
      }
      return flush;
    },
    [FILL_SELECTOR, gutter] as [string, number]
  );
}

// The three surfaces the ruling names, with the content marker each one must be
// waited for. A region measured before its rows arrive is a measurement of a
// placeholder, and empty is the state that flatters every assertion below.
const SWEPT = [
  ["the record", "/history", "history-feed"],
  ["a Records pane", "/records", "records-visits"],
  ["the dashboard", "/", "dashboard-standing"],
  // The census grid is the one surface on this list whose cards are placed into
  // TRACKS rather than stacked down the page, and it is where #3931 was found.
  ["the Body census", "/trends", "body-metric-tiles"],
] as const;

for (const [what, route, marker] of SWEPT) {
  test(`#3673 flat ban: no card frame renders on ${what} at 390px`, async ({
    page,
  }) => {
    test.slow();
    await page.goto(route);
    await expect(page.getByTestId(marker)).toBeVisible();

    expect(await cardFrames(page)).toEqual([]);

    // Nesting stays banned, and a band inside a band is the same defect as a card
    // in a card — read off the rendered tree, not off a source scan. `.band` is
    // NOT a container claim (it also marks each element that spends the frame's
    // gutter, so a band legitimately contains its own marked rows); what may never
    // happen is one FILLED surface inside another, which is the cross product of
    // the card primitives with the band's frame.
    const nested = await page.evaluate(
      () =>
        document.querySelectorAll(
          "main .card .card, main .card .card-quiet, main .card-quiet .card, main .card-quiet .card-quiet, main .card .band, main .card-quiet .band"
        ).length
    );
    expect(nested).toBe(0);

    // #3920: a full-bleed fill is only safe because `<main>` carries
    // `overflow-x-clip` — asserted here rather than assumed, on the page's own
    // scroller, because a pull that over-cancels shows up as sideways scroll
    // before it shows up as anything a reader could name.
    expect(
      await page.evaluate(() => [
        document.scrollingElement?.scrollWidth,
        window.innerWidth,
      ])
    ).toEqual([VIEWPORT_PX, VIEWPORT_PX]);

    // #3931: and every fill is bleeding against the PAGE or not bleeding at all.
    expect(await misplacedBleeds(page, VIEWPORT_PX)).toEqual([]);

    // #3920 on every swept route, not only the dashboard: a container that opts
    // out of the bleed must not take the card's own gutter with it, and this is
    // the assertion that says so — the tile inside a `bleed-none` grid still owes
    // its first character a gutter's width of its own fill.
    expect(await runsFlushWithTheirFill(page, PAGE_GUTTER_PX)).toEqual([]);
  });
}

test("#3673 the sweep can SEE a frame, and stays quiet on the Notice that keeps one", async ({
  page,
}) => {
  test.slow();
  // A green sweep over a COMPLYING tree says nothing about what the sweep can see.
  // This route is the one that renders a real tinted Notice, so both halves are
  // asked of the same DOM: the forged offender must be caught, and the shipped
  // safety notice beside it must not be.
  await page.goto("/nutrition?tab=supplements");
  const notice = page.locator("[data-notice='amber']").first(); // first-ok: every Notice is the same primitive; the assertion is about the shape
  await expect(notice).toBeVisible();
  expect(await cardFrames(page)).toEqual([]);

  const forged = "forged-card-frame";
  const caught = await cardFrames(page, forged);
  expect(caught.join(" ")).toContain(forged);
  // …and exactly one thing was caught: the Notice on the same page is still silent.
  expect(caught).toHaveLength(1);
});

test("#3673 one left edge, and the line it reclaims", async ({ page }) => {
  test.slow();
  // The dashboard is the scroll that mixes zones, bands, reporting rows and
  // action-bearing rows — the surface the left-edge ruling was decided on.
  await page.goto("/");
  await expect(page.getByTestId("dashboard-standing")).toBeVisible();
  await expect(page.getByTestId("now-strip")).toBeVisible();

  // TWO values, both named, neither a range. `16/358` is the gutter a band's rows
  // and labels spend; `0/390` is the FRAME that delegates its gutter to them and
  // since #3920 reaches the viewport edge to do it. The third is Attention's 4px edge.
  expect(await contentEdges(page)).toEqual([
    { key: `0/${VIEWPORT_PX}`, count: expect.any(Number) },
    { key: `${PAGE_GUTTER_PX}/${CONTENT_PX}`, count: expect.any(Number) },
    {
      key: `${PAGE_GUTTER_PX + 4}/${CONTENT_PX - 4}`,
      count: expect.any(Number),
    },
  ]);

  // …AND THE HALF #3673 COULD NOT SEE (#3920). The line above is satisfied by the
  // broken rendering — text at 16 on a fill that also starts at 16 — so this is
  // the assertion that fails on it: nothing sits on a fill it is flush against.
  expect(await runsFlushWithTheirFill(page, PAGE_GUTTER_PX)).toEqual([]);

  // Zone labels sit on the same rag as the bands they head.
  const labels = await page.evaluate(() =>
    [
      ...new Set(
        [...document.querySelectorAll<HTMLElement>("main h2")].map((el) =>
          Math.round(el.getBoundingClientRect().left)
        )
      ),
    ].sort((a, b) => a - b)
  );
  expect(labels).toEqual([PAGE_GUTTER_PX]);

  // The dividend, asserted rather than screenshotted: 358/390 = 91.8%, which is
  // the ~92% the issue names, up from the 326/390 = 83.6% a framed card left.
  // Rounded to whole percent so the assertion says the quantity the ruling does.
  expect(Math.round((CONTENT_PX / VIEWPORT_PX) * 100)).toBe(92);
  // The widest CONTENT line is the dividend; the widest FILL is the viewport,
  // which is the #3920 half. Read from the same set in one pass so the two
  // numbers describe one layout rather than two round-trips.
  const [widestContent, widestFill] = await page.evaluate(
    ([selector, gutter]: [string, number]) => {
      const boxes = [...document.querySelectorAll<HTMLElement>(selector)].map(
        (el) => {
          const style = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          const lead = Number.parseFloat(style.paddingLeft);
          return {
            content: box.width - lead - Number.parseFloat(style.paddingRight),
            fill: box.width,
            // A frame that DELEGATES its gutter has no content line of its own —
            // its rows do — so it is a fill here and not a line.
            spends: Math.round(box.left + lead) === gutter,
          };
        }
      );
      return [
        Math.max(...boxes.filter((b) => b.spends).map((b) => b.content)),
        Math.max(...boxes.map((b) => b.fill)),
      ];
    },
    [BAND_SELECTOR, PAGE_GUTTER_PX] as [string, number]
  );
  expect(widestContent).toBe(CONTENT_PX);
  expect(widestFill).toBe(VIEWPORT_PX);
});

// The three surfaces #3920 names, measured one at a time so a red says WHICH one
// moved: the fill spans the viewport and the first character sits on the page
// gutter. `contentEdges` above reads padding and this reads a rendered Range, so
// a band whose gutter came back as a margin instead of padding is caught by one
// and not the other.
const FULL_BLEED_SURFACES = [
  ["the Standing cluster", '[data-testid="dashboard-standing"]'],
  ["its section label strip", "[data-standing-section] h3"],
  ["an Ahead card", "[data-ahead-bucket]"],
] as const;

test("#3920 the fill reaches both edges and the first character does not", async ({
  page,
}) => {
  test.slow();
  await page.goto("/");
  await expect(page.getByTestId("dashboard-standing")).toBeVisible();
  await expect(page.getByTestId("dashboard-ahead")).toBeVisible();

  const measured = await page.evaluate(
    (surfaces) =>
      surfaces.map(([what, selector]) => {
        const el = document.querySelector<HTMLElement>(`main ${selector}`);
        if (!el) return [what, "absent"] as const;
        const box = el.getBoundingClientRect();
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let first = Number.NaN;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.nodeValue?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const run = range.getBoundingClientRect();
          if (run.width < 2 || run.height < 2) continue;
          first = Math.round(run.left);
          break;
        }
        return [
          what,
          `fill ${Math.round(box.left)}→${Math.round(box.right)}, first character ${first}`,
        ] as const;
      }),
    FULL_BLEED_SURFACES as unknown as [string, string][]
  );

  expect(measured).toEqual(
    FULL_BLEED_SURFACES.map(([what]) => [
      what,
      `fill 0→${VIEWPORT_PX}, first character ${
        what === "the Standing cluster" ? PAGE_GUTTER_PX + 4 : PAGE_GUTTER_PX
      }`,
    ])
  );
});

// ONE SIDE ONLY, AND LARGER THAN THE FLOOR. The shell spends
// `max(1rem, env(safe-area-inset-left))` and `…-right` INDEPENDENTLY, so a cancel
// written as a symmetric `-mx-4` passes at the default inset (both sides 1rem) and
// under-cancels the notched side by whatever the inset exceeds it — a visible step
// exactly where the fill was meant to reach the edge, on the one device class that
// cannot be seen in the default emulator. Both halves read the same
// `--page-gutter-left` token, so overriding it here moves the shell's gutter and
// the band's cancel together; an implementation that assumed `1rem` moves only one.
const SIMULATED_INSET_PX = 40;

test("#3920 a one-sided safe-area inset leaves no gap and no overhang", async ({
  page,
}) => {
  test.slow();
  await page.goto("/");
  await expect(page.getByTestId("dashboard-standing")).toBeVisible();

  await page.addStyleTag({
    content: `:root { --page-gutter-left: ${SIMULATED_INSET_PX}px; }`,
  });
  // The shell really did take the inset, and only on one side — otherwise the
  // measurement below is of the default case wearing this test's name.
  const container = page.getByTestId("app-content-container");
  expect(await padding(container)).toEqual([
    expect.any(Number),
    PAGE_GUTTER_PX,
    expect.any(Number),
    SIMULATED_INSET_PX,
  ]);

  const edges = await page.evaluate(
    (selector) =>
      [...document.querySelectorAll<HTMLElement>(selector)]
        .filter((el) => el.getBoundingClientRect().width)
        .map((el) => {
          const box = el.getBoundingClientRect();
          return `${Math.round(box.left)}→${Math.round(box.right)}`;
        }),
    'main [data-testid="dashboard-standing"], main [data-ahead-bucket], main .card'
  );
  expect(edges.length).toBeGreaterThan(0);
  expect([...new Set(edges)]).toEqual([`0→${VIEWPORT_PX}`]);
});

test("#3932 a filled sub-panel cancels and re-spends its card gutter only below sm", async ({
  page,
}) => {
  await page.goto("/settings/server");
  const card = page.getByTestId("backup-settings");
  const panel = page.getByTestId("backup-integrity");
  await expect(panel).toBeVisible();

  await page.addStyleTag({
    content: `:root { --page-gutter-left: ${SIMULATED_INSET_PX}px; }`,
  });
  const [cardBox, panelBox] = await settledBoxes([card, panel]);
  expect([panelBox.x, panelBox.x + panelBox.width]).toEqual([
    cardBox.x,
    cardBox.x + cardBox.width,
  ]);
  expect(await padding(panel)).toEqual([
    10,
    PAGE_GUTTER_PX,
    10,
    SIMULATED_INSET_PX,
  ]);

  const unfilledPadding = await card.evaluate((host) => {
    const probe = document.createElement("div");
    probe.className = "subpanel-inset-sm p-3 hover:bg-slate-50";
    host.append(probe);
    const style = getComputedStyle(probe);
    const result = [style.paddingRight, style.paddingLeft];
    probe.remove();
    return result;
  });
  expect(unfilledPadding).toEqual(["0px", "0px"]);

  await page.setViewportSize({ width: 640, height: 844 });
  expect(await padding(panel)).toEqual([12, 12, 12, 12]);
  expect(await px(panel, "margin-left")).toBe(0);
});

test("#3673 the record's band bleeds and its rows keep the gutter", async ({
  page,
}) => {
  test.slow();
  await page.goto("/history");
  const list = page.locator('[data-testid="history-rows"]').first(); // first-ok: every day's list is the same primitive
  await expect(list).toBeVisible();
  const row = list.locator('[data-testid="history-row"]').first(); // first-ok: every row is the same primitive

  // THE TWO HALVES ARE DIFFERENT BOXES, and that is the whole #3920 shape: the FILL
  // reaches the viewport edge while the CONTENT starts at the page gutter. Asserting
  // one alone passes on both of the broken trees — a framed band that never bled, and
  // a bled band whose first character sat flush against the screen.
  const fill = await list.boundingBox();
  expect(Math.round(fill?.x ?? -1)).toBe(0);
  expect(Math.round(fill?.width ?? 0)).toBe(VIEWPORT_PX);

  const content = await row.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return Math.round(range.getBoundingClientRect().left);
  });
  expect(content).toBe(PAGE_GUTTER_PX);
  // The row still meets the tap floor it met when a card was drawing its gutter.
  const box = await row.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
});

// ── EMPHASIS DOES NOT FLATTEN, ACROSS THE FAMILY ────────────────────────────
//
// The invariant that made the Notice the one exception: with every neutral frame
// gone it is the loudest shape the app still has, and a safety or refusal surface
// that reads no louder than an ordinary row is a failed sweep. Proving that for
// ONE tone proves it for one tone — and the tone the invariant is really about is
// a refusal, not a warning.
//
// So the table is keyed by `NoticeTone` and the tones come from the primitive's own
// export. That is a COMPILE-TIME census: add a tone to `NOTICE_TONE` and this file
// stops typechecking until somebody says where it is reachable or why it is not.
// Nobody has to remember, and the runtime check below catches the other direction
// (a tone REMOVED from the export while an entry here still names it).
type ToneSurface =
  | { route: string; locator: string; what: string; expand?: string }
  // `offPrimitive` is what turns "I checked and there is none" from prose into an
  // assertion, in BOTH directions. Each entry is a read-path route where the tone
  // demonstrably renders but never through Notice or FindingCard:
  //   `arrived`  — a marker proving the route rendered. An absence assertion goes
  //     green the instant a page 404s or a `<main>` never arrives, which is the
  //     fail-open this file refuses to accept anywhere else.
  //   `open`/`settled` — the launcher to click and the panel to wait for, where
  //     there IS a door. An absence behind a closed one is not an absence. Manage
  //     lost its door (#3987 phase 2): its suggestions are rows on the page, so
  //     `arrived` is the only gate that entry needs and both fields are omitted.
  //   `block`    — a selector for the tone's own hand-rolled box. Asserted
  //     PRESENT, which is what stops the marker check below from passing because
  //     there was nothing there to mark.
  | {
      unreachable: string;
      offPrimitive?: readonly {
        route: string;
        arrived: string;
        open?: string;
        settled?: string;
        block: string;
      }[];
    };

const TONE_SURFACES: Record<NoticeTone, ToneSurface> = {
  // SAFETY — a nutrient over its upper limit.
  amber: {
    route: "/nutrition?tab=supplements",
    locator: '[data-testid="ul-warning-magnesium"]',
    what: "a safety warning",
  },
  // REFUSAL — the case this invariant exists for: a connection the app can no
  // longer use, which has nothing else to reach for now that frames are gone.
  rose: {
    route: "/integrations/withings",
    locator: '[data-testid="withings-needs-reauth"]',
    what: "a refused connection",
  },
  // INFORMATIONAL — the quiet end of the family, included because "the Notice is
  // louder" must hold for the whole family or the family is not the exception.
  slate: {
    route: "/nutrition?tab=supplements",
    locator: '[data-testid="rda-adequacy-calcium"]',
    what: "an adequacy note",
  },
  // PHARMACOGENOMIC — the CPIC note inside the medication safety strip, which is
  // a FindingCard on the same closed NOTICE_TONE map. This entry used to read
  // "exported by NOTICE_TONE; no call site renders it", and that was FALSE:
  // components/IntakeWarnings.tsx has rendered a violet finding since #710, and
  // components/intake/IntakeInteractionNotices.tsx hand-rolls a second violet
  // block on the medication add form. A negative that is wrong is worse than a
  // gap, because it is the form this census reports a negative IN.
  //
  // The strip is a <details> that auto-opens only at ≤2 findings and the shared
  // seed carries more, so this row opens it — the one row that needs a step, and
  // it is a client disclosure toggle, not a write.
  violet: {
    route: "/medications",
    expand: "intake-warnings",
    locator: '[data-testid^="pgx-warning-"]',
    what: "a pharmacogenomic note",
  },
  // I CHECKED, AND THERE IS NONE reachable here — not "I did not check". Emerald
  // has two kinds of call site and NEITHER is reachable read-only. Most are a
  // TRANSIENT SUCCESS produced by a write (a completed fitness check, a freshly
  // created share link, a reprocess diff) and this file is read-only over the
  // shared seed (#868). The other two — CuratedSupplementSuggestions.tsx and
  // FoodSuggestions.tsx — are server-rendered on READ paths, so the "only after a
  // write" reason this entry used to give was wrong; they are unreachable because
  // the shared seed produces no suggestion for either. That half is a fact about
  // the SEED, stated here so a seed change cannot falsify this row silently.
  // NOT "NOTHING RENDERS IT" — "NOTHING RENDERS IT THROUGH THE PRIMITIVE", and
  // the distinction is the whole entry. This row used to say emerald was only a
  // transient success after a write; then it said the two read-path suggestion
  // blocks exist but the shared seed produces none of them. BOTH were false, and
  // the second was inherited from an adversarial review that had asserted it.
  // Measured at 390px on the shared seed: /nutrition?tab=supplements renders TWO
  // curated supplement suggestions (as rows, since #3987 phase 2 — no launcher, no
  // modal) and /nutrition renders food suggestions, each
  // an emerald-tinted `rounded-lg border` box — `bg rgb(216, 233, 207)`, border
  // 1px, radius 8px — and every one of them has `data-notice === null`.
  //
  // So the tone is reachable and the NOTICE-FAMILY SHAPE is not. Both call sites
  // are among the six files that hand-roll NOTICE_TONE without going through
  // Notice or FindingCard, so there is no `data-notice="emerald"` surface for the
  // loudness comparison to read. That reason does not rest on the seed, which is
  // why it replaced one that did — and the probe below asserts both of its halves,
  // so it goes red if the blocks disappear AND if they ever gain the marker. The
  // second is the good failure: it means emerald has become reachable through the
  // primitive and belongs above as a row with a real surface.
  emerald: {
    unreachable:
      "renders on read paths but never THROUGH the primitive: CuratedSupplementSuggestions and FoodSuggestions both paint NOTICE_TONE.emerald on the shared seed, and both hand-roll it, so no emerald surface carries data-notice; every emerald that does go through Notice is a transient success after a write, and this file is read-only (#868)",
    offPrimitive: [
      {
        route: "/nutrition?tab=supplements",
        arrived: "supplement-suggestions",
        block: '[data-testid^="curated-supplement-suggestion-"]',
      },
      {
        route: "/nutrition",
        arrived: "food-log-shell",
        open: "nutrition-suggestions-summary",
        settled: "nutrition-suggestions-panel",
        // `add` is the emerald direction; a `reduce` suggestion takes the amber
        // tint from the same map, and would prove nothing about this row.
        block: '[data-testid^="food-suggestion-"][data-direction="add"]',
      },
    ],
  },
  // I CHECKED, AND NOTHING RENDERS THIS. Exported by NOTICE_TONE and no call site
  // in app/ or components/ passes it: `git grep 'NOTICE_TONE.sky'` and
  // `git grep 'tone="sky"'` are both empty against the Notice/FindingCard tone
  // type. Nothing to reach, rather than something reachable that was skipped.
  sky: { unreachable: "exported by NOTICE_TONE; no call site renders it" },
};

const REACHABLE_TONES = (
  Object.entries(TONE_SURFACES) as [NoticeTone, ToneSurface][]
).flatMap(([tone, surface]) =>
  "route" in surface ? [[tone, surface] as const] : []
);

// Open a native <details> disclosure if it is not already open. A pure client
// toggle — no Server-Action POST to await — and a no-op when the surface behind it
// is already showing, so a seed that changes the finding count cannot turn this
// into a click that CLOSES the thing the test is about.
async function openDisclosure(
  page: import("@playwright/test").Page,
  testid: string
) {
  const details = page.getByTestId(testid);
  await expect(details).toBeVisible();
  if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open))) {
    await details.locator("summary").click();
  }
}

// The unreachable rows' own evidence. A tone this table reports as a NEGATIVE is
// the one shape nothing else in the file measures, so the claim rests entirely on
// the sentence beside it — and a sentence about the seed stops being true silently
// when the seed changes. Three separate cases of a confident sentence outliving its
// truth turned up in one day on this PR alone; two lines of assertion is the
// inoculation.
const OFF_PRIMITIVE_PROBES = (
  Object.entries(TONE_SURFACES) as [NoticeTone, ToneSurface][]
).flatMap(([tone, surface]) =>
  "offPrimitive" in surface && surface.offPrimitive
    ? surface.offPrimitive.map((probe) => [tone, probe] as const)
    : []
);

for (const [tone, probe] of OFF_PRIMITIVE_PROBES) {
  test(`#3897 the ${tone} row's reason is checkable on ${probe.route}`, async ({
    page,
  }) => {
    test.slow();
    await page.goto(probe.route);
    // The route ARRIVED — without this, everything below is satisfied by a 404, a
    // redirect, or a `<main>` that never rendered.
    await expect(page.getByTestId(probe.arrived)).toBeVisible();
    if (probe.open && probe.settled) {
      await page.getByTestId(probe.open).click();
      await expect(page.getByTestId(probe.settled)).toBeVisible();
    }

    // THE TONE DOES RENDER HERE. Asserted first and deliberately: it is the
    // premise of the row's reason, and without it the marker check below is a
    // green that could never turn red — it would be counting markers on a page
    // that had nothing to mark.
    expect(await page.locator(probe.block).count()).toBeGreaterThan(0);

    // …AND NONE OF IT GOES THROUGH THE PRIMITIVE, which is the reason itself. The
    // day one of these becomes a real `<Notice>`, this fails — and the answer is
    // to promote the tone to a reachable row above, not to soften this line.
    await expect(page.locator(`[data-notice="${tone}"]`)).toHaveCount(0);
  });
}

test("#3673 the tone table describes exactly the tones the primitive exports", () => {
  // The other direction of the compile-time census: a tone DELETED from
  // NOTICE_TONE leaves an entry here pointing at a shape that no longer exists,
  // and a table describing a tone the primitive does not have is a table nobody
  // can trust about the ones it does.
  expect(Object.keys(TONE_SURFACES).toSorted()).toEqual(
    Object.keys(NOTICE_TONE).toSorted()
  );
  // …and the reachable half is not empty, which is what stops the loop below from
  // passing by iterating nothing.
  expect(REACHABLE_TONES.length).toBeGreaterThan(0);
});

for (const [tone, surface] of REACHABLE_TONES) {
  test(`#3673 emphasis does not flatten: a ${tone} Notice (${surface.what}) still outranks an ordinary row`, async ({
    page,
  }) => {
    test.slow();
    await page.goto(surface.route);
    if (surface.expand) await openDisclosure(page, surface.expand);
    const notice = page.locator(surface.locator).first(); // first-ok: every Notice of a tone is the same primitive; the assertion is about the shape
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute("data-notice", tone);

    const read = (locator: Locator) =>
      locator.evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          border: Number.parseFloat(style.borderTopWidth),
          radius: Number.parseFloat(style.borderTopLeftRadius),
          fill: style.backgroundColor,
        };
      });

    // LOUD: it still draws the frame every neutral surface gave up, and it is
    // tinted rather than sitting on the page's own surface colour.
    const loud = await read(notice);
    expect(loud.border).toBeGreaterThanOrEqual(1);
    expect(loud.radius).toBeGreaterThan(0);

    // QUIET: an ordinary neutral surface on the SAME page — a different element,
    // so this is a comparison rather than a claim about one box read twice.
    const row = page.locator("main .card").first(); // first-ok: any neutral surface is the comparison; the claim is about the shape
    await expect(row).toBeVisible();
    const quiet = await read(row);
    expect(quiet.border).toBe(0);
    expect(quiet.radius).toBe(0);

    // …and the Notice is not merely framed, it is a different colour from both the
    // ordinary surface and the page ground. The tinted separation is widest on the
    // safety and refusal tones, which is the half the invariant is about.
    const canvas = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor
    );
    expect(loud.fill).not.toBe(quiet.fill);
    expect(loud.fill).not.toBe(canvas);
    expect(loud.fill).not.toBe("rgba(0, 0, 0, 0)");
  });
}

// ── THE OTHER DIRECTION: A SAFETY SURFACE STILL READS LOUDER ────────────────
//
// `cardFrames()` above fails when a surface KEEPS a frame. A surface that LOSES
// one produces an empty result, and an empty result is a pass — so the flat ban
// is structurally incapable of failing on a warning that went flat. That is not a
// coverage gap; it is the assertion running in one direction. It is also exactly
// what happened (#3897): under a green sweep, the drug-interaction strip, the ASHA
// threshold-shift warning and the active-illness cockpit each measured identical
// to an ordinary neutral surface on their own page, and a MAJOR Warfarin +
// Ibuprofen bleeding interaction rendered as body copy.
//
// So this is the converse, measured the same way the tone tests are: two REAL
// elements on the SAME page at 390px, one of which the app can do harm by
// flattening. The property asserted is a FILL, because that is what is left once
// the frame ban has run — with `border-width: 0` a border colour paints nothing,
// which is precisely how surfaces 2 and 3 were erased while still "being amber"
// and "being rose" in the class list.
//
// NAMED, NOT EXHAUSTIVE, and that is deliberate. A table that tried to cover every
// safety surface in the app would be the hand-maintained registry the standing
// ruling forbids, and a scanner that tried to find them would be worse. These are
// the three the adversarial pass measured flat; a fourth joins by being written
// here, with its own route and its own ordinary neighbour.
const LOUD_SURFACES = [
  {
    what: "the drug-interaction finding",
    route: "/medications",
    // The strip auto-opens only at ≤2 findings and the shared seed carries more.
    expand: "intake-warnings",
    loud: '[data-testid^="interaction-warning-"]',
    quiet: '[data-testid="medication-list"]',
    ordinary: "the medication list",
  },
  {
    what: "the ASHA threshold-shift warning",
    route: "/records/specialty/hearing",
    loud: '[data-testid="audiogram-shift"]',
    // Any recorded hearing test on the same pane. The `.card` half is load-bearing
    // and not decoration: `audiogram-` also prefixes the entry FORM and the
    // per-average sub-rows, and the form paints nothing, so a bare prefix could
    // resolve to a transparent box and compare the tint to nothing at all.
    quiet: 'main .card[data-testid^="audiogram-"]',
    ordinary: "a recorded hearing test",
  },
  {
    what: "the active-illness cockpit",
    route: "/",
    // The cockpit CONTAINER — `illness-cockpit-` also prefixes its header row, its
    // chevron and its status spans, none of which is the surface under test.
    loud: "[data-testid^='illness-cockpit-'][data-episode-key]",
    // The Standing band — the ordinary neutral surface on this scroll. Every
    // `main .card` on the dashboard IS an illness cockpit, so a `.card` neighbour
    // would be comparing the surface to itself.
    quiet: '[data-testid="dashboard-standing"]',
    ordinary: "the Standing band",
  },
] as const;

for (const surface of LOUD_SURFACES) {
  test(`#3897 emphasis survives the ban: ${surface.what} outreads ${surface.ordinary} at 390px`, async ({
    page,
  }) => {
    test.slow();
    await page.goto(surface.route);
    if ("expand" in surface) await openDisclosure(page, surface.expand);

    const loud = page.locator(surface.loud).first(); // first-ok: every finding of this kind is the same component; the assertion is about the shape
    const quiet = page.locator(surface.quiet).first(); // first-ok: any ordinary neutral surface on this page is the comparison
    await expect(loud).toBeVisible();
    await expect(quiet).toBeVisible();

    // TWO ELEMENTS, NOT ONE READ TWICE. Both selectors are prefix matches over a
    // family, and a surface that lost its distinguishing shape can fall back INTO
    // the ordinary set — which would make every comparison below true by
    // construction, on exactly the tree this test exists to reject.
    expect(
      await page.evaluate(
        ([a, b]) => document.querySelector(a) !== document.querySelector(b),
        [surface.loud, surface.quiet] as [string, string]
      )
    ).toBe(true);

    const read = (locator: Locator) =>
      locator.evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          border: Number.parseFloat(style.borderTopWidth),
          radius: Number.parseFloat(style.borderTopLeftRadius),
          fill: style.backgroundColor,
        };
      });
    const [hot, cold] = await Promise.all([read(loud), read(quiet)]);
    const canvas = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor
    );

    // THE COMPARISON IS AT THE PHONE SHAPE. The ordinary neighbour draws no card
    // frame — `cardFrames()`'s own predicate, so this cannot quietly become a
    // desktop measurement wearing a mobile test's name, and it is what makes the
    // difference below attributable to the tint rather than to a border.
    expect(cold.border >= 1 && cold.radius > 0).toBe(false);

    // …AND THE SAFETY SURFACE IS STILL SEPARABLE FROM IT, BY A PROPERTY THAT
    // PAINTS. Not "it has a rose class": with the border gone a colour on it
    // covers no pixels, which is the exact erasure this test exists for. A fill
    // that matched the neighbour's, matched the page ground, or was transparent
    // would each be that erasure wearing a different disguise, so all three are
    // rejected rather than only the first.
    expect(hot.fill).not.toBe(cold.fill);
    expect(hot.fill).not.toBe(canvas);
    expect(hot.fill).not.toBe("rgba(0, 0, 0, 0)");
  });
}

test("#3673 object-ness is the affordance: two rows in one band differ only by their control", async ({
  page,
}) => {
  test.slow();
  // The Now zone renders only action-bearing cards under the shared seed, so the
  // reporting half of this comparison comes from the Standing band on the same
  // scroll — which serves the claim better anyway: both rows sit inside ONE band,
  // so they share a fill and a frame by construction and the control is the only
  // thing left that can distinguish them. A row that links is a thing you act on;
  // a row that does not is a reading.
  await page.goto("/");
  await expect(page.getByTestId("dashboard-standing")).toBeVisible();
  const split = await page
    .getByTestId("dashboard-standing")
    .locator("[data-standing-family] li")
    .evaluateAll((nodes) => {
      const shape = (node: Element) => {
        const style = getComputedStyle(node);
        return `${style.borderTopWidth}|${style.borderTopLeftRadius}|${style.backgroundColor}`;
      };
      const acting: string[] = [];
      const reporting: string[] = [];
      for (const node of nodes)
        (node.querySelector("a,button") ? acting : reporting).push(shape(node));
      return { acting, reporting };
    });
  // Presence first, both ways: a one-sided split would satisfy the equality below
  // vacuously, and this seed is the only thing making the split exist at all.
  expect(split.acting.length).toBeGreaterThan(0);
  expect(split.reporting.length).toBeGreaterThan(0);
  // …and the two kinds are visually indistinguishable. No frame, no fill step.
  expect([...new Set([...split.acting, ...split.reporting])]).toHaveLength(1);

  // The Now zone draws no card frame either, which is the same ruling on the zone the
  // acceptance criterion names: nothing there but the affordance. Since #4076 Now is
  // a BAND of rows, so what is read is the row's own corner — a band's rows share one
  // frame and round nothing of their own.
  const nowShapes = await page
    .locator('[data-testid="dashboard-candidate"][data-lane="now"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).borderTopLeftRadius)
    );
  expect(nowShapes.length).toBeGreaterThan(0);
  expect([...new Set(nowShapes)]).toEqual(["0px"]);
});

test.describe("dark", () => {
  test.use({ colorScheme: "dark" });

  test("#3673 a band is still separable from the canvas in dark mode", async ({
    page,
  }) => {
    test.slow();
    // The failure mode the invariant names: a band that becomes invisible against
    // the canvas is a failed de-card, not a shipped one. With the border gone the
    // fill is what is left carrying it, so the fill is what is read — from the
    // band and from the body, two different elements.
    await page.goto("/");
    const band = page.getByTestId("dashboard-standing");
    await expect(band).toBeVisible();
    const fill = await band.evaluate(
      (node) => getComputedStyle(node).backgroundColor
    );
    const canvas = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor
    );
    expect(fill).not.toBe("rgba(0, 0, 0, 0)");
    expect(fill).not.toBe(canvas);
    // …and the theme really is the dark one, or the reading above is the light
    // theme's answer wearing this test's name.
    await expect(page.locator("html")).toHaveClass(/dark/);
    // The band keeps its dividers too, which is the other half of "fill OR divider".
    expect(await px(band, "border-top-width")).toBeGreaterThan(0);
  });
});
