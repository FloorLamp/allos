import { expect, type Locator } from "@playwright/test";

// Driving the injury bar's two forms since they became summary-first (#3221).
//
// EVERY FIELD BEHIND A CHIP IS NOW CONDITIONAL, which is the change specs feel. A field
// that used to be unconditionally on screen is reached in one of two ways depending on
// what the row can state about it, and a spec that hardcodes one of them goes red the day
// the fixture changes shape. So the routing lives here once:
//
//   * a fact the row STATES has its own chip — including the two ESSENTIALS, which draw a
//     dashed chip when they are still empty rather than disappearing;
//   * an ABSENT OPTIONAL has no chip at all and lives behind the trailing affordance,
//     which opens a menu naming it.
//
// This is a routing decision and not an assertion, which is why it may branch on
// `count()`: it is choosing which control to press, not claiming something is absent.
//
// BOTH FORMS ANSWER TO THE SAME TESTIDS, and callers scope by the form they mean — the
// convention this bar already had (`injury-label-input` was shared by the log form and
// every open edit form long before the chips arrived).

/** The panels the injury bar's chip row can open. */
export type InjuryFactPanel =
  | "label"
  | "regions"
  | "laterality"
  | "movements"
  | "exercises"
  | "status"
  | "loadFactor"
  | "reviewDate";

/**
 * Open one fact's editor, closing whichever editor is already open.
 *
 * `form` is the `injury-form` or `injury-edit-form` testid locator. Await its visibility
 * before calling — this helper presses controls and does not wait for the form to arrive.
 */
export async function openInjuryFact(
  form: Locator,
  key: InjuryFactPanel
): Promise<void> {
  // The host stays MOUNTED and merely hidden when nothing is open, so `isVisible` is the
  // honest question here and does not race a mount.
  if (await form.getByTestId("injury-editor").isVisible())
    await form.getByTestId("injury-editor-done").click();

  const row = form.getByTestId("injury-fact-row");
  await expect(row).toBeVisible();

  const chip = form.getByTestId(`injury-fact-${key}`);
  if (await chip.count()) {
    await chip.click();
  } else {
    await form.getByTestId("injury-fact-more").click();
    await form.getByTestId(`injury-more-${key}`).click();
  }

  await expect(form.getByTestId("injury-editor")).toHaveAttribute(
    "data-panel",
    key
  );
}

/** Return to the chips. Done and Esc are the same gesture; this is the pointer one. */
export async function closeInjuryFact(form: Locator): Promise<void> {
  await form.getByTestId("injury-editor-done").click();
  await expect(form.getByTestId("injury-fact-row")).toBeVisible();
}

/**
 * Open a fact, run one edit inside its editor, and return to the chips.
 *
 * The shape most specs want: they care that a value reached the form, not about the
 * disclosure that carried it.
 */
export async function withInjuryFact(
  form: Locator,
  key: InjuryFactPanel,
  edit: () => Promise<void>
): Promise<void> {
  await openInjuryFact(form, key);
  await edit();
  await closeInjuryFact(form);
}
