import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";

// Import-detail cohesion (#1340), finishing the #1071/#1332 verb consolidation:
//  1. Per-control explainers ride the rendered buttons — deterministic docs get
//     ZERO re-apply narration and a FREE/EXACT preview note, AI docs carry the
//     daily-extraction cost note with OR without a saved raw.
//  2. Empty sections don't render as prose walls — a record-less doc shows no
//     em-dash Provenance rows and hides the (empty) Debug disclosure.
//  3. A failed preview shows a compact "Preview unavailable" fallback, not a dead
//     blank frame.
//  4. "Wrong person?" pre-selects NO move target — Move stays disabled until a
//     profile is chosen, and the confirm names the scope.
//
// Spec-owned fixtures (the #868 hygiene rule): this spec inserts its own document
// rows via a raw connection and deletes them afterward, so it never leans on a
// shared-seed row's incidental shape.

const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";
const PROFILE_ID = 1; // the seed's bootstrap admin profile (the active profile)

// Distinct filenames so cleanup targets exactly this spec's rows.
const AI_WITH_RAW = "e2e-1340-ai-with-raw.pdf";
const AI_NO_RAW = "e2e-1340-ai-no-raw.pdf";
const DETERMINISTIC = "e2e-1340-deterministic.xml";
const BROKEN_PREVIEW = "e2e-1340-broken-image.png";
const FIXTURE_NAMES = [AI_WITH_RAW, AI_NO_RAW, DETERMINISTIC, BROKEN_PREVIEW];

const ids: Record<string, number> = {};

test.beforeAll(() => {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare(
        `DELETE FROM medical_documents WHERE profile_id = ? AND filename IN (?, ?, ?, ?)`
      )
      .run(PROFILE_ID, ...FIXTURE_NAMES);
    const insert = handle.prepare(
      `INSERT INTO medical_documents
         (profile_id, filename, stored_path, mime_type, size_bytes, doc_type,
          source, extraction_status, extracted_count, uploaded_at, raw_extraction)
       VALUES (@profile_id, @filename, @stored_path, @mime_type, 2048, @doc_type,
               @source, 'done', 0, '2026-07-10 09:00:00', @raw)`
    );
    // AI document WITH a saved extraction → re-apply IS offered, preview carries the
    // AI cost note.
    ids[AI_WITH_RAW] = Number(
      insert.run({
        profile_id: PROFILE_ID,
        filename: AI_WITH_RAW,
        stored_path: "",
        mime_type: "application/pdf",
        doc_type: "Lab report",
        source: null,
        raw: '{"records":[]}',
      }).lastInsertRowid
    );
    // AI document with NO saved extraction → no re-apply, but the preview still
    // carries the cost note. Doubles as the record-less fixture (no source / date /
    // patient / stored file, no error, no raw → collapsed sections).
    ids[AI_NO_RAW] = Number(
      insert.run({
        profile_id: PROFILE_ID,
        filename: AI_NO_RAW,
        stored_path: "",
        mime_type: "application/pdf",
        doc_type: "Lab report",
        source: null,
        raw: null,
      }).lastInsertRowid
    );
    // Deterministic health record (CCD) → zero re-apply narration, free/exact
    // preview note.
    ids[DETERMINISTIC] = Number(
      insert.run({
        profile_id: PROFILE_ID,
        filename: DETERMINISTIC,
        stored_path: "",
        mime_type: "application/xml",
        doc_type: "MyChart export (CCD/XDM)",
        source: "ccda",
        raw: null,
      }).lastInsertRowid
    );
    // An image whose stored file doesn't exist on disk → the serve route 404s and
    // the <img> fires onError → the "Preview unavailable" fallback.
    ids[BROKEN_PREVIEW] = Number(
      insert.run({
        profile_id: PROFILE_ID,
        filename: BROKEN_PREVIEW,
        stored_path: "data/uploads/medical/1/e2e-1340-nonexistent.png",
        mime_type: "image/png",
        doc_type: "Scan",
        source: null,
        raw: null,
      }).lastInsertRowid
    );
  } finally {
    handle.close();
  }
});

test.afterAll(() => {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare(
        `DELETE FROM medical_documents WHERE profile_id = ? AND filename IN (?, ?, ?, ?)`
      )
      .run(PROFILE_ID, ...FIXTURE_NAMES);
  } finally {
    handle.close();
  }
});

