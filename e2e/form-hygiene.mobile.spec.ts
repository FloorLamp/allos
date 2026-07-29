import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import { expectNoClippedContent, settledFill } from "./helpers";
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
// The row now wraps below `sm`: "Set N" and the options share the first line as
// one compact toolbar, weight × reps take the second at full width, and the
// stepper's min-width states its real contract (two ±buttons + padding + four
// characters). This spec drives the real editor at 390px and asserts the INPUT
// can display its own value — scrollWidth fitting clientWidth is the direct
// expression of "not clipped", and it holds regardless of font metrics, so it is
// not a pixel snapshot. It runs in the `mobile` Playwright project (#1420) by
// filename.
//
// The two-row GROUPING that keeps those bands legible as one set is #1612's
// contract, asserted below as geometry.
//
// Fixture hygiene (#868): the spec creates its own draft activity and deletes
// whatever it auto-saved, so it owns everything it touches and asserts no
// shared-seed counts.

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

// A visible element's box, asserted non-null so the callers read as geometry
// rather than as null-handling.
async function box(locator: Locator) {
  await expect(locator).toBeVisible();
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

// Open the phone editor on a fresh draft. The phone shell labels the entry point
// "Log activity" (the desktop hub says "New activity").
async function openEditor(page: Page): Promise<void> {
  await page.goto("/training");
  await page
    .getByRole("main")
    .getByRole("button", { name: "Log activity" })
    .click();
}

// Fill set 1's weight past its ghost SUGGESTION (see the note in the #1450 test:
// focusing the field applies the coached load, so a bare fill races it).
async function fillSet1Weight(page: Page, value: string): Promise<void> {
  const weight = page.getByTestId("set1-weight");
  await weight.focus();
  await expect(async () => {
    await weight.fill(value);
    await expect(weight).toHaveValue(value, { timeout: 2_000 });
  }).toPass({ timeout: 15_000 }); // topass-ok: the focus-applied suggestion can overwrite a fill that lands first — one non-atomic step a bare expect cannot re-drive
}

// Delete the auto-saved draft so the worker's DB is left as this spec found it.
// A COMPLETE set makes the activity savable and the debounced autosave creates a
// row; the Delete button appears only once that row exists, so waiting on it is
// what makes the cleanup real (the form-fill-paths precedent).
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

test("the live set row shows a 4-character load at 390px (#1450)", async ({
  page,
}) => {
  await openEditor(page);

  // A barbell lift, so the row renders its widest form: both steppers plus the
  // plate-math button competing for the same line.
  await pickActivity(page, "Barbell Bench Press");

  const weightInput = page.getByTestId("set1-weight");
  await expect(weightInput).toBeVisible();

  // Set 1's weight carries a ghost SUGGESTION that the field applies on focus
  // (StrengthSets' onApplySuggestion), so a bare fill races it: the fill lands,
  // then the suggested load overwrites it ("82.7775"). Let the suggestion settle
  // first, then retry the fill until the value we typed is the one that stuck.
  await weightInput.focus();
  await expect(weightInput).toHaveValue(/^\d/);

  // The whole point: a realistic 4-character load must be readable back.
  await fillSet1Weight(page, "77.5");
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
  // column rather than scroll to it. That clipping is exactly why this is an
  // ELEMENT-level check (#1543): a page-level width comparison sees nothing.
  await expectNoClippedContent(page);

  // Reps keep their own room on the same value row. (This check used to inspect
  // `set1-weight` a second time — a copy/paste that asserted nothing new; the
  // reps input now carries its own testid so it can be checked for real.)
  const reps = page.getByTestId("set1-reps");
  await settledFill(page, reps, "12");
  expect(
    await isClipped(page, "set1-reps"),
    "the reps input clips its own value at 390px"
  ).toBe(false);

  // Focusing the weight applied the coached suggestion, which fills REPS too —
  // so this set has been complete since then and the debounced autosave has
  // created a row. (The test used to just navigate away, on the belief that it
  // had saved nothing.) Delete it, so the worker DB is left as it was found.
  await cleanUpDraft(page);
});

// #1612 — the phone set row. #1450's fix made the row WRAP so a four-character
// load stayed readable, but the options column stayed a 64px two-line stack, so
// each set broke into three disconnected bands: "Set N … RPE", then "W / ×",
// then the values. The load was legible and the controls no longer looked like
// they belonged to it.
//
// The contract now: below `sm`, a set is exactly TWO rows — one identity/options
// toolbar (Set N at the start, RPE + warm-up + remove sharing one band at the
// end) and one full-width value row under it. This asserts the geometry, so a
// future flex tweak that re-splits the row fails here rather than on a phone.
test("each set groups its identity and options above its values at 390px (#1612)", async ({
  page,
}) => {
  await openEditor(page);
  await pickActivity(page, "Barbell Bench Press");

  // Three sets, the reported case. Each `+ Add set` needs the previous set
  // complete, so this fills as it goes; the completed sets make the draft
  // savable, which is why the test deletes its row at the end.
  await fillSet1Weight(page, "60");
  await settledFill(page, page.getByTestId("set1-reps"), "5");
  for (const n of [2, 3]) {
    await page.getByRole("button", { name: "+ Add set" }).click();
    await settledFill(page, page.getByTestId(`set${n}-weight`), "60");
    await settledFill(page, page.getByTestId(`set${n}-reps`), "5");
  }
  await expect(page.getByTestId("set-row-3")).toBeVisible();

  const viewport = page.viewportSize()!;
  for (const n of [1, 2, 3]) {
    const label = await box(page.getByTestId(`set-label-${n}`));
    const options = await box(page.getByTestId(`set-options-${n}`));
    const values = await box(page.getByTestId(`set-values-${n}`));

    // One toolbar band: "Set N" sits WITHIN the options band's vertical extent,
    // and the options sit to its right — not on a line of their own.
    expect(
      label.y + label.height / 2,
      `set ${n}: the label and its options are not on one band`
    ).toBeGreaterThanOrEqual(options.y - 1);
    expect(label.y + label.height / 2).toBeLessThanOrEqual(
      options.y + options.height + 1
    );
    expect(label.x + label.width).toBeLessThanOrEqual(options.x + 1);

    // …and the values are the SECOND row, below that whole band.
    expect(
      values.y,
      `set ${n}: the value row is not below the identity/options row`
    ).toBeGreaterThanOrEqual(options.y + options.height - 1);
    // Two rows, not three: the gap between them is a layout gap, not a band.
    expect(values.y - (options.y + options.height)).toBeLessThanOrEqual(12);

    // The value row spans the width the sticky schema heading describes, and
    // neither row escapes the viewport.
    expect(values.width).toBeGreaterThan(viewport.width * 0.8);
    expect(options.x + options.width).toBeLessThanOrEqual(viewport.width);
    expect(values.x).toBeGreaterThanOrEqual(0);
    expect(values.x + values.width).toBeLessThanOrEqual(viewport.width);
  }

  // RPE, warm-up and remove share the toolbar band with each other too.
  const rpe = await box(page.getByTestId("set1-rpe"));
  const warmup = await box(page.getByTestId("set1-warmup"));
  const removeSet = await box(page.getByTestId("set-remove-1"));
  for (const b of [warmup, removeSet]) {
    expect(b.y).toBeLessThan(rpe.y + rpe.height);
    expect(b.y + b.height).toBeGreaterThan(rpe.y);
  }
  // Phone-sized targets for the ones that are a bare glyph (#1613's rule, held
  // here too now that the toolbar has room for them).
  for (const b of [warmup, removeSet]) {
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.height).toBeGreaterThanOrEqual(44);
  }

  // The sticky schema shows only the VALUE schema on a phone, aligned to the
  // steppers — no detached "Set / Options" headings.
  const headings = page.getByTestId("set-column-headings");
  await expect(headings.getByTestId("weight-column-heading")).toBeVisible();
  await expect(headings.getByTestId("reps-column-heading")).toBeVisible();
  // The desktop table furniture is not rendered on a phone (the headings stay in
  // the DOM for `sm` and up, so this asserts they are not SHOWN).
  await expect(headings.getByText("Set", { exact: true })).toBeHidden();
  await expect(headings.getByText("Options", { exact: true })).toBeHidden();
  const headingBox = await box(headings);
  const values1 = await box(page.getByTestId("set-values-1"));
  expect(Math.abs(headingBox.x - values1.x)).toBeLessThanOrEqual(6);

  await expectNoClippedContent(page);
  await cleanUpDraft(page);
});

