import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { settledBoxes } from "./helpers";
import { medicationsToday } from "./med-card-helpers";
import {
  CONTROL_BOX_PX,
  TAP_FLOOR_FLOAT_EPSILON_PX,
  TAP_FLOOR_PX,
  TAP_TARGET_INSET_PX,
} from "@/lib/tap-floor-tokens";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 844 };
// The pill renders the control box, not a size of its own (#3938): 32 beside a
// 34px chip in the same row was the reported defect, and 34 + 2x6 still clears 44.
const PILL_PX = CONTROL_BOX_PX;
const DESKTOP_GAP_PX = 6;

type Box = { x: number; y: number; width: number; height: number };

function effectiveBox(box: Box, inset: number): Box {
  return {
    x: box.x - inset,
    y: box.y - inset,
    width: box.width + 2 * inset,
    height: box.height + 2 * inset,
  };
}

function expectExactPx(value: number, expected: number, name: string): void {
  expect(Math.abs(value - expected), name).toBeLessThanOrEqual(
    TAP_FLOOR_FLOAT_EPSILON_PX
  );
}

function expectContained(inner: Box, outer: Box, name: string): void {
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

async function measurePill(control: Locator) {
  const row = control.locator(
    "xpath=ancestor::*[@data-testid='scheduled-dose-action'][1]"
  );
  const take = control.getByTestId("dose-take");
  const skip = control.getByTestId("dose-skip");

  await expect(row).toHaveCount(1);
  await control.scrollIntoViewIfNeeded();
  await settledBoxes([row, control, take, skip]);

  return control.evaluate((node) => {
    const rowNode = node.closest('[data-testid="scheduled-dose-action"]');
    const takeNode = node.querySelector('[data-testid="dose-take"]');
    const skipNode = node.querySelector('[data-testid="dose-skip"]');
    if (!rowNode || !takeNode || !skipNode) {
      throw new Error("dose pill must own its row, take, and skip elements");
    }

    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    };
    const overlay = getComputedStyle(takeNode, "::after");

    return {
      row: box(rowNode),
      control: box(node),
      take: box(takeNode),
      skip: box(skipNode),
      viewport: { x: 0, y: 0, width: innerWidth, height: innerHeight },
      overlay: {
        content: overlay.content,
        inset: Math.abs(Number.parseFloat(overlay.top)),
      },
    };
  });
}

async function routedPillControls(page: Page): Promise<Locator> {
  await page.goto("/medications");
  const today = medicationsToday(page);
  await expect(today).toBeVisible();

  const controls = today.locator(
    '[data-testid="dose-status"][data-variant="pill"]:visible'
  );
  expect(
    await controls.count(),
    "the routed Today panel must render a dose pill"
  ).toBeGreaterThan(0);
  return controls;
}

test.describe("phone coarse-pointer geometry", () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test("every routed dose pill owns two contained, disjoint 44px targets", async ({
    page,
  }) => {
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches)
    ).toBe(true);
    const controls = await routedPillControls(page);
    const count = await controls.count();

    for (let index = 0; index < count; index += 1) {
      const { row, control, take, skip, viewport, overlay } = await measurePill(
        controls.nth(index)
      );

      expectExactPx(take.width, PILL_PX, `dose pill ${index} take width`);
      expectExactPx(take.height, PILL_PX, `dose pill ${index} take height`);
      expectExactPx(skip.width, PILL_PX, `dose pill ${index} skip width`);
      expectExactPx(skip.height, PILL_PX, `dose pill ${index} skip height`);
      expect(
        overlay.content,
        "the coarse-pointer overlay must be active"
      ).not.toBe("none");
      expect(overlay.inset).toBe(TAP_TARGET_INSET_PX);

      const effectiveTake = effectiveBox(take, overlay.inset);
      const effectiveSkip = effectiveBox(skip, overlay.inset);
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
        expectContained(box, control, `${name} wrapper`);
        expectContained(box, row, `${name} row`);
        expectContained(box, viewport, `${name} viewport`);
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
});

test.describe("desktop fine-pointer geometry", () => {
  test.use({ viewport: DESKTOP, hasTouch: false });

  test("every routed dose pill restores compact padding and gap", async ({
    page,
  }) => {
    expect(
      await page.evaluate(() => matchMedia("(pointer: fine)").matches)
    ).toBe(true);
    const controls = await routedPillControls(page);
    const count = await controls.count();

    for (let index = 0; index < count; index += 1) {
      const { control, take, skip } = await measurePill(controls.nth(index));

      expectExactPx(take.width, PILL_PX, `dose pill ${index} take width`);
      expectExactPx(take.height, PILL_PX, `dose pill ${index} take height`);
      expectExactPx(skip.width, PILL_PX, `dose pill ${index} skip width`);
      expectExactPx(skip.height, PILL_PX, `dose pill ${index} skip height`);
      expectExactPx(
        control.height,
        PILL_PX,
        `dose pill ${index} wrapper height`
      );
      expectExactPx(take.x, control.x, `dose pill ${index} left padding`);
      expectExactPx(take.y, control.y, `dose pill ${index} top padding`);
      expectExactPx(skip.y, control.y, `dose pill ${index} skip top padding`);
      expectExactPx(
        control.x + control.width,
        skip.x + skip.width,
        `dose pill ${index} right padding`
      );
      expectExactPx(
        control.y + control.height,
        skip.y + skip.height,
        `dose pill ${index} bottom padding`
      );
      expectExactPx(
        skip.x - (take.x + take.width),
        DESKTOP_GAP_PX,
        `dose pill ${index} gap`
      );
    }
  });
});
