import { test, expect } from "./fixtures";
import { expectNoClippedContent, hydratedClick, settledClick } from "./helpers";
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

  // A seeded rule is an OFFER: marked suggested, and deletable before save (#1505).
  const suggested = form
    .getByTestId("intake-fact-rule")
    .filter({ has: page.getByText("suggested") });
  if (await suggested.count())
    await expect(suggested.first()).toHaveAttribute("data-suggested", "1"); // first-ok: any seeded rule proves the marking

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
