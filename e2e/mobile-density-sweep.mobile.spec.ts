import { test, expect } from "./fixtures";
import { settledBoxes } from "./helpers";
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

// The tap floor #3466's acceptance criteria name. A row IS the target on the
// hover-fill list idiom, so the row's own height is the quantity.
const TAP_FLOOR_PX = 40;

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

  // The pillar box is `p-2.5` (10px) on desktop and steps to 8 here.
  const inset = await padding(pillar);
  expect(inset).toEqual([8, 8, 8, 8]);

  // …inside a card that is still at its #1416 floor of 16. The card is a
  // DIFFERENT element, which is what makes this a comparison rather than a
  // tautology: the sweep's whole finding is that the two layers were both
  // spending a full gutter.
  const card = main
    .getByTestId("longevity-fitness")
    .locator("xpath=ancestor-or-self::*[contains(@class,'card')][1]");
  const cardInset = await padding(card);
  expect(cardInset).toEqual([16, 16, 16, 16]);
  expect(Math.max(...inset)).toBeLessThan(Math.min(...cardInset));

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

  // The RENDERED gap, between the two elements the seam actually separates. Read
  // with settledBoxes rather than two independent boundingBox calls, which can
  // describe a layout that never existed.
  const [bioAge, fitness] = await settledBoxes([
    main.getByTestId("longevity-bio-age"),
    main.getByTestId("longevity-fitness"),
  ]);
  const renderedGap = fitness.y - (bioAge.y + bioAge.height);
  // An equality, not a ceiling: `<= 24` would also pass on a seam collapsed to
  // nothing, and `>= 16` would pass on the 24 this test exists to reject.
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

  // The card keeps its border; the wrapper that used to draw a SECOND one around
  // the whole grid no longer does. Both readings, from both elements, in one test —
  // "the wrapper has no border" alone would also pass if the cards lost theirs.
  expect(await px(card, "border-top-width")).toBeGreaterThan(0);
  expect(await px(wrapper, "border-top-width")).toBe(0);
  // …and it spends no gutter of its own either, which is the phone half of it.
  expect(await padding(wrapper)).toEqual([0, 0, 0, 0]);
});
