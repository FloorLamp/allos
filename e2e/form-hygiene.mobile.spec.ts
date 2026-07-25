import { test, expect, type Page } from "@playwright/test";

// Form hygiene at phone width (issue #1450 cluster A, the highest-stakes site).
//
// The strength set row (SET · WEIGHT stepper · × · REPS stepper · OPTIONS) is the
// surface used mid-set, at the gym, on a phone. At 390px it could not fit: the
// 48px "Set N" label, the 64px options column and the gaps left ~230px for the
// middle group, and the four ±buttons, the plate button and the "×" ate most of
// that — so each stepper sat at its `min-w-20` floor with roughly 8px of inner
// input. A logged 77.5 kg rendered as "7". You could not read back the load you
// had just entered.
//
// The row now wraps below `sm`: "Set N" and the options stack share the first
// line, weight × reps take the second at full width, and the stepper's
// min-width states its real contract (two ±buttons + padding + four characters).
// This spec drives the real editor at 390px and asserts the INPUT can display its
// own value — scrollWidth fitting clientWidth is the direct expression of "not
// clipped", and it holds regardless of font metrics, so it is not a pixel
// snapshot. It runs in the `mobile` Playwright project (#1420) by filename.
//
// Fixture hygiene (#868): the spec creates its own draft activity and never
// saves it, so it owns everything it touches and asserts no shared-seed counts.

// Type an exercise name into the combobox and take the matching option.
async function pickActivity(page: Page, name: string): Promise<void> {
  await page.getByPlaceholder(/What did you do/).fill(name);
  await page
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: name })
    .first() // first-ok: transient combobox list this spec just opened by typing `name`; the first filtered match is the intended option
    .click();
}

// Does this element render its full content, or is it clipping it? A clipped
// input scrolls its own value (scrollWidth > clientWidth); one that fits does
// not. 1px of tolerance absorbs sub-pixel layout rounding.
async function isClipped(page: Page, testId: string): Promise<boolean> {
  return page
    .getByTestId(testId)
    .evaluate((el) => el.scrollWidth > el.clientWidth + 1);
}

test("the live set row shows a 4-character load at 390px (#1450)", async ({
  page,
}) => {
  await page.goto("/training");
  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
    .click();

  // A barbell lift, so the row renders its widest form: both steppers plus the
  // plate-math button competing for the same line.
  await pickActivity(page, "Barbell Bench Press");

  const weightInput = page.getByTestId("set1-weight");
  await expect(weightInput).toBeVisible();

  // The whole point: a realistic 4-character load must be readable back.
  await weightInput.fill("77.5");
  await expect(weightInput).toHaveValue("77.5");
  expect(
    await isClipped(page, "set1-weight"),
    "the weight input clips its own value at 390px — the #1450 regression"
  ).toBe(false);

  // And the field is actually wide enough to be worth tapping, not merely
  // un-clipped because the value happened to be short.
  const box = await weightInput.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(48);

  // The row must not achieve that by overflowing the viewport instead — the app
  // shell clips horizontal overflow, so a too-wide row would hide the options
  // column rather than scroll to it.
  const rowRight = await page
    .getByTestId("set1-weight-stepper")
    .evaluate(() => document.documentElement.scrollWidth);
  expect(rowRight).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth + 2)
  );

  // Reps keep their own room on the same wrapped line.
  expect(await isClipped(page, "set1-weight")).toBe(false);

  // Read-only: leave without saving so no draft outlives the test.
  await page.goto("/training");
});
