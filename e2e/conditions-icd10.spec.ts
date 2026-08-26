import { test, expect } from "./fixtures";
import { hydratedClick, openCareOverviewSection, settledFill } from "./helpers";
import { loginAs } from "./nav";
import { E2E_LOGIN_REPORTS_EMPTY, E2E_MEMBER_PASSWORD } from "./fixture-logins";
// #155: entering a condition by its lay name surfaces an ICD-10-CM code suggestion
// the user CONFIRMS ("Use code"), which fills the code + code-system fields; on save
// the stored code renders in the conditions table. This drives the real form and
// asserts the suggested code round-trips onto the row.
test("manual condition entry suggests an ICD-10-CM code the user can confirm (#155)", async ({
  page,
}) => {
  await page.goto("/records/problems/conditions");
  await hydratedClick(page, page.getByTestId("add-condition-panel-toggle"));

  // Scope to the Conditions section — on the merged Health record page (#1042
  // phase 6) other sections carry a "Condition" field (Family history) and an
  // "Add" button, so an unscoped locator is ambiguous.
  const section = page.getByTestId("records-conditions");
  const dialog = page.getByRole("dialog", { name: "Add condition" });
  const nameField = dialog.getByLabel("Condition", { exact: true });
  await expect(nameField).toBeVisible();
  // Type a lay name that maps to a curated code (Asthma → J45.909). The name is a
  // Combobox over the curated catalog since #1676, so settledFill keeps the typed
  // value out of the pre-hydration revert window.
  await settledFill(page, nameField, "Asthma");

  const suggestion = dialog.getByTestId("icd10-suggestion");
  await expect(suggestion).toBeVisible();
  await expect(suggestion).toContainText("J45.909");

  // Typing leaves the picker's dropdown open OVER the chip (it hangs directly below
  // the field), exactly as any autocomplete does. Escape dismisses it — the gesture a
  // person makes before reaching for the chip. TYPING still applies nothing on its
  // own: the confirm is what writes the code.
  await nameField.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await dialog.getByTestId("icd10-suggestion-apply").click();

  // The confirm filled the code + code-system inputs.
  await expect(dialog.locator("#cond-code-new")).toHaveValue("J45.909");
  await expect(dialog.locator("#cond-codesys-new")).toHaveValue("ICD-10-CM");

  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Condition saved")).toBeVisible();

  // The stored code renders in the conditions table.
  const row = section.getByRole("row", { name: /Asthma/ });
  // Renders on the save action's revalidated tree — a cold shard can outrun the default 5s (imaging/#1306 precedent).
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText("J45.909");
});

// Owner ruling (2026-07-31, #1676): an explicit PICK from the ICD-10 dropdown applies
// that entry's code immediately, mirroring the medication form's RxNorm auto-confirm
// on a catalog pick. A pick is a stronger statement than a typed string — you chose
// the coded concept by name — so it needs no second confirm. The typed path above is
// untouched, which is why both tests exist.
test("picking a condition from the catalog applies its ICD-10-CM code (#1676)", async ({
  page,
}) => {
  await page.goto("/records/problems/conditions");
  await hydratedClick(page, page.getByTestId("add-condition-panel-toggle"));

  const dialog = page.getByRole("dialog", { name: "Add condition" });
  const nameField = dialog.getByLabel("Condition", { exact: true });
  await expect(nameField).toBeVisible();
  await expect(dialog.locator("#cond-code-new")).toHaveValue("");

  // A synonym query reaches the catalog entry whose display name is nothing like it —
  // the hidden search terms doing their job.
  await settledFill(page, nameField, "high blood pressure");
  await page
    .getByRole("listbox")
    .getByRole("option", { name: "Essential (primary) hypertension" })
    .click();

  // The pick filled the name AND the coded identity, with no confirm step.
  await expect(nameField).toHaveValue("Essential (primary) hypertension");
  await expect(dialog.locator("#cond-code-new")).toHaveValue("I10");
  await expect(dialog.locator("#cond-codesys-new")).toHaveValue("ICD-10-CM");

  // The confirm chip is for a code-LESS row, so it is gone once the pick applied one.
  await expect(dialog.getByTestId("icd10-suggestion")).toHaveCount(0);

  // Editing the name away from the picked entry retracts the code the pick applied —
  // the row must never claim a code for a concept it no longer names.
  await settledFill(page, nameField, "Something else entirely");
  await expect(dialog.locator("#cond-code-new")).toHaveValue("");
  await expect(dialog.locator("#cond-codesys-new")).toHaveValue("");
});

