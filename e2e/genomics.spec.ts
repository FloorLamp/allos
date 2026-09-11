import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import {
  hydratedClick,
  settledClick,
  settledFill,
  submitWithToast,
} from "./helpers";
import {
  expectDesktopRecordFormSubmit,
  expectPhoneRecordFormSubmit,
} from "./record-form-actions";
import { withRecordFact } from "./record-facts-helpers";
import { workerDbPath } from "./worker-env";

// Genomic variants CRUD on the #genomics section of /results (#709, #1042 phase 5): add a structured variant through the
// real form, see it in the list with its reported significance + result-type shown
// factually, edit it, then delete it. Drives the real UI end-to-end.
//
// Fixture discipline (shared seeded DB): a unique gene marker scopes every action
// and a raw-connection cleanup in beforeAll AND afterAll makes the spec idempotent
// across CI retries — it only ever touches rows it created.
const DB_PATH = workerDbPath();
const GENE = "E2EGENE1";
const PHONE = { width: 390, height: 844 };

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

    await page.goto("/results/genomics");
    const add = page.getByTestId("add-genomic-panel-toggle");
    await expect(add).toHaveClass(/\bbtn\b/);
    await hydratedClick(page, add);
    const dialog = page.getByRole("dialog", {
      name: "Add genomic variant",
    });
    await expect(dialog).toBeVisible();
    const form = dialog.getByTestId("genomic-variant-form");
    await expect(form).toBeVisible();
    const addSubmit = form.getByRole("button", {
      name: "Add",
      exact: true,
    });
    await expectDesktopRecordFormSubmit({
      form,
      actions: form.getByTestId("genomic-variant-actions"),
      primaryOwner: form.getByTestId("genomic-variant-primary-action"),
      submit: addSubmit,
      name: "genomic variant add",
    });
    await page.setViewportSize(PHONE);
    await expectPhoneRecordFormSubmit({
      form,
      actions: form.getByTestId("genomic-variant-actions"),
      primaryOwner: form.getByTestId("genomic-variant-primary-action"),
      submit: addSubmit,
      fillsActions: true,
      name: "phone genomic variant add",
    });

    // Add a hereditary-risk variant with an ACMG significance.
    // Gene is a controlled Combobox over the PGx symbols since #1676; a non-PGx
    // gene is still free text, and settledFill keeps the value out of the
    // pre-hydration revert window.
    //
    // EVERY FIELD BUT THE GENE IS BEHIND A CHIP SINCE #5302. The gene is rule 1's one
    // identifying field — the column the PGx cross-check matches exactly — and stays
    // above the row; the rest are reached through `withRecordFact`, which opens the
    // chip when the row states the fact and the trailing affordance when it does not.
    // What the variant stores, and every assertion below about how the list reads it
    // back, is unchanged.
    await settledFill(page, form.getByLabel("Gene"), GENE);
    await withRecordFact(form, "genomic-variant", "variant", () =>
      form.getByLabel("Variant (rsID / HGVS)").fill("c.123A>G")
    );
    // The star allele, the genotype and the zygosity are ONE fact over ONE editor,
    // read back through `variantCallLabel`'s precedence.
    await withRecordFact(form, "genomic-variant", "call", async () => {
      await form.getByLabel("Zygosity").selectOption("heterozygous");
    });
    await withRecordFact(form, "genomic-variant", "result_type", async () => {
      await form.getByLabel("Result type").selectOption("hereditary-risk");
    });
    await withRecordFact(form, "genomic-variant", "significance", async () => {
      await form
        .getByLabel("Clinical significance")
        .selectOption("likely-pathogenic");
    });
    await withRecordFact(form, "genomic-variant", "source_lab", () =>
      form.getByLabel("Source lab").fill("E2E Genetics Lab")
    );
    // THE ROW'S OWN CLAIM, where a real browser can see it: the result type is a chip
    // this form ALWAYS states, because its select is born "other" — the value that
    // routes to neither the PGx nor the cadence consumer — so the trailing affordance
    // can never hold it.
    await expect(
      form.getByTestId("genomic-variant-fact-result_type")
    ).toHaveAttribute("data-fact-state", "stated");
    // Observed CONCURRENTLY with the click, not after it: a cold Server Action
    // response can outlive the six-second toast it triggers, so a sequential wait can
    // open its window after the receipt has gone while the write itself was fine
    // (helpers.submitWithToast, the imaging spec's rule).
    await submitWithToast(page, addSubmit, "Variant saved");

    // It appears in the list with its factual identity + reported classification.
    const list = page.getByTestId("genomic-variant-list");
    const row = list.getByRole("row").filter({ hasText: GENE });
    // Renders on the save action's revalidated tree — a cold shard can outrun the default 5s (imaging/#1306 precedent).
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText("Likely pathogenic");
    await expect(row).toContainText("Hereditary risk");

    // Edit it: change the significance to pathogenic.
    await row.getByLabel("Record actions").click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const editForm = list.getByTestId("genomic-variant-form");
    await expect(editForm).not.toHaveClass(/\bcard\b/);
    await expectPhoneRecordFormSubmit({
      form: editForm,
      actions: editForm.getByTestId("genomic-variant-actions"),
      primaryOwner: editForm.getByTestId("genomic-variant-primary-action"),
      submit: editForm.getByRole("button", { name: "Save", exact: true }),
      adjacent: editForm.getByRole("button", {
        name: "Cancel",
        exact: true,
      }),
      name: "phone genomic variant edit",
    });
    await withRecordFact(
      editForm,
      "genomic-variant",
      "significance",
      async () => {
        await editForm
          .getByLabel("Clinical significance")
          .selectOption("pathogenic");
      }
    );
    await submitWithToast(
      page,
      editForm.getByRole("button", { name: "Save", exact: true }),
      "Variant updated"
    );
    await expect(list.getByRole("row").filter({ hasText: GENE })).toContainText(
      "Pathogenic",
      { timeout: 15_000 }
    );

    // Delete it through the row's shared record-actions menu.
    const survivor = list.getByRole("row").filter({ hasText: GENE });
    await survivor.getByLabel("Record actions").click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await settledClick(
      page,
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Delete", exact: true })
    );
    await expect(list.getByRole("row").filter({ hasText: GENE })).toHaveCount(
      0
    );
  });
});
