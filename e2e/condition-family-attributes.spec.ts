import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  hydratedClick,
  openCareOverviewSection,
  settledFill,
  settledSelect,
} from "./helpers";
import { openRecordFact, withRecordFact } from "./record-facts-helpers";

// The Care › Overview sections are <details> disclosures (#1804). A save
// revalidates the server tree, and the re-rendered <details> comes back CLOSED —
// which hides the add toggle and every row inside it. So each interaction re-opens
// the section instead of assuming the previous step left it open.
//
// OPENING it is the shared helper's job (#2231): this page is reached at
// `#family-history`, and the disclosure's hash-reveal effect writes `open` too, so a
// read-once-then-click here raced that effect into clicking the section SHUT. What
// stays local is the signal THIS spec depends on — the add toggle the section holds.
async function openFamilySection(page: Page) {
  const section = await openCareOverviewSection(page, "records-family-history");
  await expect(
    page.getByTestId("add-family-history-panel-toggle")
  ).toBeVisible();
  return section;
}

// #1403 / #1407 — the passport can finally record what a problem list and a family
// history actually contain: a SIDE and a GRADE on a condition, and how/how young a
// relative died plus whether they are a genetic relative at all.
//
// Both specs drive the real forms end to end (enter → save → read the row back →
// edit → read again), because the value of these columns is exactly that they
// survive the round trip and show up on the row rather than collapsing into a name
// or a notes blob. Fixture data is owned by each test (distinctive names), so no
// shared seed row is counted or mutated.

