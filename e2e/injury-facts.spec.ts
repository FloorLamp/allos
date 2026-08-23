import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import { hydratedClick, settledClick } from "./helpers";
import { closeInjuryFact, openInjuryFact } from "./injury-form-helpers";

// Issue #3221 — the injury bar's forms in the facts-with-editors grammar (#3218), pinned
// at RUNTIME. The source-scan half lives in lib/__tests__/fact-editors-reuse.test.ts and
// asks whether this surface MOUNTS the primitive; this file asks what the primitive then
// does in a browser, which is a different question and the only one that can catch a
// chip that renders but never opens.
//
// THIS IS THE FIRST FACTS-WITH-EDITORS CONSUMER THAT IS NOT INSIDE A MODAL, and that
// changes exactly one assertion. The six before it are dialogs, so `expectFactEscapeGrammar`
// asks for two steps: Escape returns to the chips, and the NEXT Escape dismisses the
// dialog (#3409, the half that shipped broken four times because its failure is silent).
// The injury bar is a card on the Training overview — there is no dialog behind the form
// and nothing for a second Escape to close. The honest counterpart is asserted below: the
// second Escape must leave the form STANDING, which is what would go red if this host
// ever started claiming to be an escape layer it is not.
//
// OWNS ITS FIXTURE (create-and-clean, #868): every injury this file logs carries a label
// no other spec uses, and each test deletes what it made through the bar's own control.
// Nothing here asserts that the profile has no OTHER injuries, so it neither needs the
// table wiped nor cares who else is logging one.

const LABEL_TYPED = "facts row typed 1";
const LABEL_GUARD = "facts row guard 1";

async function openLogForm(page: Page) {
  await page.goto("/training?tab=overview");
  const bar = page.getByRole("main").getByTestId("injury-bar");
  await expect(bar).toBeVisible();
  // A pure client toggle and the first interaction after a navigation, so the tap itself
  // can be lost pre-hydration with no error (#2942).
  await hydratedClick(page, bar.getByTestId("injury-add-toggle"));
  const form = bar.getByTestId("injury-form");
  await expect(form).toBeVisible();
  return { bar, form };
}

/** Delete the injury this test made, through the bar's own control. */
async function removeInjury(
  page: Page,
  bar: Locator,
  label: string
): Promise<void> {
  const chip = bar.getByTestId("injury-chip").filter({ hasText: label });
  await settledClick(
    page,
    chip.getByRole("button", { name: `Delete ${label}` })
  );
  await expect(
    bar.getByTestId("injury-chip").filter({ hasText: label })
  ).toHaveCount(0);
}

test("the row states the facts, prompts for the two essentials, and names what it is holding back", async ({
  page,
}) => {
  const { form } = await openLogForm(page);

  const row = form.getByTestId("injury-fact-row");
  await expect(row).toBeVisible();

  // THE TWO ESSENTIALS ARE THE TWO THE WRITE REFUSES WITHOUT, and they render as DASHED
  // prompts rather than as absences — the form already knows it wants them.
  await expect(form.getByTestId("injury-fact-label")).toHaveAttribute(
    "data-fact-state",
    "missing"
  );
  await expect(form.getByTestId("injury-fact-regions")).toHaveAttribute(
    "data-fact-state",
    "missing"
  );
  // The status is a fact the form WILL write, so it is stated rather than prompted for.
  await expect(form.getByTestId("injury-fact-status")).toHaveAttribute(
    "data-fact-state",
    "stated"
  );

  // THE #2024 PRECISION IS ABSENT-OPTIONAL, so it draws no chip at all and the one
  // trailing affordance NAMES what it holds — "more" must never mean "somewhere in here".
  await expect(form.getByTestId("injury-fact-laterality")).toHaveCount(0);
  await expect(form.getByTestId("injury-fact-movements")).toHaveCount(0);
  const more = form.getByTestId("injury-fact-more");
  await expect(more).toContainText("side");
  await expect(more).toContainText("movements");
  await expect(more).toContainText("lifts");

  // AND THE FIELDS ARE STILL IN THE DOCUMENT while their panels are closed — the
  // hidden-not-unmounted contract this DOM-collected form depends on (#2014/#2359). Asked
  // as both halves, because "not visible" alone is equally true of a field that was
  // unmounted, which is the failure this is here to exclude.
  await expect(form.getByTestId("injury-movement-push")).toHaveCount(1);
  await expect(form.getByTestId("injury-movement-push")).toBeHidden();
});

