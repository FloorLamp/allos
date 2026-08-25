import { test, expect } from "./fixtures";
import { settledBoxes } from "./helpers";
import { medicationsToday } from "./med-card-helpers";
import {
  TAP_FLOOR_FLOAT_EPSILON_PX,
  TAP_FLOOR_PX,
  TAP_TARGET_INSET_PX,
} from "@/lib/tap-floor-tokens";

const PHONE = { width: 390, height: 844 };

type Box = { x: number; y: number; width: number; height: number };

function effectiveBox(box: Box, inset: number): Box {
  return {
    x: box.x - inset,
    y: box.y - inset,
    width: box.width + 2 * inset,
    height: box.height + 2 * inset,
  };
}

test.use({ viewport: PHONE, hasTouch: true });

test("every routed dose pill owns two contained, disjoint 44px targets", async ({
  page,
}) => {
  await page.goto("/medications");
  const today = medicationsToday(page);
  await expect(today).toBeVisible();

  const controls = today.locator(
    '[data-testid="dose-status"][data-variant="pill"]:visible'
  );
  const count = await controls.count();
  expect(
    count,
    "the routed Today panel must render a dose pill"
  ).toBeGreaterThan(0);

  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    const take = control.getByTestId("dose-take");
    const skip = control.getByTestId("dose-skip");
    const [controlBox, takeBox, skipBox] = await settledBoxes([
      control,
      take,
      skip,
    ]);

    const inset = await take.evaluate((node) => {
      const style = getComputedStyle(node, "::after");
      return {
        content: style.content,
        top: Math.abs(Number.parseFloat(style.top)),
      };
    });
    expect(inset.content, "the coarse-pointer overlay must be active").not.toBe(
      "none"
    );
    expect(inset.top).toBe(TAP_TARGET_INSET_PX);

    const effectiveTake = effectiveBox(takeBox, inset.top);
    const effectiveSkip = effectiveBox(skipBox, inset.top);
    for (const [name, box] of [
      ["take", effectiveTake],
      ["skip", effectiveSkip],
    ] as const) {
      expect(
        box.width + TAP_FLOOR_FLOAT_EPSILON_PX,
        `${name} width`
      ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
      expect(
        box.height + TAP_FLOOR_FLOAT_EPSILON_PX,
        `${name} height`
      ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
      expect(
        box.x + TAP_FLOOR_FLOAT_EPSILON_PX,
        `${name} left containment`
      ).toBeGreaterThanOrEqual(controlBox.x);
      expect(
        box.y + TAP_FLOOR_FLOAT_EPSILON_PX,
        `${name} top containment`
      ).toBeGreaterThanOrEqual(controlBox.y);
      expect(
        box.x + box.width,
        `${name} right containment`
      ).toBeLessThanOrEqual(
        controlBox.x + controlBox.width + TAP_FLOOR_FLOAT_EPSILON_PX
      );
      expect(
        box.y + box.height,
        `${name} bottom containment`
      ).toBeLessThanOrEqual(
        controlBox.y + controlBox.height + TAP_FLOOR_FLOAT_EPSILON_PX
      );
    }

    const overlapX =
      Math.min(
        effectiveTake.x + effectiveTake.width,
        effectiveSkip.x + effectiveSkip.width
      ) - Math.max(effectiveTake.x, effectiveSkip.x);
    const overlapY =
      Math.min(
        effectiveTake.y + effectiveTake.height,
        effectiveSkip.y + effectiveSkip.height
      ) - Math.max(effectiveTake.y, effectiveSkip.y);
    expect(
      overlapX > TAP_FLOOR_FLOAT_EPSILON_PX &&
        overlapY > TAP_FLOOR_FLOAT_EPSILON_PX,
      `dose pill ${index} effective targets overlap`
    ).toBe(false);
  }
});
