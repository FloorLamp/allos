import { expect, type Locator } from "@playwright/test";
import { expectPhoneTapTargets, settledBoxes } from "./helpers";
import {
  TAP_FLOOR_FLOAT_EPSILON_PX,
  TAP_FLOOR_PX,
} from "@/lib/tap-floor-tokens";

type Box = { x: number; y: number; width: number; height: number };
const EDIT_ACTION_GAP_PX = 8; // gap-2

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

type SpecialtyActions = {
  form: Locator;
  actions: Locator;
  primaryOwner: Locator;
  submit: Locator;
  name: string;
};

export async function expectDesktopSpecialtySubmit({
  form,
  actions,
  primaryOwner,
  submit,
  name,
}: SpecialtyActions) {
  const viewport = form.page().viewportSize();
  expect(viewport, `${name} needs a fixed desktop viewport`).not.toBeNull();
  expect(
    viewport!.width,
    `${name} runs before the phone resize`
  ).toBeGreaterThanOrEqual(640);
  const [formBox, actionsBox, ownerBox, submitBox] = await settledBoxes([
    form,
    actions,
    primaryOwner,
    submit,
  ]);

  expect(submitBox.height, `${name} desktop submit stays compact`).toBeLessThan(
    TAP_FLOOR_PX
  );
  expect(
    submitBox.width,
    `${name} desktop submit does not fill the form`
  ).toBeLessThan(formBox.width / 2);
  expect(submitBox.width, `${name} submit stretches to its layout owner`).toBe(
    ownerBox.width
  );
  expectContained(formBox, actionsBox, `${name} actions in form`);
  expectContained(actionsBox, ownerBox, `${name} primary owner in actions`);
  expectContained(ownerBox, submitBox, `${name} submit in primary owner`);
}

export async function expectPhoneSpecialtySubmit({
  form,
  actions,
  primaryOwner,
  submit,
  adjacent,
  fillsActions = false,
  name,
}: SpecialtyActions & { adjacent?: Locator; fillsActions?: boolean }) {
  const targets = adjacent ? [submit, adjacent] : [submit];
  await expectPhoneTapTargets(form.page(), name, targets, {
    disjoint: adjacent != null,
  });
  const locators = [form, actions, primaryOwner, submit];
  if (adjacent) locators.push(adjacent);
  const [formBox, actionsBox, ownerBox, submitBox, adjacentBox] =
    await settledBoxes(locators);

  expect(submitBox.width, `${name} submit fills its layout owner`).toBeCloseTo(
    ownerBox.width,
    1
  );
  if (fillsActions)
    expect(ownerBox.width, `${name} owner fills the action row`).toBeCloseTo(
      actionsBox.width,
      1
    );
  expectContained(formBox, actionsBox, `${name} actions in form`);
  expectContained(actionsBox, ownerBox, `${name} primary owner in actions`);
  expectContained(ownerBox, submitBox, `${name} submit in primary owner`);
  if (adjacentBox) {
    expect(
      ownerBox.x,
      `${name} primary owner starts the action row`
    ).toBeCloseTo(actionsBox.x, 1);
    expect(
      adjacentBox.x - (ownerBox.x + ownerBox.width),
      `${name} actions retain the configured gap`
    ).toBeCloseTo(EDIT_ACTION_GAP_PX, 1);
    expect(
      adjacentBox.x + adjacentBox.width,
      `${name} adjacent action ends the action row`
    ).toBeCloseTo(actionsBox.x + actionsBox.width, 1);
    expect(
      ownerBox.width + EDIT_ACTION_GAP_PX + adjacentBox.width,
      `${name} owner, gap, and adjacent action consume the row`
    ).toBeCloseTo(actionsBox.width, 1);
    expectContained(
      actionsBox,
      adjacentBox,
      `${name} adjacent action in actions`
    );
  }
}
