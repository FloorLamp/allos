import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import { expectNoClippedContent, settledFill } from "./helpers";

// Issue #1613 — the activity form's sticky exercise header at phone width.
//
// It used to be ONE non-wrapping row: the name combobox plus three activity
// actions (move up / move down / remove). At 390px the actions took ~110px off
// the combobox, the combobox spends another 36 + 144px on its search icon and
// its muscle-badge/clear reserve, and "Barbell Bench Press" rendered as
// "Barbell Bench Pre". The actions themselves were 28–32px — under a phone
// touch target — and the exercise guide consumed yet another, mostly empty,
// right-aligned row below.
//
// The contract now: below `sm` the header is TWO rows. The combobox owns the
// whole first row (badge and clear intact); "How to" plus the reorder/remove
// actions share one second-row toolbar, each at least 44×44. From `sm` up the
// header is the single compact row it always was, so this lives in the mobile
// project (by filename) and asserts geometry rather than a pixel snapshot.
//
// Fixture hygiene (#868): the spec builds its own two-part draft and deletes the
// row it auto-saves, so it owns everything it touches.

async function pickActivity(
  page: Page,
  field: Locator,
  name: string
): Promise<void> {
  await field.fill(name);
  await page
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: name })
    .first() // first-ok: transient combobox list this spec just opened by typing `name`; the first filtered match is the intended option
    .click();
}

async function box(locator: Locator) {
  await expect(locator).toBeVisible();
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

// Delete the auto-saved draft (the completed set makes the activity savable, so
// the debounced autosave creates a row). Waiting for the Delete button is what
// proves the row exists before removing it — see form-fill-paths' note.
async function cleanUpDraft(page: Page): Promise<void> {
  const del = page.getByRole("button", { name: "Delete", exact: true });
  await expect(del).toBeVisible();
  await del.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(page.getByTestId("activity-form")).toBeHidden();
}

test("a multi-part exercise header reads and taps at 390px (#1613)", async ({
  page,
}) => {
  await page.goto("/training");
  // The phone shell labels the editor entry point "Log activity".
  await page
    .getByRole("main")
    .getByRole("button", { name: "Log activity" })
    .click();

  const firstName = page.getByPlaceholder(/What did you do/);
  await pickActivity(page, firstName, "Barbell Bench Press");

  // Complete set 1 so a second part can be added. The weight field is plain now:
  // #1971 retired the focus-applied suggestion, so a typed value is the value.
  const weight = page.getByTestId("set1-weight");
  await weight.fill("60");
  await expect(weight).toHaveValue("60");
  await settledFill(page, page.getByTestId("set1-reps"), "5");

  // Wait for the draft row to exist BEFORE adding the second part, so the
  // teardown has something deterministic to delete.
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();

  await page.getByRole("button", { name: "+ Add activity" }).click();
  const parts = page.getByTestId("activity-part");
  await expect(parts).toHaveCount(2);
  const second = parts.nth(1); // nth-ok: the part this spec just added, addressed by the order it created
  await pickActivity(
    page,
    second.getByPlaceholder(/Add another activity/),
    "Running"
  );

  const first = parts.nth(0); // nth-ok: the lift this spec entered first
  const header = first.getByTestId("part-header");
  const actions = first.getByTestId("part-actions");
  const viewport = page.viewportSize()!;

  // 1. The lift name is fully readable — the reported truncation. The input
  //    scrolling its own value is the direct expression of "clipped", and it
  //    holds whatever the font metrics are.
  await expect(firstName).toHaveValue("Barbell Bench Press");
  expect(
    await firstName.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
    "the exercise name is clipped inside its own input at 390px"
  ).toBe(false);
  // Its muscle badge and clear action are still there.
  await expect(first.getByText("Chest", { exact: true })).toBeVisible();
  await expect(first.getByRole("button", { name: "Clear" })).toBeVisible();

  // 2. Two rows: the combobox spans the first, the toolbar sits under it, and
  //    the actions take no width from the name.
  const headerBox = await box(header);
  const nameBox = await box(firstName);
  const actionsBox = await box(actions);
  expect(nameBox.width).toBeGreaterThanOrEqual(headerBox.width - 12);
  expect(actionsBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height - 1);
  // The toolbar stays inside the viewport.
  expect(actionsBox.x).toBeGreaterThanOrEqual(0);
  expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(viewport.width);

  // 3. "How to" shares that toolbar — there is no guide-only row any more, and
  //    there is exactly one trigger for this part.
  await expect(first.getByTestId("exercise-guide-open")).toHaveCount(1);
  await expect(actions.getByTestId("exercise-guide-open")).toHaveCount(1);

  // 4. Every action meets the phone touch-target minimum, including the DISABLED
  //    reorder control (part 1 cannot move up) and its enabled sibling, and each
  //    keeps its accessible name.
  const up = first.getByRole("button", { name: "Move activity up" });
  const down = first.getByRole("button", { name: "Move activity down" });
  const removePart = first.getByRole("button", { name: "Remove activity" });
  const guide = first.getByTestId("exercise-guide-open");
  await expect(up).toBeDisabled();
  await expect(down).toBeEnabled();
  await expect(
    second.getByRole("button", { name: "Move activity down" })
  ).toBeDisabled();
  for (const control of [up, down, removePart, guide]) {
    const b = await box(control);
    expect(
      b.width,
      "action target is narrower than 44px"
    ).toBeGreaterThanOrEqual(44);
    expect(
      b.height,
      "action target is shorter than 44px"
    ).toBeGreaterThanOrEqual(44);
    // All on one band with the toolbar.
    expect(b.y).toBeGreaterThanOrEqual(actionsBox.y - 1);
    expect(b.y + b.height).toBeLessThanOrEqual(
      actionsBox.y + actionsBox.height + 1
    );
  }

  // 5. The set schema still clears the (now taller) sticky header instead of
  //    scrolling underneath it: its sticky offset IS the header's height.
  const stickyTop = await first
    .getByTestId("set-column-headings")
    .evaluate((el) => parseFloat(getComputedStyle(el).top));
  expect(Math.abs(stickyTop - headerBox.height)).toBeLessThanOrEqual(2);

  // 6. The callbacks are untouched: reordering still swaps the parts.
  await down.click();
  await expect(page.getByPlaceholder(/What did you do/)).toHaveValue("Running");
  await parts
    .nth(1) // nth-ok: the bench part this spec just moved down
    .getByRole("button", { name: "Move activity up" })
    .click();
  await expect(page.getByPlaceholder(/What did you do/)).toHaveValue(
    "Barbell Bench Press"
  );

  // 7. The relocated guide trigger still opens the ONE shared overlay.
  await guide.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("How to: Barbell Bench Press");
  await expect(dialog.getByTestId("exercise-guide")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await expectNoClippedContent(page);

  // Teardown: drop the second part (through the action under test), then delete
  // the auto-saved row so the worker DB is left as it was found.
  await parts
    .nth(1) // nth-ok: the Running part this spec added
    .getByRole("button", { name: "Remove activity" })
    .click();
  await expect(parts).toHaveCount(1);
  await cleanUpDraft(page);
});