test.describe("Import detail cohesion (#1340)", () => {
  test("deterministic doc: no re-apply anywhere, preview is free and exact", async ({
    page,
  }) => {
    await page.goto(`/import/${ids[DETERMINISTIC]}`);

    // Preview subtext = free + exact (no AI call, no quota).
    const preview = page.getByTestId("preview-subtext");
    await expect(preview).toContainText("no AI call, no quota");
    await expect(preview).toContainText("exact");
    // Never carries the AI cost note.
    await expect(preview).not.toContainText("daily extraction");

    // Zero re-apply narration: no button, no subtext, no stray "Re-apply" copy.
    await expect(page.getByTestId("reimport-from-raw")).toHaveCount(0);
    await expect(page.getByTestId("reapply-subtext")).toHaveCount(0);
    await expect(page.getByText(/Re-apply saved extraction/)).toHaveCount(0);
  });

  test("AI doc with a saved extraction: re-apply offered, preview carries the cost note", async ({
    page,
  }) => {
    await page.goto(`/import/${ids[AI_WITH_RAW]}`);

    await expect(page.getByTestId("preview-subtext")).toContainText(
      "costs one daily extraction"
    );
    await expect(page.getByTestId("reimport-from-raw")).toBeVisible();
    await expect(page.getByTestId("reapply-subtext")).toContainText(
      "no AI call, no quota"
    );
  });

  test("AI doc without a saved extraction: cost note present, but no re-apply", async ({
    page,
  }) => {
    await page.goto(`/import/${ids[AI_NO_RAW]}`);

    await expect(page.getByTestId("preview-subtext")).toContainText(
      "costs one daily extraction"
    );
    await expect(page.getByTestId("reimport-from-raw")).toHaveCount(0);
    await expect(page.getByTestId("reapply-subtext")).toHaveCount(0);
  });

  test("a record-less doc collapses empty sections (no em-dash walls, no empty Debug)", async ({
    page,
  }) => {
    await page.goto(`/import/${ids[AI_NO_RAW]}`);

    // Provenance shows only the populated fields — no em-dash rows for the absent
    // source / document date / patient name.
    const provenance = page
      .getByRole("heading", { name: "Provenance" })
      .locator("xpath=ancestor::div[contains(@class,'card')][1]");
    await expect(provenance).toContainText("Detected format");
    await expect(provenance).not.toContainText("—");
    await expect(provenance).not.toContainText("Patient named in document");

    // The Document section collapses to a single "not stored" line (no blank frame).
    await expect(
      page.getByText("The original file isn’t stored.")
    ).toBeVisible();

    // Debug self-hides when it has nothing to say (no error, no raw).
    await expect(page.getByTestId("debug-disclosure")).toHaveCount(0);
  });

  test("a failed preview shows the compact fallback, not a dead frame", async ({
    page,
  }) => {
    await page.goto(`/import/${ids[BROKEN_PREVIEW]}`);

    // The <img> can't load (its stored file is absent) → onError swaps in the
    // fallback with an Open-original link.
    const fallback = page.getByTestId("preview-unavailable");
    await expect(fallback).toBeVisible({ timeout: 15_000 });
    await expect(
      fallback.getByRole("link", { name: /Open original/ })
    ).toHaveAttribute("href", `/medical/file/${ids[BROKEN_PREVIEW]}`);
  });

  test("Move pre-selects no target — disabled until a profile is chosen, and the confirm names the scope", async ({
    page,
  }) => {
    await page.goto(`/import/${ids[AI_NO_RAW]}`);

    // The move dropdown defaults to the "Choose profile…" placeholder (value 0), so
    // an accidental cross-profile move isn't one click away.
    const dest = page.getByTestId("reassign-dest");
    await expect(dest).toBeVisible();
    await expect(dest).toHaveValue("0");
    const move = page.getByRole("button", { name: "Move", exact: true });
    await expect(move).toBeDisabled();

    // Choosing a real profile (the first destination, whatever the seed named it)
    // enables Move; the confirm names the destination scope with the record count.
    await dest.selectOption({ index: 1 });
    const target = (await dest.locator("option").nth(1).textContent())?.trim();
    expect(target).toBeTruthy();
    await expect(move).toBeEnabled();
    await move.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`its 0 records to ${target}`);
    // Cancel — the e2e never actually re-files the fixture.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });
});
