import { expect, type Locator, type Page } from "@playwright/test";
import { hydratedClick } from "./helpers";

// Driving the ONE intake form (#3216).
//
// The form is summary-first: after a pick it renders the facts it will save as a row
// of chips, and a field only becomes an input once you open the chip that states it.
// So a spec that used to `fill()` a field now opens that fact first. This module is
// the one place that knows the mapping, so a spec reads as the user's story ("open
// timing, set the interval") rather than as chip plumbing.

export type IntakeFact =
  | "dose"
  | "timing"
  | "importance"
  | "prescription"
  | "indication"
  | "identity"
  | "supply"
  | "stopDate"
  | "composition"
  | "notes"
  | "rules";

// The form within `scope` (a host panel, a modal, or the page).
export function intakeForm(scope: Page | Locator): Locator {
  return scope.getByTestId("intake-item-form");
}

// Open one fact's editor. An optional fact with nothing to state has no chip of its
// own — it lives behind the trailing affordance — so this tries the chip, then that.
export async function openFact(
  page: Page,
  fact: IntakeFact,
  scope: Page | Locator = page
): Promise<Locator> {
  const form = intakeForm(scope);
  if (fact === "rules") {
    await hydratedClick(page, form.getByTestId("intake-add-rule"));
  } else {
    const chip = form.getByTestId(`intake-fact-${fact}`);
    if (await chip.count()) {
      await hydratedClick(page, chip);
    } else {
      await hydratedClick(page, form.getByTestId("intake-fact-more"));
      await hydratedClick(page, form.getByTestId(`intake-more-${fact}`));
    }
  }
  const editor = form.getByTestId("intake-editor");
  await expect(editor).toBeVisible();
  return editor;
}

// Close whichever editor is open, returning to the chips. Done and Esc are the same
// gesture by contract, so a spec may assert either without knowing which the form used.
export async function closeEditor(
  page: Page,
  scope: Page | Locator = page
): Promise<void> {
  const form = intakeForm(scope);
  await hydratedClick(page, form.getByTestId("intake-editor-done"));
  await expect(form.getByTestId("intake-fact-row")).toBeVisible();
}

// The sentence one fact's chip currently states, or null when it states none.
export async function factText(
  scope: Page | Locator,
  fact: Exclude<IntakeFact, "rules">
): Promise<string | null> {
  const chip = intakeForm(scope).getByTestId(`intake-fact-${fact}`);
  return (await chip.count()) ? ((await chip.textContent()) ?? "") : null;
}

// The name field — the one field the form opens on, and the only one always present.
export function nameField(scope: Page | Locator): Locator {
  return intakeForm(scope).getByLabel("Name");
}

// Set the dose amount, opening the dose editor for it.
export async function setAmount(
  page: Page,
  amount: string,
  scope: Page | Locator = page
): Promise<void> {
  const editor = await openFact(page, "dose", scope);
  await editor.getByLabel("Amount").first().fill(amount);
  await closeEditor(page, scope);
}

// Set the obligation, opening the importance editor for it.
export async function setObligation(
  page: Page,
  value: "must" | "should" | "may",
  scope: Page | Locator = page
): Promise<void> {
  const editor = await openFact(page, "importance", scope);
  await editor.getByTestId("intake-obligation").selectOption(value);
  await closeEditor(page, scope);
}
