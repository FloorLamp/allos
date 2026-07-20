import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";

// Genomic variants CRUD on the #genomics section of /results (#709, #1042 phase 5): add a structured variant through the
// real form, see it in the list with its reported significance + result-type shown
// factually, edit it, then delete it. Drives the real UI end-to-end.
//
// Fixture discipline (shared seeded DB): a unique gene marker scopes every action
// and a raw-connection cleanup in beforeAll AND afterAll makes the spec idempotent
// across CI retries — it only ever touches rows it created.
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";
const GENE = "E2EGENE1";

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    handle.prepare("DELETE FROM genomic_variants WHERE gene = ?").run(GENE);
  } finally {
    handle.close();
  }
}

test.describe("Genomic variants — add → view → edit → delete (#709)", () => {
  test.beforeAll(cleanup);
  test.afterAll(cleanup);

  test("stores a structured variant and shows it factually", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/results#genomics");
    const form = page.getByTestId("genomic-variant-form");
    await expect(form).toBeVisible();

    // Add a hereditary-risk variant with an ACMG significance.
    await form.getByLabel("Gene").fill(GENE);
    await form.getByLabel("Variant (rsID / HGVS)").fill("c.123A>G");
    await form.getByLabel("Zygosity").selectOption("heterozygous");
    await form.getByLabel("Result type").selectOption("hereditary-risk");
    await form
      .getByLabel("Clinical significance")
      .selectOption("likely-pathogenic");
    await form.getByLabel("Source lab").fill("E2E Genetics Lab");
    await form.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Variant saved")).toBeVisible();

    // It appears in the list with its factual identity + reported classification.
    const list = page.getByTestId("genomic-variant-list");
    const row = list.getByRole("row").filter({ hasText: GENE });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Likely pathogenic");
    await expect(row).toContainText("Hereditary risk");

    // Edit it: change the significance to pathogenic.
    await row.getByRole("button", { name: "Edit" }).click();
    const editForm = list.getByTestId("genomic-variant-form");
    await editForm
      .getByLabel("Clinical significance")
      .selectOption("pathogenic");
    await editForm.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Variant updated")).toBeVisible();
    await expect(list.getByRole("row").filter({ hasText: GENE })).toContainText(
      "Pathogenic"
    );

    // Delete it and confirm it's gone. The confirm click MUST be scoped to the
    // dialog: the page also carries one per-row aria-label="Delete" button for
    // every variant (incl. the seeded CYP2C19/BRCA1/APOE rows), so an unscoped
    // getByRole("button", { name: "Delete" }) is a strict-mode collision.
    const survivor = list.getByRole("row").filter({ hasText: GENE });
    await survivor.getByRole("button", { name: "Delete" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(list.getByRole("row").filter({ hasText: GENE })).toHaveCount(
      0
    );
  });
});
