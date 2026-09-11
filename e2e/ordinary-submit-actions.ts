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
// THE ORDINARY ASSERTIONS ARE NOT WEAKENED TO ADMIT IT. Ten of this file's
// eleven call sites are not log forms — a session bulk action, an episode
// timeline editor, an immunization override, an instrument reading — and the
// ruling reaches none of them, so "a submit is content-sized" is still true
// where it was true, and still asserted. What changes is that a SECOND shape now
// exists and gets its own name here, rather than the one rule being loosened
// until it fits both and catches neither.
//
// EVERY CHECK THAT STILL APPLIES IS STILL MADE, from the same private helpers:
// the submit is inside its owner is inside the form, the commit and the dismiss
// do not overlap, and the box stays compact. Exactly one assertion inverts —
// content-sized becomes full-width — and one is added: the dismiss is
// subordinate, which is the half of the ruling a width check on Save alone
// cannot see.
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
  expect(
    Math.abs(submitBox.width - ownerBox.width),
    `${name} commit is ${submitBox.width} in a ${ownerBox.width} row; the log form's Save is full-width`
  ).toBeLessThanOrEqual(TAP_FLOOR_FLOAT_EPSILON_PX);
  expectContained(formBox, ownerBox, `${name} owner in form`);
  expectContained(ownerBox, submitBox, `${name} commit in owner`);
  if (adjacentBox) {
    expect(
      adjacentBox.width,
      `${name} dismiss is ${adjacentBox.width} against a ${submitBox.width} commit; it must not be a same-size box`
    ).toBeLessThan(submitBox.width / 2);
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
