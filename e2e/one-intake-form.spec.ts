import { test, expect } from "./fixtures";
import {
  expectNoClippedContent,
  hydratedClick,
  settledClick,
  settledFill,
  settledSelect,
} from "./helpers";
import { closeEditor, openFact } from "./intake-form-helpers";
import { medicationRow } from "./med-card-helpers";

// The one intake form's acceptance path (#3216).
//
// TWO HOSTS, ONE COMPONENT. The layout is intrinsic, so the same form has to be
// correct in the narrow medication panel and in the ~640px supplement modal with no
// per-host layout of its own. And the DEFAULT path has to stay two taps: pick, glance
// at what the form says it will save, Add — with no editor ever opened.

test("changing only the formulation chip adds the children's suspension, in a 390px host", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/medications");
  await page.getByTestId("medication-add-toggle").click();
  const panel = page.getByTestId("medication-add-panel");
  const form = panel.getByTestId("intake-item-form");
  await expect(form).toBeVisible();

  const name = `Ibuprofen susp ${testInfo.repeatEachIndex}-${testInfo.retry}`;
  const nameField = form.getByLabel("Name");
  await nameField.fill("Ibuprofen");
  // The listbox is PORTALED to <body> (#3271) — resolved from the page, not the
  // panel that owns the field. One list is open at a time, so this is unambiguous.
  await page
    .locator('ul[role="listbox"] button', { hasText: "Advil" })
    .first() // first-ok: transient combobox list this test just opened
    .click();

  // One ingredient, several products — the choice is a derived chip row, not a select
  // buried in a dose block.
  const formulations = form.getByTestId("intake-formulation-row");
  await expect(formulations).toBeVisible();
  const suspension = formulations
    .getByTestId("intake-formulation-choice")
    .filter({ hasText: "Children's oral suspension" });
  await expect(suspension).toHaveAttribute("aria-pressed", "false");

  // CHANGE ONLY THE FORMULATION. No editor is opened; the chip row is the whole
  // interaction, and the form still posts every other fact the pick seeded.
  await suspension.click();
  await expect(suspension).toHaveAttribute("aria-pressed", "true");
  await expect(form.getByTestId("intake-fact-dose")).toContainText(
    "Children's oral suspension"
  );
  await expect(form.getByTestId("intake-editor")).toHaveCount(0);

  // The 390px host takes it without horizontal overflow (#2014's intrinsic layout).
  await expectNoClippedContent(page);

  // Rename so this run owns its row, then Add.
  await nameField.fill(name);
  await nameField.press("Escape");
  await settledClick(
    page,
    form.getByRole("button", { name: "Add", exact: true })
  );

  // The formulation reached the row — `product` stores the full curated label, and
  // the shared dose formatter carries its concentration.
  const row = medicationRow(page, name).first(); // first-ok: this test's own row
  await expect(row).toBeVisible();
  await expect(row).toContainText("mL");
});

test("the default path is two taps in the supplement modal, with no editor opened", async ({
  page,
}, testInfo) => {
  const name = `Two Tap Magnesium ${testInfo.repeatEachIndex}-${testInfo.retry}`;
  await page.goto("/nutrition?tab=supplements");
  await page.getByTestId("supplement-add-toggle").click();
  const modal = page.getByRole("dialog", { name: "Add supplement" });
  const form = modal.getByTestId("intake-item-form");
  await expect(form).toBeVisible();

  // TAP ONE: the pick. It seeds the catalog's dose and food relationship.
  await form.getByLabel("Name").fill("Magnesium Glycinate");
  // Portaled listbox (#3271) — resolved from the page, not the modal.
  await page
    .locator('ul[role="listbox"] button', { hasText: "Magnesium Glycinate" })
    .first() // first-ok: transient combobox list this test just opened
    .click();

  // GLANCE: the form states what it will save, and NOTHING is open.
  await expect(form.getByTestId("intake-editor")).toHaveCount(0);
  const factRow = form.getByTestId("intake-fact-row");
  await expect(factRow).toBeVisible();
  await expect(form.getByTestId("intake-fact-dose")).toHaveAttribute(
    "data-fact-state",
    "stated"
  );
  // The kind was DERIVED from the door, so it was never a question.
  await expect(form).toHaveAttribute("data-kind", "supplement");

  // NOTHING ABOUT THE SUGGESTION MARKING IS ASSERTED HERE, and its absence is the fix
  // rather than a gap (#3318). A guarded `if (await suggested.count())` used to stand at
  // this spot, and it never once ran: this pick is Magnesium Glycinate, whose catalog
  // entry sets no food timing, so `suggestedRulesForFoodTiming` returns nothing and the
  // form proposes no rule at all. The body asserted nothing and the test passed. The
  // claim now lives in "the label's proposal is marked suggested…" below, on a pick whose
  // label ALWAYS proposes one, with no guard and both directions pinned.

  // Rename so this run owns its row.
  const nameField = form.getByLabel("Name");
  await nameField.fill(name);
  await nameField.press("Escape");

  // TAP TWO: Add.
  await settledClick(
    page,
    form.getByRole("button", { name: "Add", exact: true })
  );
  await expect(modal).toHaveCount(0);
  await expect(
    page.getByTestId("supplement-row").filter({ hasText: name })
  ).toHaveCount(1);
});