// The same ruling, on the other surface that runs this picker beside these fields.
// Family history has no confirm-to-apply chip of its own, so before #1676 a
// family-history row could only ever get a code by hand; a pick now supplies it.
test("picking a family-history condition applies its ICD-10-CM code too (#1676)", async ({
  page,
}) => {
  await page.goto("/records/care/overview");
  // Native <details> (#1804), opened through the shared, `open`-guarded helper
  // (#2231). The unconditional summary click this replaced was the same bug from the
  // other side: it CLOSES a section anything else has already opened.
  await openCareOverviewSection(page, "records-family-history");
  await hydratedClick(
    page,
    page.getByTestId("add-family-history-panel-toggle")
  );

  // Scope to the Family history section: the stacked Care › Overview pane renders
  // several forms, and "Condition" is not unique across the page.
  const dialog = page.getByRole("dialog", { name: "Add family history" });
  const conditionField = dialog.getByLabel("Condition", { exact: true });
  await expect(conditionField).toBeVisible();
  await expect(dialog.locator("#fh-code-new")).toHaveValue("");

  await settledFill(page, conditionField, "type 2 diabetes");
  await page
    .getByRole("listbox")
    .getByRole("option", {
      name: "Type 2 diabetes mellitus without complications",
    })
    .click();

  await expect(conditionField).toHaveValue(
    "Type 2 diabetes mellitus without complications"
  );
  await expect(dialog.locator("#fh-code-new")).toHaveValue("E11.9");
  await expect(dialog.locator("#fh-codesys-new")).toHaveValue("ICD-10-CM");

  // Same retract discipline: the code follows the concept it was picked for.
  await settledFill(page, conditionField, "Something else entirely");
  await expect(dialog.locator("#fh-code-new")).toHaveValue("");
  await expect(dialog.locator("#fh-codesys-new")).toHaveValue("");
});

// #2809: the conditions list had ONE empty state and used it for two situations. A
// profile with nothing recorded opened the page on the default All pill and read "No
// conditions match this filter" — a sentence that says data is being hidden from you,
// to someone who has none. It is the ordinary first-run state, not an edge: 197 of the
// 209 seeded fixture profiles have no conditions at all.
//
// REPORTS_EMPTY is borrowed read-only, as e2e/results-page.spec.ts already borrows it:
// it is a dedicated adult profile whose own spec never writes to it, so "this profile
// has no conditions" stays true under --repeat-each.
test("a profile with no conditions is told none are recorded, not that a filter hid them (#2809)", async ({
  browser,
}) => {
  const member = await loginAs(browser, {
    username: E2E_LOGIN_REPORTS_EMPTY,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await member.goto("/records/problems/conditions");
    const section = member.getByTestId("records-conditions");
    await expect(section).toBeVisible();
    // The default pill really is All — otherwise the sentence below would be right
    // for the wrong reason.
    await expect(
      section
        .getByTestId("conditions-filter")
        .getByRole("link", { name: "All" })
    ).toHaveAttribute("aria-current", "true");
    await expect(section).toContainText("No conditions recorded.");
    await expect(section).not.toContainText("No conditions match this filter");

    // THE CONTROL, on the same profile and the same empty list: one pill along, a
    // filter IS narrowing the list, and the other sentence is the right one. Same
    // zero rows, different sentence — so the branch is driven by the filter and not
    // by the row count.
    await member.goto("/records/problems/conditions?cond=resolved");
    await expect(section).toContainText("No conditions match this filter.");
  } finally {
    await member.context().close();
  }
});