test("one editor at a time, and Done brings focus back to the chip that opened it", async ({
  page,
}) => {
  const { form } = await openLogForm(page);

  await openInjuryFact(form, "label");
  // The row is UNMOUNTED while an editor is open: the form is either stating what it
  // will save or asking about exactly one fact, never both.
  await expect(form.getByTestId("injury-fact-row")).toHaveCount(0);
  await expect(form.getByTestId("injury-label-input")).toBeVisible();

  await closeInjuryFact(form);
  // #3311 — opening an editor unmounts the chip that was activated, so focus is put back
  // by KEY rather than by element. Without it the next Tab starts from the top of the
  // document, and nothing on screen looks wrong.
  await expect(form.locator('[data-focus-key="label"]:focus')).toHaveCount(1);
});

test("Escape returns to the chips, and the second one leaves this form standing", async ({
  page,
}) => {
  const { form } = await openLogForm(page);

  await openInjuryFact(form, "regions");
  await page.keyboard.press("Escape");
  await expect(form.getByTestId("injury-fact-row")).toBeVisible();
  await expect(
    form.locator(
      "[data-fact-row]:focus, [data-focus-key]:focus, [data-fact-more]:focus"
    )
  ).toHaveCount(1);

  // THE NON-MODAL HALF (see this file's header). The six dialog consumers assert that the
  // next Escape dismisses the dialog; here there is no dialog, so the claim is that
  // nothing else goes away either. It cannot pass early: the line above just found the row
  // on screen, and this asks for a present element to STILL be present after a keypress.
  await page.keyboard.press("Escape");
  await expect(form).toBeVisible();
  await expect(form.getByTestId("injury-fact-row")).toBeVisible();
});

test("a closed panel keeps what you typed, and the whole declaration reaches the write", async ({
  page,
}) => {
  const { bar, form } = await openLogForm(page);

  // Four facts, each answered behind its own chip and then CLOSED — two of them reached
  // through the trailing affordance. If a closed panel unmounted its field, the browser
  // would gather no value for it and the save would write a blank (#2359).
  await openInjuryFact(form, "label");
  await form.getByTestId("injury-label-input").fill(LABEL_TYPED);
  await openInjuryFact(form, "regions");
  await form.getByTestId("injury-region-Arms").check();
  await openInjuryFact(form, "status");
  await form.getByTestId("injury-status").selectOption("recovering");
  await openInjuryFact(form, "loadFactor");
  await form.getByTestId("injury-load-factor-input").selectOption("0.7");
  await closeInjuryFact(form);

  // The row states all four back before anything is written, which is the summary's
  // whole job — this is the read the person confirms.
  await expect(form.getByTestId("injury-fact-label")).toContainText(
    LABEL_TYPED
  );
  await expect(form.getByTestId("injury-fact-regions")).toContainText("Arms");
  await expect(form.getByTestId("injury-fact-status")).toContainText(
    "Recovering"
  );
  await expect(form.getByTestId("injury-fact-loadFactor")).toContainText("70");

  await settledClick(page, form.getByTestId("injury-submit"));

  // …and all four landed IN ONE WRITE. The load preference is the one that would have
  // been silently lost: it is the fact the person had to go LOOKING for, so it is also
  // the one nobody would notice missing. It also only persists on a RECOVERING injury
  // (`logInjuryCore` stores it under that condition), which is why the status is set in
  // the same form rather than switched afterwards — a later status change would clear it
  // and the assertion would be measuring the wrong thing.
  const chip = bar.getByTestId("injury-chip").filter({ hasText: LABEL_TYPED });
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Recovering");
  await expect(chip.getByTestId("injury-scope")).toContainText("Arms");
  await expect(chip.getByTestId("injury-load-factor")).toContainText("70%");

  await removeInjury(page, bar, LABEL_TYPED);
});

test("submitting with a fact missing says so and OPENS it, rather than refusing invisibly", async ({
  page,
}) => {
  const { bar, form } = await openLogForm(page);

  // `required` cannot do this any more. A required control inside a display:none panel
  // makes the browser block the submit with "An invalid form control is not focusable"
  // and show the person NOTHING — the same trade #3220 made. So the form asks itself,
  // says which fact is missing, and opens it.
  await form.getByTestId("injury-submit").click();
  await expect(form.getByTestId("injury-error")).toBeVisible();
  await expect(form.getByTestId("injury-editor")).toHaveAttribute(
    "data-panel",
    "label"
  );

  // Answer that one and the guard moves to the next fact the write would refuse over,
  // rather than reporting the same one twice or letting a doomed submit through.
  await form.getByTestId("injury-label-input").fill(LABEL_GUARD);
  await form.getByTestId("injury-submit").click();
  await expect(form.getByTestId("injury-editor")).toHaveAttribute(
    "data-panel",
    "regions"
  );

  await form.getByTestId("injury-region-Arms").check();
  await settledClick(page, form.getByTestId("injury-submit"));
  await expect(
    bar.getByTestId("injury-chip").filter({ hasText: LABEL_GUARD })
  ).toBeVisible();

  await removeInjury(page, bar, LABEL_GUARD);
});