test("a value set in an editor still posts after the editor closes (#2014)", async ({
  page,
}, testInfo) => {
  // The invariant most likely to break silently in a form that shows one editor at a
  // time: a fact edited and then LEFT is still a fact the form saves.
  const name = `Hidden Not Unmounted ${testInfo.repeatEachIndex}-${testInfo.retry}`;
  await page.goto("/nutrition?tab=supplements");
  await page.getByTestId("supplement-add-toggle").click();
  const modal = page.getByRole("dialog", { name: "Add supplement" });
  const form = modal.getByTestId("intake-item-form");
  await form.getByLabel("Name").fill(name);

  const notes = await openFact(page, "notes", modal);
  await notes.getByLabel("Notes").fill("half a scoop on training days");
  await closeEditor(page, modal);

  // Closed — and the chip STATES that the fact is there, before anything is saved.
  await expect(form.getByTestId("intake-fact-notes")).toBeVisible();

  await settledClick(
    page,
    form.getByRole("button", { name: "Add", exact: true })
  );
  await expect(modal).toHaveCount(0);

  // Reopen the saved row: the note round-tripped through a form that never had it
  // on screen at submit time.
  const row = page.getByTestId("supplement-row").filter({ hasText: name });
  await hydratedClick(
    page,
    row.getByRole("button", { name: "Supplement actions" })
  );
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const editModal = page.getByRole("dialog", { name: `Edit ${name}` });
  const savedNotes = await openFact(page, "notes", editModal);
  await expect(savedNotes.getByLabel("Notes")).toHaveValue(
    "half a scoop on training days"
  );
});

test("the label's proposal is marked suggested, and stops being once the person changes it (#1505, #3318)", async ({
  page,
}, testInfo) => {
  // THE MARKING IS PINNED ON THE REMOVABLE CHIP, unconditionally and in both directions.
  // `data-suggested` distinguishes a value supplied FOR the person from one they stated
  // (#846), and on this chip shape nothing else asserted it at runtime — the only claim
  // was guarded by a count that was always zero (#3318).
  //
  // The fixture makes the case EXIST rather than hoping for it: SAMe's catalog entry
  // carries defaultFoodTiming "empty_stomach", so picking it always seeds exactly one
  // suggested rule. If that entry ever loses its food timing, the count assertion below
  // fails loudly instead of quietly asserting nothing.
  const name = `SAMe Offer ${testInfo.repeatEachIndex}-${testInfo.retry}`;
  await page.goto("/nutrition?tab=supplements");
  await page.getByTestId("supplement-add-toggle").click();
  const modal = page.getByRole("dialog", { name: "Add supplement" });
  const form = modal.getByTestId("intake-item-form");
  await expect(form).toBeVisible();

  await form.getByLabel("Name").fill("SAMe");
  // Portaled listbox (#3271) — resolved from the page, not the modal.
  await page
    .locator('ul[role="listbox"] button', { hasText: "SAMe" })
    .first() // first-ok: transient combobox list this test just opened
    .click();

  // THE OFFER. One rule, marked, saying so in words as well as in the attribute.
  const rule = form.getByTestId("intake-fact-rule");
  await expect(rule).toHaveCount(1);
  await expect(rule).toHaveAttribute("data-suggested", "1");
  await expect(rule).toContainText("empty stomach");
  await expect(rule).toContainText("suggested");

  // Open the rules builder from the chip itself. The disclosure is the button carrying
  // `aria-expanded` — the × beside it is a different control, and clicking the chip's
  // centre could land on either.
  const disclosure = rule.locator("button[aria-expanded]");
  await hydratedClick(page, disclosure);
  const editor = form.getByTestId("intake-editor");
  await expect(editor).toHaveAttribute("data-panel", "rules");

  // The person changes the sentence, so it is no longer the label talking. settledSelect
  // rather than a raw selectOption: the value is consumed from React state, and a select
  // changed before hydration is reverted by the next render.
  await settledSelect(page, editor.getByLabel("Food timing"), "with_food");
  await closeEditor(page, modal);

  // THE NEGATIVE, on the same chip: tracked, and now false. Absent would be a different
  // claim — untracked — and this fact is tracked either way, so "0" is the honest value.
  await expect(rule).toHaveAttribute("data-suggested", "0");
  await expect(rule).toContainText("with food");
  await expect(rule).not.toContainText("suggested");

  // And Done put focus back on the disclosure that opened the editor (#3311) — the
  // removable chip shape, which reaches focus through the same `data-fact-key` the plain
  // one does.
  await expect(disclosure).toBeFocused();

  // The offer still saves when it is still there at Save time (#1505).
  const nameField = form.getByLabel("Name");
  await nameField.fill(name);
  await nameField.press("Escape");
  await settledClick(
    page,
    form.getByRole("button", { name: "Add", exact: true })
  );
  await expect(modal).toHaveCount(0);
  await expect(
    page.getByTestId("supplement-row").filter({ hasText: name })
  ).toHaveCount(1);
});

