import { expect, type Locator } from "@playwright/test";

// Driving the training-goal form since it became summary-first (#3220).
//
// EVERY FIELD BEHIND A CHIP IS NOW CONDITIONAL, which is the change specs feel. A
// field that used to be unconditionally on screen is reached in one of three ways
// depending on what the row can state about it, and a spec that hardcodes one of them
// goes red the day the fixture changes shape. So the routing lives here once:
//
//   * a fact the row STATES has its own chip;
//   * an ABSENT OPTIONAL has no chip at all and lives behind the trailing affordance,
//     which opens a menu naming it;
//   * the subject, when there is not one yet, is a "+ what to track" prompt rather
//     than either — and on a CREATE the subject editor is already open, because
//     there is nothing else a new goal could be about.
//
// This is a routing decision and not an assertion, which is why it may branch on
// `count()`: it is choosing which control to press, not claiming something is absent.

/** The panels the goal form's chip row can open. */
export type GoalFactPanel =
  | "subject"
  | "target"
  | "equipment"
  | "deadline"
  | "startingFrom"
  | "title"
  | "category"
  | "notes";

/**
 * Open one fact's editor, closing whichever editor is already open.
 *
 * `form` is the `goal-form` testid locator. Await the form's visibility before
 * calling — this helper presses controls and does not wait for the form to arrive.
 */
export async function openGoalFact(
  form: Locator,
  key: GoalFactPanel
): Promise<void> {
  // The host stays MOUNTED and merely hidden when nothing is open (#3219/#3220), so
  // `isVisible` is the honest question here and does not race a mount.
  if (await form.getByTestId("goal-editor").isVisible())
    await form.getByTestId("goal-editor-done").click();

  const row = form.getByTestId("goal-fact-row");
  await expect(row).toBeVisible();

  const chip = form.getByTestId(`goal-fact-${key}`);
  if (await chip.count()) {
    await chip.click();
  } else if (key === "subject") {
    await form.getByTestId("goal-fact-add-subject").click();
  } else {
    await form.getByTestId("goal-fact-more").click();
    await form.getByTestId(`goal-more-${key}`).click();
  }

  await expect(form.getByTestId("goal-editor")).toHaveAttribute(
    "data-panel",
    key
  );
}

/** Return to the chips. Done and Esc are the same gesture; this is the pointer one. */
export async function closeGoalFact(form: Locator): Promise<void> {
  await form.getByTestId("goal-editor-done").click();
  await expect(form.getByTestId("goal-fact-row")).toBeVisible();
}

/**
 * Open a fact, run one edit inside its editor, and return to the chips.
 *
 * The shape most specs want: they care that a value reached the form, not about the
 * disclosure that carried it.
 */
export async function withGoalFact(
  form: Locator,
  key: GoalFactPanel,
  edit: () => Promise<void>
): Promise<void> {
  await openGoalFact(form, key);
  await edit();
  await closeGoalFact(form);
}
