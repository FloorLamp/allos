import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import {
  hydratedClick,
  openCareOverviewSection,
  settledClick,
  settledFill,
  settledSelect,
} from "./helpers";
import {
  allergyWarnings,
  allergyWarningRows,
  expandIntakeWarnings,
  pgxWarnings,
  pgxWarningRows,
} from "./intake-warnings-helpers";
import { workerDbPath, frozenNow } from "./worker-env";

// The #1676 entry vocabularies, driven through the real forms.
//
// Three of the converted fields feed cross-checks that key on the STRING stored, so
// the bug is silent: a drifted spelling produces a saved record that looks right and
// a check that never fires. Each test here shows both sides — the drift that misses,
// and the same record re-entered through the picker, where the check fires.
//
// Fixture discipline (shared seeded DB): every row this spec plants carries an
// "E2E VOCAB" marker, is created either through the UI or a raw connection, and is
// removed by a cleanup that runs before AND after the file plus between tests, so it
// is idempotent under --repeat-each and never touches a seeded row.
//
// Class choice matters: the seeded profile already records Penicillin and Sulfa
// allergies, so this spec uses the NSAID class (unrecorded there) to keep "no
// warning yet" an honest starting state.

const DB_PATH = workerDbPath();
const MED_PREFIX = "E2E VOCAB";
const NSAID_MED = "E2E VOCAB Ibuprofen";
const THIOPURINE_MED = "E2E VOCAB Azathioprine";
const PGX_LAB = "E2E VOCAB Lab";
const CARE_ITEM = "E2E VOCAB scope";
const DRIFTED_ALLERGEN = "Anti-inflammatories";
const PICKED_ALLERGEN = "NSAIDs (non-steroidal anti-inflammatory drugs)";