test("Done returns focus to the chip, to its replacement, or to where the fact went (#3311)", async ({
  page,
}, testInfo) => {
  // WHERE FOCUS IS after an editor closes, asserted three times because the primitive
  // has three cases and only the first is the easy one. Opening an editor unmounts the
  // whole chip row, so the element that was activated is ALWAYS gone by the time the
  // editor closes — `previouslyFocused.focus()` would be a no-op in every case here, not
  // just the awkward one. The chip is found again by its fact key instead.
  const name = `Focus Returns ${testInfo.repeatEachIndex}-${testInfo.retry}`;
  await page.goto("/nutrition?tab=supplements");
  await page.getByTestId("supplement-add-toggle").click();
  const modal = page.getByRole("dialog", { name: "Add supplement" });
  const form = modal.getByTestId("intake-item-form");
  await settledFill(page, form.getByLabel("Name"), name);

  // ONE: the fact still has a chip. Focus goes back to it.
  await openFact(page, "dose", modal);
  await closeEditor(page, modal);
  await expect(form.getByTestId("intake-fact-dose")).toBeFocused();

  // TWO: the fact has NO chip, because an optional fact left with nothing to state goes
  // back behind the trailing affordance. Focus follows it there — that is where the
  // person would reach for it again, and it is the control they passed through to get
  // to the editor in the first place. Not the row, which would be true but unhelpful,
  // and not <body>, which is where this used to land.
  await openFact(page, "notes", modal);
  await closeEditor(page, modal);
  await expect(form.getByTestId("intake-fact-notes")).toHaveCount(0);
  await expect(form.getByTestId("intake-fact-more")).toBeFocused();

  // THREE: the fact was stated for the first time, so the chip that reaches focus is not
  // the control that opened the editor — it did not exist then. This is the case the
  // naive element-capture fix cannot serve at all.
  const notes = await openFact(page, "notes", modal);
  await settledFill(page, notes.getByLabel("Notes"), "half a scoop");
  await closeEditor(page, modal);
  await expect(form.getByTestId("intake-fact-notes")).toBeFocused();
});

test("focus returns to the rule sentence that was opened, not to the panel's first door (#3311)", async ({
  page,
}) => {
  // THE CASE THAT MAKES THE FOCUS KEY AND THE PANEL KEY TWO QUESTIONS. Every rule
  // sentence and the "+ rule" prompt open the ONE rules builder, so a restore keyed on
  // the panel has only one answer for four doors: clicking the second rule returns to
  // the first, and tapping "+ rule" returns to a rule the person never touched. Both are
  // right answers to "which editor is this" and wrong answers to "where was I".
  //
  // Not a mechanism built in anticipation — intake draws multiple rule chips today, and
  // this test arranges exactly that.
  await page.goto("/nutrition?tab=supplements");
  await page.getByTestId("supplement-add-toggle").click();
  const modal = page.getByRole("dialog", { name: "Add supplement" });
  const form = modal.getByTestId("intake-item-form");
  await expect(form).toBeVisible();

  // SAMe's label proposes one rule, so the row starts with a sentence already in it.
  await form.getByLabel("Name").fill("SAMe");
  await page
    .locator('ul[role="listbox"] button', { hasText: "SAMe" })
    .first() // first-ok: transient combobox list this test just opened
    .click();
  const rules = form.getByTestId("intake-fact-rule");
  await expect(rules).toHaveCount(1);

  // ADD A SECOND from the "+ rule" prompt. That prompt PERSISTS beside the sentences it
  // adds, so focus comes back to it — the person is most likely to add another, and the
  // chip they used is still there to return to.
  const addRule = form.getByTestId("intake-add-rule");
  await hydratedClick(page, addRule);
  await hydratedClick(page, form.getByTestId("intake-rule-add-only-when"));
  await closeEditor(page, modal);
  await expect(rules).toHaveCount(2);
  await expect(addRule).toBeFocused();

  // NOW OPEN THE SECOND SENTENCE. Keyed on the panel this would return focus to the
  // first; keyed on the chip it returns here. The disclosure is the button carrying
  // aria-expanded — the × beside it is a different control.
  const second = rules.nth(1).locator("button[aria-expanded]"); // nth-ok: this test just created the second rule itself
  await hydratedClick(page, second);
  await expect(form.getByTestId("intake-editor")).toHaveAttribute(
    "data-panel",
    "rules"
  );
  await closeEditor(page, modal);
  await expect(second).toBeFocused();
});
