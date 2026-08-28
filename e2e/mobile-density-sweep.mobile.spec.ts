import { test, expect } from "./fixtures";
import { settledBoxes } from "./helpers";
import { TAP_FLOOR_PX } from "@/lib/tap-floor-tokens";
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

  // …inside a card that keeps its #1416 vertical floor of 16 and no longer spends
  // a horizontal one. The card is a DIFFERENT element, which is what makes this a
  // comparison rather than a tautology: the sweep's finding was that the two
  // layers were both spending a full gutter, and #3673's is that the outer one
  // should not have been spending a horizontal gutter at all.
  const card = main
    .getByTestId("longevity-fitness")
    .locator("xpath=ancestor-or-self::*[contains(@class,'card')][1]");
  const cardInset = await padding(card);
  expect(cardInset).toEqual([16, 0, 16, 0]);
  // The vertical step is still a step; the horizontal one is gone on both.
  expect(inset[0]).toBeLessThan(cardInset[0]);
  expect(inset[3]).toBe(cardInset[3]);

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

  // `p-3` (12) on desktop, 10 here.
  expect(await padding(row)).toEqual([10, 10, 10, 10]);

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
  // …and neither spends a gutter of its own, which is the phone half of it.
  expect(await padding(wrapper)).toEqual([0, 0, 0, 0]);
  expect(await px(card, "padding-left")).toBe(0);
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
// block box carrying BOTH a border and a corner radius. Three silences are part of
// the definition and each one is a shape that ships today and is correct:
//
//   * a CONTROL, and a box whose every child is a control (a segmented toggle).
//     Object-ness moved to the affordance; a button that stopped looking like a
//     button would be the sweep eating its own ruling.
//   * a PILL — radius at or past half the height. A badge or a chip is not a card.
//   * a NOTICE. Recognised by `data-notice`, which only `components/Notice.tsx`'s
//     exported primitive and its FindingCard sibling (built on the same closed
//     NOTICE_TONE map) emit. That is MODULE IDENTITY: there is no path list, no
//     testid list and no source match anywhere in this rule, and a surface joins
//     the exception by BEING a Notice rather than by being written down here.
async function cardFrames(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const found: string[] = [];
    const main = document.querySelector("main");
    if (!main) throw new Error("no <main> to sweep");
    for (const el of main.querySelectorAll<HTMLElement>("*")) {
      const style = getComputedStyle(el);
      const border = Number.parseFloat(style.borderTopWidth);
      const radius = Number.parseFloat(style.borderTopLeftRadius);
      if (!(border >= 1 && radius > 0)) continue;
      const box = el.getBoundingClientRect();
      if (!box.height || !box.width) continue;
      if (radius * 2 >= box.height) continue;
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
    return found;
  });
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
    return [...edges].map(([key, count]) => ({ key, count }));
  }, BAND_SELECTOR);
}

// The three surfaces the ruling names, with the content marker each one must be
// waited for. A region measured before its rows arrive is a measurement of a
// placeholder, and empty is the state that flatters every assertion below.
const SWEPT = [
  ["the ledger", "/nutrition/dose-history", "dose-ledger"],
  ["a Records pane", "/records", "records-visits"],
  ["the dashboard", "/", "dashboard-standing"],
] as const;

