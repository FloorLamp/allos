import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { settledClick } from "./helpers";

// Issue #1008: the medical-document upload accepts SEVERAL files per submit — a
// native multi-select AND a drag-and-drop of multiple files. This spec drives the
// real UploadForm → uploadMedicalDocument flow for both entry points and asserts
// each file lands as its own document row in the Review import feed (a document
// row's headline is its filename). Extraction has no ANTHROPIC_API_KEY at CI
// parity, so each row simply settles without extracted results — we assert the
// ROWS appear, not extraction output.

// Unique prefix so cleanup targets exactly this spec's rows and the shared e2e DB
// stays clean for the neighbors (review-inbox / import-dedup assert feed counts).
// Synthetic CSV content only — no PHI.
const PREFIX = "e2e-multi-";
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";

// A tiny, UNIQUE csv per index — byte-identical uploads would content-hash dedup
// into one row, hiding the per-file count under test.
function csv(i: number) {
  return {
    name: `${PREFIX}${i}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(
      `metric,value,unit,date\nGlucose,${90 + i},mg/dL,2026-01-0${i}\n`
    ),
  };
}

test.describe("Multi-file medical upload (issue #1008)", () => {
  // This spec creates medical_documents rows; remove them afterward. A raw
  // connection (not lib/db) avoids re-running migrate()/bootstrap on import.
  test.afterAll(() => {
    const handle = new Database(DB_PATH);
    try {
      handle
        .prepare("DELETE FROM medical_documents WHERE filename LIKE ?")
        .run(`${PREFIX}%`);
    } finally {
      handle.close();
    }
  });

  test("native multi-select uploads several files as several rows", async ({
    page,
  }) => {
    await page.goto("/data?section=import");

    // The multi-select picker: hand the input three files at once.
    const input = page.getByTestId("medical-upload-input");
    await input.setInputFiles([csv(1), csv(2), csv(3)]);

    // The chosen files are listed before submit.
    const selected = page.getByTestId("medical-upload-selected");
    await expect(selected.getByText(`${PREFIX}1.csv`)).toBeVisible();
    await expect(selected.getByText(`${PREFIX}3.csv`)).toBeVisible();

    const submit = page.getByTestId("medical-upload-submit");
    await expect(submit).toBeEnabled();
    await settledClick(page, submit);

    // Count-aware confirmation toast.
    await expect(page.getByText("3 uploads received")).toBeVisible();

    // Each file became its own row in the Review import feed.
    await page.goto("/data?section=review");
    const feed = page.getByTestId("import-feed");
    for (const i of [1, 2, 3]) {
      await expect(feed.getByText(`${PREFIX}${i}.csv`)).toBeVisible();
    }
  });

  test("drag-and-drop of several files uploads them too", async ({ page }) => {
    await page.goto("/data?section=import");

    const files = [4, 5].map(csv);
    // Build a DataTransfer with real File objects in-page and dispatch the drop on
    // the zone — the form forwards the dropped files into the real input so the
    // submit carries them (native OS file-drag can't be simulated from Playwright).
    await page.getByTestId("medical-upload-dropzone").evaluate(
      (zone, payload) => {
        const dt = new DataTransfer();
        for (const f of payload) {
          dt.items.add(
            new File([new Uint8Array(f.bytes)], f.name, { type: f.type })
          );
        }
        zone.dispatchEvent(
          new DragEvent("dragover", { dataTransfer: dt, bubbles: true })
        );
        zone.dispatchEvent(
          new DragEvent("drop", { dataTransfer: dt, bubbles: true })
        );
      },
      files.map((f) => ({
        name: f.name,
        type: f.mimeType,
        bytes: Array.from(f.buffer),
      }))
    );

    const selected = page.getByTestId("medical-upload-selected");
    await expect(selected.getByText(`${PREFIX}4.csv`)).toBeVisible();
    await expect(selected.getByText(`${PREFIX}5.csv`)).toBeVisible();

    const submit = page.getByTestId("medical-upload-submit");
    await expect(submit).toBeEnabled();
    await settledClick(page, submit);
    await expect(page.getByText("2 uploads received")).toBeVisible();

    await page.goto("/data?section=review");
    const feed = page.getByTestId("import-feed");
    for (const i of [4, 5]) {
      await expect(feed.getByText(`${PREFIX}${i}.csv`)).toBeVisible();
    }
  });
});
