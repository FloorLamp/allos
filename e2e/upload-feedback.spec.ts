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
        .prepare("DELETE FROM medical_documents WHERE filename = ?")
        .run(UPLOAD_NAME);
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
});