for (const [what, route, marker] of SWEPT) {
  test(`#3673 flat ban: no card frame renders on ${what} at 390px`, async ({
    page,
  }) => {
    test.slow();
    await page.goto(route);
    await expect(page.getByTestId(marker)).toBeVisible();

    expect(await cardFrames(page)).toEqual([]);

    // Nesting stays banned, and below `sm` a band is what a card became — so the
    // card-in-card rule is asked of the band shape too, on the rendered tree.
    const nested = await page.evaluate(
      () =>
        document.querySelectorAll(
          "main .card .card, main .card .card-quiet, main .card .band, main .band .band, main .band .card"
        ).length
    );
    expect(nested).toBe(0);
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

  const forged = await page.evaluate(() => {
    const el = document.createElement("div");
    el.dataset.testid = "forged-card-frame";
    el.style.cssText =
      "border:1.5px solid #888;border-radius:14px;padding:16px;height:80px";
    el.textContent = "FORGED BY A SPEC on purpose — not a shipped card";
    document.querySelector("main")?.append(el);
    return el.dataset.testid;
  });
  const caught = await cardFrames(page);
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

  // ONE value, not "no value greater than". A set with two entries is the 16px
  // step the prototype's ochre guide made visible, whichever way it steps.
  expect(await contentEdges(page)).toEqual([
    { key: `${PAGE_GUTTER_PX}/${CONTENT_PX}`, count: expect.any(Number) },
  ]);

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

  // The dividend, asserted rather than screenshotted: ≥92% of the viewport, up
  // from the 83.6% a framed card left.
  expect(CONTENT_PX / VIEWPORT_PX).toBeGreaterThanOrEqual(0.92);
  const widest = await page.evaluate(
    (selector) =>
      Math.max(
        ...[...document.querySelectorAll<HTMLElement>(selector)].map((el) => {
          const style = getComputedStyle(el);
          return (
            el.getBoundingClientRect().width -
            Number.parseFloat(style.paddingLeft) -
            Number.parseFloat(style.paddingRight)
          );
        })
      ),
    BAND_SELECTOR
  );
  expect(widest).toBe(CONTENT_PX);
});

test("#3673 the ledger's rows reclaim the same line", async ({ page }) => {
  test.slow();
  await page.goto("/nutrition/dose-history");
  const row = page.locator("table.logged-event-rows tr").first(); // first-ok: every row is the same primitive
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  expect(Math.round(box?.x ?? 0)).toBe(PAGE_GUTTER_PX);
  expect(Math.round(box?.width ?? 0)).toBe(CONTENT_PX);
  // The row still meets the tap floor it met when a card was drawing its gutter.
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
});

test("#3673 emphasis does not flatten: a tinted Notice still outranks an ordinary row", async ({
  page,
}) => {
  test.slow();
  // The invariant that made the Notice the one exception: with every neutral frame
  // gone it is the loudest shape the app still has, and a safety or refusal surface
  // that reads no louder than an ordinary row is a failed sweep. Loudness here is
  // the two things the row gave up — a drawn frame and a tint of its own.
  await page.goto("/nutrition?tab=supplements");
  const notice = page.locator("[data-notice='amber']").first(); // first-ok: the primitive, not this occurrence
  await expect(notice).toBeVisible();

  const read = (locator: Locator) =>
    locator.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        border: Number.parseFloat(style.borderTopWidth),
        radius: Number.parseFloat(style.borderTopLeftRadius),
        fill: style.backgroundColor,
      };
    });

  const loud = await read(notice);
  expect(loud.border).toBeGreaterThanOrEqual(1);
  expect(loud.radius).toBeGreaterThan(0);

  // The ordinary row it has to out-shout: a stacked row on the same page.
  const row = page.locator("main .table-cards tr").first(); // first-ok: any row is the comparison
  await expect(row).toBeVisible();
  const quiet = await read(row);
  expect(quiet.border).toBe(0);
  expect(quiet.radius).toBe(0);
  expect(loud.fill).not.toBe(quiet.fill);
  const canvas = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor
  );
  expect(loud.fill).not.toBe(canvas);
});

test("#3673 object-ness is the affordance: two rows in one band differ only by their control", async ({
  page,
}) => {
  test.slow();
  // The Now zone renders only action-bearing cards under the shared seed, so the
  // reporting half of this comparison comes from the Standing band on the same
  // scroll — which is better for the claim anyway: both rows sit inside ONE band,
  // so they share a fill and a frame by construction and the control is the only
  // thing left that can distinguish them.
  await page.goto("/");
  await expect(page.getByTestId("dashboard-standing")).toBeVisible();
  const rows = page.locator("[data-standing-family]");
  const split = await rows.evaluateAll((nodes) => {
    const shape = (node: Element) => {
      const style = getComputedStyle(node);
      return `${style.borderTopWidth}|${style.borderTopLeftRadius}|${style.backgroundColor}|${style.paddingLeft}`;
    };
    const acting: string[] = [];
    const reporting: string[] = [];
    for (const node of nodes)
      (node.querySelector("a,button") ? acting : reporting).push(shape(node));
    return { acting, reporting };
  });
  // Presence first: a vacuous split would satisfy every assertion below it.
  expect(split.acting.length).toBeGreaterThan(0);
  expect(split.reporting.length).toBeGreaterThan(0);
  // …and the two kinds are visually indistinguishable. No frame, no fill step.
  expect([...new Set([...split.acting, ...split.reporting])]).toHaveLength(1);

  // The Now zone's own cards draw no frame either, which is the other half of the
  // same ruling on the zone the acceptance criterion names.
  const nowShapes = await page
    .locator("[data-testid^='now-strip-card-']")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node);
        return `${style.borderTopWidth}|${style.borderTopLeftRadius}`;
      })
    );
  expect(nowShapes.length).toBeGreaterThan(0);
  expect([...new Set(nowShapes)]).toEqual(["0px|0px"]);
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
