import { test, expect } from "@playwright/test";

// #155: entering a condition by its lay name surfaces an ICD-10-CM code suggestion
// the user CONFIRMS ("Use code"), which fills the code + code-system fields; on save
// the stored code renders in the conditions table. This drives the real form and
// asserts the suggested code round-trips onto the row.
test("manual condition entry suggests an ICD-10-CM code the user can confirm (#155)", async ({
  page,
}) => {
  await page.goto("/conditions");

  const nameField = page.getByLabel("Condition", { exact: true });
  await expect(nameField).toBeVisible();
  // Type a lay name that maps to a curated code (Asthma → J45.909).
  await nameField.fill("Asthma");

  const suggestion = page.getByTestId("icd10-suggestion");
  await expect(suggestion).toBeVisible();
  await expect(suggestion).toContainText("J45.909");

  await page.getByTestId("icd10-suggestion-apply").click();

  // The confirm filled the code + code-system inputs.
  await expect(page.locator("#cond-code-new")).toHaveValue("J45.909");
  await expect(page.locator("#cond-codesys-new")).toHaveValue("ICD-10-CM");

  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Condition saved")).toBeVisible();

  // The stored code renders in the conditions table.
  const row = page.getByRole("row", { name: /Asthma/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("J45.909");
});
