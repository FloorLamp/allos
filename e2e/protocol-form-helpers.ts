import { expect, type Locator } from "@playwright/test";

// Driving the protocol form since it became summary-first (#3219).
//
// EVERY FIELD BEHIND A CHIP IS NOW CONDITIONAL, which is the change specs feel. A
// field that used to be unconditionally on screen is reached in one of three ways
// depending on what the row can state about it, and a spec that hardcodes one of them
// goes red the day the fixture changes shape. So the routing lives here once:
//
//   * a fact the row STATES has its own chip;
//   * an ABSENT OPTIONAL has no chip at all and lives behind the trailing affordance,
//     which opens a menu naming it;
//   * the practice, when there is not one yet, is a "+ practice" prompt rather than
//     either.
//
// This is a routing decision and not an assertion, which is why it may branch on
// `count()`: it is choosing which control to press, not claiming something is absent.

/** The panels the protocol form's chip row can open. */
export type ProtocolFactPanel =
  | "practice"
  | "cadence"
  | "window"
  | "link"
  | "situation"
  | "notes";

/**
 * Open one fact's editor, closing whichever editor is already open.
 *
 * `form` is the `protocol-form` testid locator. Await the form's visibility before
 * calling — this helper presses controls and does not wait for the form to arrive.
 */
export async function openProtocolFact(
  form: Locator,
  key: ProtocolFactPanel
): Promise<void> {
  // The host stays MOUNTED and merely hidden when nothing is open (#3219), so
  // `isVisible` is the honest question here and does not race a mount.
  if (await form.getByTestId("protocol-editor").isVisible())
    await form.getByTestId("protocol-editor-done").click();

  const row = form.getByTestId("protocol-fact-row");
  await expect(row).toBeVisible();

  const chip = form.getByTestId(`protocol-fact-${key}`);
  if (await chip.count()) {
    await chip.click();
  } else if (key === "practice") {
    await form.getByTestId("protocol-fact-add-practice").click();
  } else {
    await form.getByTestId("protocol-fact-more").click();
    await form.getByTestId(`protocol-more-${key}`).click();
  }

  await expect(form.getByTestId("protocol-editor")).toHaveAttribute(
    "data-panel",
    key
  );
}

/** Return to the chips. Done and Esc are the same gesture; this is the pointer one. */
export async function closeProtocolFact(form: Locator): Promise<void> {
  await form.getByTestId("protocol-editor-done").click();
  await expect(form.getByTestId("protocol-fact-row")).toBeVisible();
}

/**
 * Open a fact, run one edit inside its editor, and return to the chips.
 *
 * The shape most specs want: they care that a value reached the form, not about the
 * disclosure that carried it.
 */
export async function withProtocolFact(
  form: Locator,
  key: ProtocolFactPanel,
  edit: () => Promise<void>
): Promise<void> {
  await openProtocolFact(form, key);
  await edit();
  await closeProtocolFact(form);
}
