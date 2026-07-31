import { test, expect } from "./fixtures";
import { settledFill } from "./helpers";
// #155: entering a condition by its lay name surfaces an ICD-10-CM code suggestion
// the user CONFIRMS ("Use code"), which fills the code + code-system fields; on save
// the stored code renders in the conditions table. This drives the real form and
// asserts the suggested code round-trips onto the row.
test("manual condition entry suggests an ICD-10-CM code the user can confirm (#155)", async ({
  page,
}) => {
  await page.goto("/records/problems/conditions");

  // Scope to the Conditions section — on the merged Health record page (#1042
  // phase 6) other sections carry a "Condition" field (Family history) and an
  // "Add" button, so an unscoped locator is ambiguous.
  const section = page.getByTestId("records-conditions");
  const nameField = section.getByLabel("Condition", { exact: true });
  await expect(nameField).toBeVisible();
  // Type a lay name that maps to a curated code (Asthma → J45.909). The name is a
  // Combobox over the curated catalog since #1676, so settledFill keeps the typed
  // value out of the pre-hydration revert window.
  await settledFill(page, nameField, "Asthma");

  const suggestion = section.getByTestId("icd10-suggestion");
  await expect(suggestion).toBeVisible();
  await expect(suggestion).toContainText("J45.909");

  // Typing leaves the picker's dropdown open OVER the chip (it hangs directly below
  // the field), exactly as any autocomplete does. Escape dismisses it — the gesture a
  // person makes before reaching for the chip — and the code confirm is unchanged:
  // picking a name never applies a code on its own.
  await nameField.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await section.getByTestId("icd10-suggestion-apply").click();

  // The confirm filled the code + code-system inputs.
  await expect(page.locator("#cond-code-new")).toHaveValue("J45.909");
  await expect(page.locator("#cond-codesys-new")).toHaveValue("ICD-10-CM");

  await section.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Condition saved")).toBeVisible();

  // The stored code renders in the conditions table.
  const row = section.getByRole("row", { name: /Asthma/ });
  // Renders on the form's router.refresh() — a cold shard can outrun the default 5s (imaging/#1306 precedent).
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText("J45.909");
});