test.describe("Condition laterality / severity / stage (#1403)", () => {
  test("a sided, graded condition records its side and grade, and both are editable", async ({
    page,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    await page.goto("/records/problems/conditions");
    await hydratedClick(page, page.getByTestId("add-condition-panel-toggle"));

    const dialog = page.getByRole("dialog", { name: "Add condition" });
    const nameField = dialog.getByLabel("Condition", { exact: true });
    await expect(nameField).toBeVisible();
    await settledFill(page, nameField, "E2E patellar tendinopathy");
    // The catalog dropdown hangs directly below the field; dismiss it before
    // reaching for the selects underneath (the conditions-icd10 spec's gesture).
    await nameField.press("Escape");

    // Side, grade and stage are OPTIONAL facts (#5302): a new condition states none
    // of them, so each is reached through the trailing affordance that names it. The
    // helper routes; the values and the round trip below are unchanged.
    const addForm = dialog.getByTestId("condition-form");
    await withRecordFact(addForm, "condition", "laterality", () =>
      settledSelect(page, dialog.locator("#cond-laterality-new"), "left")
    );
    await withRecordFact(addForm, "condition", "severity", () =>
      settledSelect(page, dialog.locator("#cond-severity-new"), "moderate")
    );
    await withRecordFact(addForm, "condition", "stage", () =>
      settledFill(page, dialog.locator("#cond-stage-new"), "Grade II")
    );

    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Condition saved")).toBeVisible();

    // The row names its SIDE — the whole point: an unsided label would be
    // indistinguishable from the same problem on the other knee (#482).
    const section = page.getByTestId("records-conditions");
    const row = section
      .locator("tr")
      .filter({ hasText: "E2E patellar tendinopathy" });
    // Renders on the save action's revalidated tree — a cold shard can outrun the
    // default 5s (imaging/#1306 precedent).
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText("E2E patellar tendinopathy (left)");
    await expect(row).toContainText("Moderate · Grade II");

    // Editing the side is a real correction (a mis-recorded side is a clinical
    // error), so the edit form must round-trip the stored values and save a change.
    await row.getByLabel("Record actions").click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    // The add dialog is gone by now, so this is the one condition form on the page.
    const editForm = section.getByTestId("condition-form");
    // The stored values read back on the ROW, which is what the chips are for: the
    // edit form's summary doubles as the record's review (#3218).
    await expect(editForm.getByTestId("condition-fact-laterality")).toHaveText(
      "Left"
    );
    await withRecordFact(editForm, "condition", "laterality", async () => {
      await expect(
        editForm.locator('select[id^="cond-laterality-"]')
      ).toHaveValue("left");
      await settledSelect(
        page,
        editForm.locator('select[id^="cond-laterality-"]'),
        "right"
      );
    });
    await withRecordFact(editForm, "condition", "severity", () =>
      settledSelect(
        page,
        editForm.locator('select[id^="cond-severity-"]'),
        "severe"
      )
    );
    await editForm.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Condition updated")).toBeVisible();

    const updated = section
      .locator("tr")
      .filter({ hasText: "E2E patellar tendinopathy" });
    await expect(updated).toContainText("E2E patellar tendinopathy (right)", {
      timeout: 15_000,
    });
    await expect(updated).toContainText("Severe");
  });
});

test.describe("Family history death facts + genetic axis (#1407)", () => {
  test("records age and cause of death, and marks a non-genetic relative", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/records/care/overview#family-history");
    let section = await openFamilySection(page);
    await hydratedClick(
      page,
      page.getByTestId("add-family-history-panel-toggle")
    );

    const dialog = page.getByRole("dialog", { name: "Add family history" });
    // The CONDITION is rule 1's one identifying field and stays above the chips
    // (#5302); everything else is a fact behind the row.
    const conditionField = dialog.getByLabel("Condition", { exact: true });
    await expect(conditionField).toBeVisible();
    await settledFill(page, conditionField, "E2E coronary artery disease");
    await conditionField.press("Escape");
    const addForm = dialog.getByTestId("family-history-form");
    // The relative is an ESSENTIAL, so its dashed chip is already on the row.
    await withRecordFact(addForm, "family-history", "relation", () =>
      settledFill(page, dialog.getByLabel("Relative"), "E2E father")
    );
    // The three death columns are ONE fact over ONE editor: they describe a single
    // event and read back as one line, so the age and the cause are filled together
    // behind the `death` chip rather than at two addresses.
    await withRecordFact(addForm, "family-history", "death", async () => {
      await settledFill(page, dialog.locator("#fh-age-death-new"), "52");
      await settledFill(
        page,
        dialog.locator("#fh-cause-death-new"),
        "Myocardial infarction"
      );
    });

    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Family history saved")).toBeVisible();

    // "father, MI at 52" — the exact string the screening-cadence logic keys on,
    // now on the row instead of in a notes blob. The death checkbox was never
    // ticked: stating the facts states the death.
    section = await openFamilySection(page);
    const row = section.locator("tr").filter({ hasText: "E2E father" });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText("Died at 52 — Myocardial infarction");

    // A second relative, explicitly NOT genetic — the row that must never weigh as
    // hereditary risk, and whose label has to say so. The relation TEXT is neutral on
    // purpose: a relation already spelling out "stepmother" states the discriminator
    // itself, and the label deliberately does not repeat what the text says.
    section = await openFamilySection(page);
    await hydratedClick(
      page,
      page.getByTestId("add-family-history-panel-toggle")
    );
    const second = page.getByRole("dialog", { name: "Add family history" });
    const secondCondition = second.getByLabel("Condition", { exact: true });
    await settledFill(page, secondCondition, "E2E type 2 diabetes");
    await secondCondition.press("Escape");
    const secondForm = second.getByTestId("family-history-form");
    await withRecordFact(secondForm, "family-history", "relation", () =>
      settledFill(page, second.getByLabel("Relative"), "E2E guardian")
    );
    await withRecordFact(secondForm, "family-history", "relationship", () =>
      settledSelect(page, second.locator("#fh-relation-type-new"), "step")
    );
    await withRecordFact(secondForm, "family-history", "lineage", () =>
      settledSelect(page, second.locator("#fh-lineage-new"), "maternal")
    );
    await second.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Family history saved")).toBeVisible();

    section = await openFamilySection(page);
    const stepRow = section.locator("tr").filter({ hasText: "E2E guardian" });
    await expect(stepRow).toBeVisible({ timeout: 15_000 });
    await expect(stepRow).toContainText("E2E guardian (step, maternal)");

    // The discriminator is editable — a relative recorded before the field existed
    // can be corrected to adopted, and the label follows.
    await stepRow.getByLabel("Record actions").click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    // The add dialog is gone by now, so this is the one family-history form on the
    // page.
    const editForm = section.getByTestId("family-history-form");
    // The stored discriminator reads back on the ROW, which is what the chips are
    // for: the edit form's summary doubles as the record's review (#3218).
    await expect(
      editForm.getByTestId("family-history-fact-relationship")
    ).toHaveText("Step");
    await openRecordFact(editForm, "family-history", "relationship");
    await expect(
      editForm.locator('select[id^="fh-relation-type-"]')
    ).toHaveValue("step");
    await settledSelect(
      page,
      editForm.locator('select[id^="fh-relation-type-"]'),
      "adopted"
    );
    await editForm.getByTestId("family-history-editor-done").click();
    await editForm.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Family history updated")).toBeVisible();

    section = await openFamilySection(page);
    await expect(
      section.locator("tr").filter({ hasText: "E2E guardian" })
    ).toContainText("E2E guardian (adopted, maternal)", { timeout: 15_000 });
  });
});