function withDb<T>(fn: (db: InstanceType<typeof Database>) => T): T {
  const db = new Database(DB_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

// Everything this spec creates, in one place. Called before the file, after it, and
// between tests so each test starts from "nothing recorded yet".
function cleanupRows(): void {
  withDb((db) => {
    db.prepare(
      "DELETE FROM allergies WHERE profile_id = 1 AND substance IN (?, ?)"
    ).run(DRIFTED_ALLERGEN, PICKED_ALLERGEN);
    db.prepare("DELETE FROM genomic_variants WHERE source_lab = ?").run(
      PGX_LAB
    );
    db.prepare(
      "DELETE FROM genomic_variants WHERE profile_id = 1 AND gene IN (?, ?)"
    ).run("TPM T", "TPMT");
    db.prepare(
      "DELETE FROM care_plan_items WHERE profile_id = 1 AND description = ?"
    ).run(CARE_ITEM);
  });
}

function cleanupMeds(): void {
  withDb((db) => {
    const ids = db
      .prepare("SELECT id FROM intake_items WHERE name LIKE ?")
      .all(`${MED_PREFIX}%`) as { id: number }[];
    for (const { id } of ids) {
      db.prepare("DELETE FROM upcoming_dismissals WHERE signal_key LIKE ?").run(
        `pgx:${id}:%`
      );
      db.prepare("DELETE FROM upcoming_dismissals WHERE signal_key LIKE ?").run(
        `allergy-med:%-${id}`
      );
    }
    db.prepare("DELETE FROM intake_items WHERE name LIKE ?").run(
      `${MED_PREFIX}%`
    );
  });
}

function seedMeds(): void {
  withDb((db) => {
    for (const name of [NSAID_MED, THIOPURINE_MED]) {
      db.prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, obligation)
         VALUES (1, ?, 1, 'medication', 'must')`
      ).run(name);
    }
  });
}

// A date a week out, from the FROZEN run clock — inside the Upcoming window.
function plannedDate(): string {
  const d = frozenNow();
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

async function openAllergyDialog(page: Page) {
  await hydratedClick(page, page.getByTestId("add-allergy-panel-toggle"));
  const dialog = page.getByRole("dialog", { name: "Add allergy" });
  await expect(dialog).toBeVisible();
  return dialog;
}

// The third copy of "open a Care › Overview disclosure" the #2231 audit found. It
// carried the same read-once-then-click race as the family-history one, so it now
// asks the same shared, `open`-guarded helper; the caller still asserts what it
// reveals.
async function revealCarePlan(page: Page) {
  return openCareOverviewSection(page, "records-care-plan");
}

async function openCarePlanDialog(page: Page) {
  await revealCarePlan(page);
  await hydratedClick(page, page.getByTestId("add-care-plan-panel-toggle"));
  const dialog = page.getByRole("dialog", { name: "Add care-plan item" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("Entry vocabularies (#1676)", () => {
  test.beforeAll(() => {
    cleanupRows();
    cleanupMeds();
    seedMeds();
  });
  test.afterAll(() => {
    cleanupRows();
    cleanupMeds();
  });
  test.beforeEach(cleanupRows);

  test("allergen substance: free text still saves, and a picked name fires the drug cross-check", async ({
    page,
  }) => {
    test.slow();

    // (1) The escape hatch. A wording the vocabulary doesn't know still saves —
    // through the explicit "Use …" row, and unchanged.
    await page.goto("/records/problems/allergies");
    const allergyDialog = await openAllergyDialog(page);
    const substance = allergyDialog.locator("#allergy-substance-new");
    await settledFill(page, substance, DRIFTED_ALLERGEN);
    await page
      .getByRole("listbox")
      .getByRole("button", { name: new RegExp(`Use .*${DRIFTED_ALLERGEN}`) })
      .click();
    await settledFill(
      page,
      allergyDialog.getByTestId("allergy-reaction-new-0"),
      "rash"
    );
    await settledClick(
      page,
      allergyDialog.getByRole("button", { name: "Add", exact: true })
    );
    await expect(page.getByText("Allergy saved")).toBeVisible();
    await expect(
      page.getByRole("row").filter({ hasText: DRIFTED_ALLERGEN })
    ).toBeVisible({ timeout: 15_000 });

    // …and it is INVISIBLE to the drug-allergy cross-check: the allergy is on file,
    // an NSAID is in the active stack, and nothing warns. That is the bug.
    await page.goto("/medications");
    const main = page.getByRole("main");
    await expect(
      allergyWarningRows(main).filter({ hasText: NSAID_MED })
    ).toHaveCount(0);

    // (2) The same allergy, entered through the picker.
    cleanupRows();
    await page.goto("/records/problems/allergies");
    const pickedDialog = await openAllergyDialog(page);
    const picker = pickedDialog.locator("#allergy-substance-new");
    await settledFill(page, picker, "nsaid");
    await page
      .getByRole("listbox")
      .getByRole("button", { name: PICKED_ALLERGEN, exact: true })
      .click();
    await expect(picker).toHaveValue(PICKED_ALLERGEN);
    await settledFill(
      page,
      pickedDialog.getByTestId("allergy-reaction-new-0"),
      "rash"
    );
    await settledClick(
      page,
      pickedDialog.getByRole("button", { name: "Add", exact: true })
    );
    await expect(page.getByText("Allergy saved")).toBeVisible();

    // Now the cross-check sees it: the same medication carries the class warning.
    await page.goto("/medications");
    const main2 = page.getByRole("main");
    await expandIntakeWarnings(main2);
    await expect(allergyWarnings(main2)).toBeVisible();
    const row = allergyWarningRows(main2).filter({ hasText: NSAID_MED });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText("NSAID");
    await expect(row).toContainText("with your prescriber");
  });

  test("gene symbol: a drifted symbol drops the PGx check, a picked one keeps it", async ({
    page,
  }) => {
    test.slow();

    // (1) The drift, planted directly: a poor-metabolizer TPMT result written with a
    // stray space. crossCheckPgx compares gene symbols exactly, so no guidance row
    // can ever reach it.
    withDb((db) =>
      db
        .prepare(
          `INSERT INTO genomic_variants
             (profile_id, gene, star_allele, result_type, interpretation, source_lab)
           VALUES (1, 'TPM T', '*3A/*3A', 'pharmacogenomic', 'Poor metabolizer', ?)`
        )
        .run(PGX_LAB)
    );
    await page.goto("/medications");
    await expect(
      pgxWarningRows(page.getByRole("main")).filter({ hasText: THIOPURINE_MED })
    ).toHaveCount(0);

    // (2) The same result, entered through the picker.
    cleanupRows();
    await page.goto("/results/genomics");
    await page.getByTestId("add-genomic-panel-toggle").click();
    const form = page.getByTestId("genomic-variant-form");
    await expect(form).toBeVisible();
    const gene = form.getByLabel("Gene");
    await settledFill(page, gene, "tpmt");
    await page
      .getByRole("listbox")
      .getByRole("button", { name: "TPMT", exact: true })
      .click();
    await expect(gene).toHaveValue("TPMT");
    await settledFill(page, form.getByLabel("Star allele"), "*3A/*3A");
    await settledSelect(
      page,
      form.getByLabel("Result type"),
      "pharmacogenomic"
    );
    await settledFill(page, form.getByLabel("Source lab"), PGX_LAB);
    await settledClick(
      page,
      form.getByRole("button", { name: "Add", exact: true })
    );
    await expect(page.getByText("Variant saved")).toBeVisible();

    await page.goto("/medications");
    const main = page.getByRole("main");
    await expandIntakeWarnings(main);
    await expect(pgxWarnings(main)).toBeVisible();
    const row = pgxWarningRows(main).filter({ hasText: THIOPURINE_MED });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText("TPMT");
    await expect(row).toContainText("CPIC guidance:");
  });

  test("care-plan status: the picker closes an item, and free text says it will not", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/records/care/overview");
    const carePlanDialog = await openCarePlanDialog(page);
    await settledFill(page, carePlanDialog.locator("#cp-desc-new"), CARE_ITEM);
    await settledSelect(
      page,
      carePlanDialog.locator("#cp-category-new"),
      "procedure"
    );
    await settledSelect(
      page,
      carePlanDialog.locator("#cp-status-new"),
      "planned"
    );
    // DateField re-renders the committed ISO value as a formatted display string, so
    // a plain fill is right here — the settled fills above already proved this form
    // is hydrated.
    await carePlanDialog.locator("#cp-date-new").fill(plannedDate());
    await settledClick(
      page,
      carePlanDialog.getByRole("button", { name: "Add", exact: true })
    );
    await expect(page.getByText("Care-plan item saved")).toBeVisible();

    // A dated open item nudges.
    await page.goto("/upcoming");
    await expect(
      page
        .locator('[data-testid^="upcoming-item-careplan:"]')
        .filter({ hasText: CARE_ITEM })
    ).toBeVisible({ timeout: 15_000 });

    // The free-text escape is honest about what it costs: an unrecognized status
    // sits outside the open/closed machinery, so the item keeps nudging. The form
    // says so BEFORE the save, and the feed proves it after.
    await page.goto("/records/care/overview");
    await revealCarePlan(page);
    const row = page.locator("tr").filter({ hasText: CARE_ITEM });
    // The overflow trigger and its Edit item are onClick-only client state
    // (OverflowMenu + EditableRecordRow) — the edit form is the signal.
    await hydratedClick(page, row.getByLabel("Record actions"));
    await hydratedClick(page, page.getByRole("menuitem", { name: "Edit" }));
    const editForm = page.locator(
      'form:has(select[id^="cp-status-"]:not([id="cp-status-new"]))'
    );
    await settledSelect(
      page,
      editForm.locator('select[id^="cp-status-"]'),
      "__other"
    );
    const other = editForm.locator('input[data-testid^="cp-status-other-"]');
    await settledFill(page, other, "finished");
    await expect(
      editForm.locator('[data-testid^="cp-status-unrecognized-"]')
    ).toContainText("keeps counting as open");
    await settledClick(page, editForm.getByRole("button", { name: "Save" }));
    await expect(page.getByText("Care-plan item updated")).toBeVisible();

    await page.goto("/upcoming");
    await expect(
      page
        .locator('[data-testid^="upcoming-item-careplan:"]')
        .filter({ hasText: CARE_ITEM })
    ).toBeVisible({ timeout: 15_000 });

    // Picking a status the machinery recognizes is what actually closes it.
    await page.goto("/records/care/overview");
    await revealCarePlan(page);
    const closingRow = page.locator("tr").filter({ hasText: CARE_ITEM });
    await hydratedClick(page, closingRow.getByLabel("Record actions"));
    await hydratedClick(page, page.getByRole("menuitem", { name: "Edit" }));
    const editAgain = page.locator(
      'form:has(select[id^="cp-status-"]:not([id="cp-status-new"]))'
    );
    await settledSelect(
      page,
      editAgain.locator('select[id^="cp-status-"]'),
      "completed"
    );
    await settledClick(page, editAgain.getByRole("button", { name: "Save" }));
    await expect(page.getByText("Care-plan item updated")).toBeVisible();

    await page.goto("/upcoming");
    await expect(
      page
        .locator('[data-testid^="upcoming-item-careplan:"]')
        .filter({ hasText: CARE_ITEM })
    ).toHaveCount(0);
  });
});
