import { expect, type Locator } from "@playwright/test";

// Driving the visit pair's forms since they became summary-first (#3223).
//
// EVERY FIELD BEHIND A CHIP IS NOW CONDITIONAL, which is the change specs feel. A field
// that used to be unconditionally on screen is reached in one of two ways depending on
// what the row can state about it, and a spec that hardcodes one of them goes red the
// day the fixture changes shape. So the routing lives here once:
//
//   * a fact the row STATES has its own chip;
//   * an ABSENT OPTIONAL has no chip at all and lives behind the trailing affordance,
//     which opens a menu naming it.
//
// This is a routing decision and not an assertion, which is why it may branch on
// `count()`: it is choosing which control to press, not claiming something is absent.
//
// ONE HELPER FOR BOTH TENSES, because there is one row: an appointment and an encounter
// state the same facts under the same testids and differ only in which columns and which
// Server Action sit behind them. `scope` is whichever form or dialog the caller has
// already narrowed to — the add form and a list's inline edit form both draw a row, so
// the scoping is the caller's and never this file's.

/** The panels a visit form's chip row can open. */
export type VisitFactPanel =
  "provider" | "kind" | "when" | "reason" | "location" | "notes" | "diagnoses";

/**
 * Open one fact's editor, closing whichever editor is already open.
 *
 * `scope` is the form (or dialog) locator. Await its visibility before calling — this
 * helper presses controls and does not wait for the form to arrive.
 */
export async function openVisitFact(
  scope: Locator,
  key: VisitFactPanel
): Promise<void> {
  // The host stays MOUNTED and merely hidden when nothing is open (#3223) — a field the
  // browser cannot see is a field these whole-row writes would CLEAR (#2359). So
  // `isVisible` is the honest question here and does not race a mount.
  if (await scope.getByTestId("visit-fact-editor").isVisible())
    await scope.getByTestId("visit-fact-editor-done").click();

  const row = scope.getByTestId("visit-fact-row");
  await expect(row).toBeVisible();

  const chip = scope.getByTestId(`visit-fact-${key}`);
  if (await chip.count()) {
    await chip.click();
  } else {
    await scope.getByTestId("visit-fact-more").click();
    await scope.getByTestId(`visit-more-${key}`).click();
  }

  await expect(scope.getByTestId("visit-fact-editor")).toHaveAttribute(
    "data-panel",
    key
  );
}

/** Return to the chips. Done and Esc are the same gesture; this is the pointer one. */
export async function closeVisitFact(scope: Locator): Promise<void> {
  await scope.getByTestId("visit-fact-editor-done").click();
  await expect(scope.getByTestId("visit-fact-row")).toBeVisible();
}

/**
 * Open a fact, run one edit inside its editor, and return to the chips.
 *
 * The shape most specs want: they care that a value reached the form, not about the
 * disclosure that carried it.
 */
export async function withVisitFact(
  scope: Locator,
  key: VisitFactPanel,
  edit: () => Promise<void>
): Promise<void> {
  await openVisitFact(scope, key);
  await edit();
  await closeVisitFact(scope);
}
