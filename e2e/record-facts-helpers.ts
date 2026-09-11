import { expect, type Locator, type Page } from "@playwright/test";

// Driving a CLINICAL RECORD FORM since the family became summary-first (#5302).
//
// Written once for the thirteen rather than thirteen times, because every one of them
// wears the same four testids — `<form>-fact-row`, `<form>-fact-<key>`,
// `<form>-fact-more`, `<form>-more-<key>`, `<form>-editor` — and the routing a spec
// needs is identical at each address. `e2e/protocol-form-helpers.ts` is the same file
// for the one protocol form; this is its record-family twin, parameterised by the
// form's own testid prefix so a slice adopting a new form writes no helper at all.
//
// EVERY FIELD BEHIND A CHIP IS NOW CONDITIONAL, which is the change specs feel. A fact
// the row STATES has its own chip; an ABSENT OPTIONAL has no chip at all and lives
// behind the trailing affordance, which opens a menu naming it. A spec that hardcodes
// one of those goes red the day its fixture changes shape, so the choice lives here.
// It is a routing decision and not an assertion, which is why it may branch on
// `count()`: it is choosing which control to press, not claiming something is absent.

/**
 * Open one fact's editor, closing whichever editor is already open.
 *
 * `form` is the `<prefix>-form` testid locator; await its visibility before calling.
 * `panel` is the editor the chip opens, which is usually the chip's own key — the
 * exception being a form whose several chips share one editor (the allergy form's
 * reaction and severity, #1405).
 */
export async function openRecordFact(
  form: Locator,
  prefix: string,
  key: string,
  panel: string = key
): Promise<void> {
  // The host stays MOUNTED and merely hidden when nothing is open, so `isVisible` is
  // the honest question here and does not race a mount.
  if (await form.getByTestId(`${prefix}-editor`).isVisible())
    await form.getByTestId(`${prefix}-editor-done`).click();

  await expect(form.getByTestId(`${prefix}-fact-row`)).toBeVisible();

  const chip = form.getByTestId(`${prefix}-fact-${key}`);
  if (await chip.count()) {
    await chip.click();
  } else {
    await form.getByTestId(`${prefix}-fact-more`).click();
    await form.getByTestId(`${prefix}-more-${key}`).click();
  }

  await expect(form.getByTestId(`${prefix}-editor`)).toHaveAttribute(
    "data-panel",
    panel
  );
}

/** Return to the chips. Done and Esc are the same gesture; this is the pointer one. */
export async function closeRecordFact(
  form: Locator,
  prefix: string
): Promise<void> {
  await form.getByTestId(`${prefix}-editor-done`).click();
  await expect(form.getByTestId(`${prefix}-fact-row`)).toBeVisible();
}

/**
 * Open a fact, run one edit inside its editor, and return to the chips.
 *
 * The shape most specs want: they care that a value reached the form, not about the
 * disclosure that carried it.
 */
export async function withRecordFact(
  form: Locator,
  prefix: string,
  key: string,
  edit: () => Promise<void>,
  panel?: string
): Promise<void> {
  await openRecordFact(form, prefix, key, panel);
  await edit();
  await closeRecordFact(form, prefix);
}

/**
 * Open a fact whose editor holds a `DateField`, fill it, and return to the chips.
 *
 * A DATE IS THE ONE FIELD THIS FAMILY CANNOT DRIVE WITH `withRecordFact`, and the
 * reason is a collision between two real layers rather than a test convenience.
 * Filling the display field opens `DateField`'s anchored calendar, which must be
 * dismissed before anything below it can be clicked or measured — and the dismissal
 * gesture is Escape, which is ALSO the fact editor's own close. So the editor may or
 * may not still be open afterwards, and pressing Done unconditionally would click a
 * control that is no longer there. The `isVisible` branch is routing (which control to
 * press), not an assertion that something is absent.
 *
 * Written once here after #5302 slice 4 took the family to four forms with a date
 * behind a chip; the care-plan spec had this inline first.
 */
export async function withRecordDateFact(
  page: Page,
  form: Locator,
  prefix: string,
  key: string,
  fill: () => Promise<void>
): Promise<void> {
  await openRecordFact(form, prefix, key);
  await fill();
  await page.keyboard.press("Escape");
  if (await form.getByTestId(`${prefix}-editor`).isVisible())
    await form.getByTestId(`${prefix}-editor-done`).click();
  await expect(form.getByTestId(`${prefix}-fact-row`)).toBeVisible();
}
