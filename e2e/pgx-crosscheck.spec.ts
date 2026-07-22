import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import {
  expandIntakeWarnings,
  pgxWarnings,
  pgxWarningRows,
} from "./intake-warnings-helpers";

// Pharmacogenomics cross-check (issue #710): a stored PGx result (a genomic_variants
// row, result_type='pharmacogenomic') affecting a medication in the active stack must
// surface (a) an inline note on the Medications page + the create/edit form, and (b) a
// dismissible finding on Upcoming — the same shape as the drug–drug interaction
// warnings. CPIC's guidance is relayed AS INFORMATION with its citation; never
// prescriptive.
//
// Fixture discipline (shared seeded DB): this spec owns its OWN rows — an HLA-B*57:01
// variant + a uniquely-named Abacavir medication, plus a CYP2D6 ultrarapid variant
// for the inline-notice test — tagged by a unique source lab / name prefix, seeded
// via a raw connection and cleaned up in beforeAll AND afterAll so it's idempotent
// across retries and never touches seeded rows. Locators are scoped to the specific
// row (never a positional first-match on the shared warnings surface).

const LAB = "E2E PGX Lab";
const ABACAVIR = "E2E PGX Abacavir"; // normalizes to contain the "abacavir" synonym
const MED_PREFIX = "E2E PGX";

function dbPath(): string {
  return (
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db")
  );
}

function cleanup(): void {
  const db = new Database(dbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const medIds = db
      .prepare("SELECT id FROM intake_items WHERE name LIKE ?")
      .all(`${MED_PREFIX}%`) as { id: number }[];
    for (const { id } of medIds) {
      db.prepare("DELETE FROM upcoming_dismissals WHERE signal_key LIKE ?").run(
        `pgx:${id}:%`
      );
    }
    db.prepare("DELETE FROM intake_items WHERE name LIKE ?").run(
      `${MED_PREFIX}%`
    );
    db.prepare("DELETE FROM genomic_variants WHERE source_lab = ?").run(LAB);
  } finally {
    db.close();
  }
}

function seed(): void {
  const db = new Database(dbPath());
  try {
    db.pragma("busy_timeout = 5000");
    // Profile 1 is the seeded active profile the e2e login acts as.
    db.prepare(
      `INSERT INTO genomic_variants
         (profile_id, gene, star_allele, result_type, interpretation, source_lab)
       VALUES (1, 'HLA-B', '*57:01', 'pharmacogenomic', 'Positive', ?)`
    ).run(LAB);
    db.prepare(
      `INSERT INTO genomic_variants
         (profile_id, gene, star_allele, result_type, interpretation, source_lab)
       VALUES (1, 'CYP2D6', '*1/*1xN', 'pharmacogenomic', 'Ultrarapid metabolizer', ?)`
    ).run(LAB);
    db.prepare(
      `INSERT INTO intake_items (profile_id, name, active, kind, priority)
       VALUES (1, ?, 1, 'medication', 'high')`
    ).run(ABACAVIR);
  } finally {
    db.close();
  }
}

test.describe("Pharmacogenomics cross-check (#710)", () => {
  test.beforeAll(() => {
    cleanup();
    seed();
  });
  test.afterAll(cleanup);

  test("shows the HLA-B*57:01 × abacavir contraindication note on /medications", async ({
    page,
  }) => {
    await page.goto("/medications");
    const main = page.getByRole("main");
    await expandIntakeWarnings(main);

    const warnings = pgxWarnings(main);
    await expect(warnings).toBeVisible();

    const row = pgxWarningRows(warnings).filter({ hasText: ABACAVIR });
    await expect(row).toBeVisible();
    await expect(row).toContainText("HLA-B");
    await expect(row).toContainText("CONTRAINDICATED", { ignoreCase: true });
    // CPIC's guidance direction, relayed as information, with the required guardrail.
    await expect(row).toContainText("CPIC guidance:");
    await expect(row).toContainText(
      "discuss with your prescriber before any change"
    );
    await expect(row).toContainText("Source:");
  });

  test("surfaces the PGx finding on Upcoming", async ({ page }) => {
    await page.goto("/upcoming");
    const main = page.getByRole("main");

    const finding = main
      .locator('[data-testid^="upcoming-item-pgx:"]')
      .filter({ hasText: ABACAVIR });
    await expect(finding).toBeVisible();
    await expect(finding).toContainText("HLA-B");
  });

  test("shows the inline PGx notice while adding an affected medication", async ({
    page,
  }) => {
    await page.goto("/medications");
    await page.getByTestId("medication-add-toggle").click();
    await page.getByTestId("medication-add-full").click();
    const addCard = page.getByTestId("medication-add-panel");

    // Typing a CYP2D6-affected opioid with an ultrarapid variant on file lights the
    // inline note — no save needed; the pure crossCheckPgx runs client-side.
    await addCard.getByLabel("Name").fill("Codeine");
    const notice = addCard.getByTestId("pgx-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("CYP2D6");
    await expect(notice).toContainText(
      "discuss with your prescriber before any change"
    );
  });
});