// The per-side branch is its own `order-last basis-full` container (#1612 asks
// for it explicitly), so it gets its own geometry check. Nothing is filled here:
// revealing the L/R rows is enough to lay them out, and an empty set never
// auto-saves, so this test owns no persisted data at all.
test("a per-side set keeps the same two-row grouping at 390px (#1612)", async ({
  page,
}) => {
  await openEditor(page);
  await pickActivity(page, "Hammer Curl");

  await page.getByText("Track sides separately", { exact: true }).click();
  await expect(page.getByTestId("per-side-checkbox")).toBeChecked();
  // Both sides render, each with its own reps stepper.
  await expect(page.getByLabel("Add a rep")).toHaveCount(2);

  const label = await box(page.getByTestId("set-label-1"));
  const options = await box(page.getByTestId("set-options-1"));
  const values = await box(page.getByTestId("set-values-1"));
  const viewport = page.viewportSize()!;

  expect(label.x + label.width).toBeLessThanOrEqual(options.x + 1);
  expect(label.y + label.height / 2).toBeGreaterThanOrEqual(options.y - 1);
  expect(label.y + label.height / 2).toBeLessThanOrEqual(
    options.y + options.height + 1
  );
  // The L and R rows stack under the toolbar, full width, inside the viewport.
  expect(values.y).toBeGreaterThanOrEqual(options.y + options.height - 1);
  expect(values.width).toBeGreaterThan(viewport.width * 0.8);
  expect(values.x + values.width).toBeLessThanOrEqual(viewport.width);

  await expectNoClippedContent(page);
  await page.goto("/training");
});
