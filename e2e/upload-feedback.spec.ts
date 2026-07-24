import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";

// Issue #102: the inline imports table (which showed a processing spinner right
// next to the upload form) moved into Data → Review, so after choosing a file the
// user saw nothing happen. This spec drives the real UploadForm →
// uploadMedicalDocument flow and asserts the two fixes: (a) an immediate
// confirmation toast that points at the Review tab, and (b) the file input is
// cleared after submit so the SAME file can be re-selected.

// Unique so cleanup can target exactly this spec's row. Synthetic content only —
// a tiny CSV, no PHI (flows through the AI-document path; without a key in e2e the
// background extraction simply skips, leaving one harmless medical_documents row).
const UPLOAD_NAME = "e2e-upload-feedback.csv";
const FIXTURE = Buffer.from(
  "metric,value,unit,date\nGlucose,95,mg/dL,2026-01-01\n"
);

// A SECOND, distinct fixture for the toast-merge test (#1315) — different bytes so
// the content-hash dedup never collides with the first test's upload.
const UPLOAD_NAME_2 = "e2e-upload-toast-merge.csv";
const FIXTURE_2 = Buffer.from(
  "metric,value,unit,date\nSodium,140,mmol/L,2026-02-02\n"
);

// The isolated e2e DB path (mirrors the default in playwright.config.ts). The test
// process gets no ALLOS_DB_PATH override, so it resolves to the same file the
// webServer booted against.
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";

test.describe("Medical document upload feedback", () => {
  // This spec creates a medical_documents row; remove it afterward so the shared
  // e2e DB stays clean (a leftover upload would perturb the Review feed / badge
  // counts that review-inbox.spec and import-dedup.spec assert). A raw connection
  // (not lib/db) avoids re-running migrate()/bootstrap side effects on import.
  test.afterAll(() => {
    const handle = new Database(DB_PATH);
    try {
      handle
        .prepare("DELETE FROM medical_documents WHERE filename IN (?, ?)")
        .run(UPLOAD_NAME, UPLOAD_NAME_2);
    } finally {
      handle.close();
    }
  });

  test("confirms the upload and clears the file input", async ({ page }) => {
    await page.goto("/data?section=import");

    // The "File Upload (incl. CSV)" tab is the default, so the input is present.
    const input = page.getByTestId("medical-upload-input");
    await input.setInputFiles({
      name: UPLOAD_NAME,
      mimeType: "text/csv",
      buffer: FIXTURE,
    });

    // Choosing a file enables the submit button; submit kicks off the upload.
    const submit = page.getByTestId("medical-upload-submit");
    await expect(submit).toBeEnabled();
    await submit.click();

    // Immediate feedback at the upload point: a confirmation toast that links to
    // the Review tab, where the import feed tracks extraction to completion.
    await expect(page.getByText("Upload received")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Track in Review" })
    ).toBeVisible();

    // The input is cleared after submit, so re-selecting the same file re-fires
    // its change event (and the button re-disables until a file is picked again).
    await expect(input).toHaveValue("");
    await expect(submit).toBeDisabled();
  });

  // Issue #1315: the upload confirmation and the extraction-complete toast used to
  // come from TWO separate toast systems, so they STACKED. Merged onto one keyed
  // system, the upload confirmation occupies a single lifecycle slot that UPGRADES
  // in place — the extraction result REPLACES it, never joins it. The e2e env has
  // no extractor, so the background extraction lands the document terminal (skipped)
  // and the headless watcher dismisses the upload slot and posts its own per-doc
  // result toast; at no point do the two coexist.
  test("the upload toast is replaced by the extraction result, never stacked", async ({
    page,
  }) => {
    await page.goto("/data?section=import");

    const input = page.getByTestId("medical-upload-input");
    await input.setInputFiles({
      name: UPLOAD_NAME_2,
      mimeType: "text/csv",
      buffer: FIXTURE_2,
    });
    const submit = page.getByTestId("medical-upload-submit");
    await expect(submit).toBeEnabled();
    await submit.click();

    // The upload confirmation occupies the shared lifecycle slot (its keyed toast).
    const uploadToast = page.locator('[data-toast-key="medical-upload"]');
    await expect(uploadToast).toBeVisible();

    // The headless watcher catches the terminal document and posts its per-document
    // result toast — and dismisses the upload slot, so it never stacks. Wait for the
    // result, then assert the upload slot is gone (replaced, not joined).
    await expect(page.getByText(/Couldn’t extract results from/)).toBeVisible({
      timeout: 20_000,
    });
    await expect(uploadToast).toHaveCount(0);
  });
});
