import { expect, type Locator, type Page } from "@playwright/test";

// THE ESCAPE GRAMMAR OF A DIALOG THAT HOSTS FACTS-WITH-EDITORS, written once (#3409).
//
// Escape means "back out of the innermost thing that is open". Over a facts-with-editors
// form that is two steps, and #3409 is the story of only ever asserting the first:
//
//   1. an editor is open  → Escape returns to the chips, and the dialog STAYS. That half
//      is what the primitive was built for (#3222) and it has always worked.
//   2. nothing is open    → Escape closes the dialog, exactly as it does over any other
//      modal in the app.
//
// STEP 2 SHIPPED BROKEN FOUR TIMES BECAUSE ITS FAILURE IS SILENT. `FactEditorHost`
// marked itself `[data-escape-layer="true"]` unconditionally and its panel is hidden
// rather than unmounted, so `useFocusTrap` yielded every Escape to a layer nobody had
// opened. A person pressing Escape got nothing, on every press — and "nothing happened"
// is what a dismissed keypress looks like whether the dialog is right to stay or not, so
// no reviewer and no spec could tell the two apart by looking.
//
// WHICH IS WHY THIS ASKS FOR BOTH STEPS IN ONE CALL. A spec that presses Escape once and
// checks the chips came back is green against the bug; a spec that presses Escape once
// over a closed row and checks the dialog is gone would have caught it, and nobody wrote
// one. The pair is the contract, so the pair travels together.
export async function expectFactEscapeGrammar(
  page: Page,
  {
    form,
    row,
    openFact,
  }: {
    /**
     * The form (or dialog) that must be GONE once the dialog answers Escape. Any
     * locator that unmounts with the dialog will do — the consumers' specs already
     * hold one.
     */
    form: Locator;
    /** The chip row, which comes back when the editor closes. */
    row: Locator;
    /** Open one fact's editor — the consumer's own `openXFact` helper, bound. */
    openFact: () => Promise<void>;
  }
): Promise<void> {
  await openFact();

  // STEP 1 — the half that already worked, still asserted (an editor is open here).
  await page.keyboard.press("Escape");
  await expect(row).toBeVisible();
  // AND FOCUS CAME BACK WITH IT (#3311). Opening an editor unmounts the chip that was
  // activated, so without the return path focus falls to <body> and the next Tab starts
  // from the top of the document — nothing looks wrong on screen, which is why the four
  // hidden-not-unmounted consumers had never asserted it and the intake form and sleep
  // dialog had. Asked TIER-AGNOSTICALLY, because the primitive lands focus on the chip,
  // else the trailing affordance the fact went back inside, else the row itself, and all
  // three are "the row or something in it" — which is the claim that matters here.
  await expect(
    row.locator(":scope:focus, [data-focus-key]:focus, [data-fact-more]:focus")
  ).toHaveCount(1);
  // Asserted POSITIVELY: the dialog is still standing. Escape reached the editor and
  // stopped there, which is the behaviour a second Escape would otherwise mask.
  await expect(form).toBeVisible();

  // STEP 2 — the previously-silent half, and the reason this file exists.
  await page.keyboard.press("Escape");
  // Asserted as the DISMISSAL, and it cannot pass early: the line above just found the
  // form on screen, so this is a present element that has to LEAVE, not an absence that
  // a slow render could satisfy by accident.
  await expect(form).toHaveCount(0);
}
