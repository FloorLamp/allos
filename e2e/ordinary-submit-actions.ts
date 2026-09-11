import { expect, type Locator } from "@playwright/test";
import { expectPhoneTapTargets, settledBoxes } from "./helpers";
import {
  TAP_FLOOR_FLOAT_EPSILON_PX,
  TAP_FLOOR_PX,
} from "@/lib/tap-floor-tokens";

type Box = { x: number; y: number; width: number; height: number };

function expectContained(outer: Box, inner: Box, name: string) {
  expect(
    inner.x + TAP_FLOOR_FLOAT_EPSILON_PX,
    `${name} left containment`
  ).toBeGreaterThanOrEqual(outer.x);
  expect(
    inner.y + TAP_FLOOR_FLOAT_EPSILON_PX,
    `${name} top containment`
  ).toBeGreaterThanOrEqual(outer.y);
  expect(
    inner.x + inner.width,
    `${name} right containment`
  ).toBeLessThanOrEqual(outer.x + outer.width + TAP_FLOOR_FLOAT_EPSILON_PX);
  expect(
    inner.y + inner.height,
    `${name} bottom containment`
  ).toBeLessThanOrEqual(outer.y + outer.height + TAP_FLOOR_FLOAT_EPSILON_PX);
}

function expectDisjoint(a: Box, b: Box, name: string) {
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapY =
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  expect(
    overlapX > TAP_FLOOR_FLOAT_EPSILON_PX &&
      overlapY > TAP_FLOOR_FLOAT_EPSILON_PX,
    name
  ).toBe(false);
}

type OrdinarySubmit = {
  form: Locator;
  owner: Locator;
  submit: Locator;
  adjacent?: Locator;
  name: string;
};

export async function expectDesktopOrdinarySubmit({
  form,
  owner,
  submit,
  adjacent,
  name,
}: OrdinarySubmit) {
  const viewport = form.page().viewportSize();
  expect(viewport, `${name} needs a fixed desktop viewport`).not.toBeNull();
  expect(
    viewport!.width,
    `${name} runs before the phone resize`
  ).toBeGreaterThanOrEqual(640);
  const locators = [form, owner, submit];
  if (adjacent) locators.push(adjacent);
  const [formBox, ownerBox, submitBox, adjacentBox] =
    await settledBoxes(locators);

  expect(submitBox.height, `${name} desktop submit stays compact`).toBeLessThan(
    TAP_FLOOR_PX
  );
  expect(
    submitBox.width,
    `${name} desktop submit remains content-sized`
  ).toBeLessThan(ownerBox.width);
  expectContained(formBox, ownerBox, `${name} owner in form`);
  expectContained(ownerBox, submitBox, `${name} submit in owner`);
  if (adjacentBox)
    expectDisjoint(submitBox, adjacentBox, `${name} desktop actions disjoint`);
}

// ── THE OTHER SHAPE, AND WHY IT IS NOT THIS FILE'S DEFAULT ──────────────────
//
// Everything above is the ORDINARY submit: content-sized, with its neighbour
// beside it. A log form's submit is not that, by owner ruling 2026-09-11 11:15
// UTC on #5617 — the owner reported the record's dose edit form as a Save "the
// same size as the other controls", and the ruling makes Save the form's one
// prominent commit, full-width at the control box, with Cancel kept as a
// subordinate text-style dismiss rather than an identical box beside it.
//
// AND IT IS CONTENT-SIZED TOO, which is why this is a SECOND shape rather than a
// different width (owner, 2026-09-11 15:15 UTC, amending 11:15). The first ruling
// made the log forms' Save full-width; above tablet width that ran the commit
// under `TimeField`'s wheel — which opens on FOCUS — so a click aimed at Save
// picked a time instead of saving, and seven specs went red. Width is out; the
// anchored panel is untouched. What separates the two shapes is RANK: an ordinary
// submit is one control among peers, a prominent commit is the form's only filled
// one with a text-style dismiss under it.
//
// SO THE ORDINARY ASSERTIONS ARE NOT WEAKENED TO ADMIT IT, and they never were.
// Ten of this file's eleven call sites are not log forms — a session bulk action,
// an episode timeline editor, an immunization override, an instrument reading —
// and neither ruling reaches them.
//
// EVERY CHECK THAT STILL APPLIES IS STILL MADE, from the same private helpers:
// the submit is inside its owner is inside the form, the commit and the dismiss
// do not overlap, and the box stays compact. What this adds on top is the pair of
// facts the ruling actually states — the commit is filled and the dismiss is not,
// and the commit does not span its row.
//
// WHAT IT DELIBERATELY DOES NOT ASSERT IS "the commit is the widest control".
// Measured on the dose form, "Save dose" is 78.7 and its dismiss 45.6 — but the
// same commit wearing this family's short label ("Add", which Stool, Symptom,
// Substance and Food all render) is 43.4, NARROWER than the dismiss. A width
// comparison would pass here on one fixture's long label and be false of six of
// the eight forms.
const painted = (locator: Locator) =>
  locator.evaluate(
    (el) => !/^rgba\(.*,\s*0\)$/.test(getComputedStyle(el).backgroundColor)
  );

export async function expectProminentCommit({
  form,
  owner,
  submit,
  adjacent,
  name,
}: OrdinarySubmit) {
  const locators = [form, owner, submit];
  if (adjacent) locators.push(adjacent);
  const [formBox, ownerBox, submitBox, adjacentBox] =
    await settledBoxes(locators);

  expect(submitBox.height, `${name} commit stays compact`).toBeLessThan(
    TAP_FLOOR_PX
  );
  // CONTENT-SIZED, so the commit clears a picker popover anchored above it. The
  // half-row bound is the clearance, not a style preference: a commit that spans
  // its row is the shape that put a minute column over Save.
  expect(
    submitBox.width,
    `${name} commit spans ${submitBox.width} of a ${ownerBox.width} row; a commit that reaches across the form runs under the time wheel`
  ).toBeLessThanOrEqual(ownerBox.width / 2);
  expectContained(formBox, ownerBox, `${name} owner in form`);
  expectContained(ownerBox, submitBox, `${name} commit in owner`);
  // THE PROMINENCE, now that it is not width: the commit is filled.
  expect(await painted(submit), `${name} commit is not filled`).toBe(true);
  if (adjacentBox && adjacent) {
    expect(
      await painted(adjacent),
      `${name} dismiss is painted like a commit; it must be the text-style dismiss`
    ).toBe(false);
    expectDisjoint(
      submitBox,
      adjacentBox,
      `${name} commit and dismiss disjoint`
    );
  }
}

export async function expectPhoneOrdinarySubmit({
  form,
  owner,
  submit,
  adjacent,
  name,
}: OrdinarySubmit) {
  const viewport = form.page().viewportSize();
  expect(viewport, `${name} needs a fixed phone viewport`).not.toBeNull();
  expect(viewport!.width, `${name} runs at the phone breakpoint`).toBeLessThan(
    640
  );
  await expectPhoneTapTargets(form.page(), name, [submit]);
  const locators = [form, owner, submit];
  if (adjacent) locators.push(adjacent);
  const [formBox, ownerBox, submitBox, adjacentBox] =
    await settledBoxes(locators);

  expect(
    submitBox.width,
    `${name} phone submit remains content-sized inside its layout owner`
  ).toBeLessThan(ownerBox.width);
  expectContained(formBox, ownerBox, `${name} owner in form`);
  expectContained(ownerBox, submitBox, `${name} submit in owner`);
  if (adjacentBox)
    expectDisjoint(submitBox, adjacentBox, `${name} phone actions disjoint`);
}
