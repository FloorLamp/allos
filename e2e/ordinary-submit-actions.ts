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
  await expect(submit).toHaveClass(/(^|\s)btn(\s|$)/);
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
