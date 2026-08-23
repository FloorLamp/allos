import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";

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

const DB_PATH = workerDbPath();
const PROFILE_ID = 1; // the seed's bootstrap admin profile (the active profile)

// Distinct filenames so cleanup targets exactly this spec's rows.
const AI_WITH_RAW = "e2e-1340-ai-with-raw.pdf";
const AI_NO_RAW = "e2e-1340-ai-no-raw.pdf";
const DETERMINISTIC = "e2e-1340-deterministic.xml";
const BROKEN_PREVIEW = "e2e-1340-broken-image.png";
// #3493's fixture: a health record that IS stored but cannot inline-preview (so the
// Document card takes its no-preview branch), acquired from a portal, carrying one
// UCUM-spelled vitals reading. One document exercises all three of that issue's
// display-boundary fixes on one page load.
const PROVENANCE = "e2e-3493-provenance.xml";
const FIXTURE_NAMES = [
  AI_WITH_RAW,
  AI_NO_RAW,
  DETERMINISTIC,
  BROKEN_PREVIEW,
  PROVENANCE,
];

// The portal #3493's fixture document was acquired from. Its SLUG and its display
// NAME differ on purpose — that difference is what the acquired-via assertion is for.
const PORTAL_SLUG = "e2e-3493-portal";
const PORTAL_NAME = "E2E Ochsner MyChart";
// Marks this spec's medical_records row for cleanup.
const RECORD_SOURCE = "e2e-3493-ucum";

const ids: Record<string, number> = {};

test.beforeAll(() => {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare(
        `DELETE FROM medical_documents WHERE profile_id = ? AND filename IN (?, ?, ?, ?, ?)`
      )
      .run(PROFILE_ID, ...FIXTURE_NAMES);
    handle
      .prepare(`DELETE FROM medical_records WHERE source = ?`)
      .run(RECORD_SOURCE);
    handle.prepare(`DELETE FROM portals WHERE slug = ?`).run(PORTAL_SLUG);
    const portalId = Number(
      handle
        .prepare(`INSERT INTO portals (slug, name) VALUES (?, ?)`)
        .run(PORTAL_SLUG, PORTAL_NAME).lastInsertRowid
    );
    const insert = handle.prepare(
      `INSERT INTO medical_documents
         (profile_id, filename, stored_path, mime_type, size_bytes, doc_type,
          source, extraction_status, extracted_count, uploaded_at, raw_extraction,
          acquired_portal_id)
       VALUES (@profile_id, @filename, @stored_path, @mime_type, 2048, @doc_type,
               @source, 'done', 0, '2026-07-10 09:00:00', @raw, @portal)`
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
        portal: null,
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
        portal: null,
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
        portal: null,
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
        portal: null,
      }).lastInsertRowid
    );
    // #3493. `doc_type` is NULL so "Detected format" falls through to `source` — the
    // branch that used to print the parser's own key. Stored but un-previewable
    // (XML), so the Document card renders its no-inline-preview line beside the
    // header's own open-original door: the doubled door, in one card.
    ids[PROVENANCE] = Number(
      insert.run({
        profile_id: PROFILE_ID,
        filename: PROVENANCE,
        stored_path: "data/uploads/medical/1/e2e-3493-nonexistent.xml",
        mime_type: "application/xml",
        doc_type: null,
        source: "ccda",
        raw: null,
        portal: portalId,
      }).lastInsertRowid
    );
    // One vitals reading spelled the way a real C-CDA ships it. The value is what a
    // person reads on the Vitals tab; the STORED unit stays "mm[Hg]" and is asserted
    // to have stayed that way, because #3493 changes display and nothing else.
    handle
      .prepare(
        `INSERT INTO medical_records
           (profile_id, document_id, date, category, name, value, value_num, unit, source)
         VALUES (?, ?, '2026-07-10', 'vitals', 'Diastolic Blood Pressure', '60', 60, 'mm[Hg]', ?)`
      )
      .run(PROFILE_ID, ids[PROVENANCE], RECORD_SOURCE);
  } finally {
    handle.close();
  }
});

test.afterAll(() => {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare(`DELETE FROM medical_records WHERE source = ?`)
      .run(RECORD_SOURCE);
    handle
      .prepare(
        `DELETE FROM medical_documents WHERE profile_id = ? AND filename IN (?, ?, ?, ?, ?)`
      )
      .run(PROFILE_ID, ...FIXTURE_NAMES);
    // After the documents, so nothing still points at it.
    handle.prepare(`DELETE FROM portals WHERE slug = ?`).run(PORTAL_SLUG);
  } finally {
    handle.close();
  }
});

test.describe("Import detail cohesion (#1340)", () => {
  test("deterministic doc: no re-apply anywhere, preview is free and exact", async ({
    page,
  }) => {
    await page.goto(`/import/${ids[DETERMINISTIC]}`);

    // Preview subtext = free + exact, IN THE READER'S TERMS (#3493 item 4). It used
    // to spend its second half on our own accounting ("no AI call, no quota"); the
    // absence half of this assertion is the guard that keeps it out. The AI branch's
    // cost note is a real price and is asserted, unchanged, in the tests below.
    const preview = page.getByTestId("preview-subtext");
    await expect(preview).toContainText("free");
    await expect(preview).toContainText("exactly the same result");
    await expect(preview).not.toContainText("quota");
    await expect(preview).not.toContainText("AI");
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

  // ── #3493: the import review page stops showing its internals ──────────────────

  test("Provenance reads in words, not in the parser's keys (#3493)", async ({
    page,
  }) => {
    await page.goto(`/import/${ids[PROVENANCE]}`);

    // SOURCE. "ccda" is lib/health-record-parse.ts's own return value; a person
    // reading a provenance card should not have to know that.
    const source = page.getByTestId("doc-source");
    await expect(source).toContainText("C-CDA document");
    await expect(source).not.toContainText("ccda");
    // And the same key reached the "Detected format" row and the page subtitle,
    // because both fall through to `source` when a document has no doc_type.
    await expect(page.getByRole("main")).not.toContainText("ccda");

    // ACQUIRED VIA is a different animal and this assertion says which. The value is
    // NOT a stored enum: #1748 resolves `acquired_portal_id` through the portal
    // REGISTRY to that portal's current display name, so what belongs here is the
    // name the household typed — never the slug allos minted from it, and never a
    // code-side relabelling of somebody's own portal name.
    const acquired = page.getByTestId("doc-acquired-via");
    await expect(acquired).toContainText(PORTAL_NAME);
    await expect(acquired).not.toContainText(PORTAL_SLUG);
  });

  test("no UCUM bracket syntax renders in the produced rows (#3493)", async ({
    page,
  }) => {
    await page.goto(`/import/${ids[PROVENANCE]}`);

    // The reading, as a person reads it. Pre-fix this cell said "60 mm[Hg]" — the
    // matcher has stripped that spelling since #1018, the display side never did.
    // Scoped to <main>. This fixture carries no stored raw and no extraction error, so
    // the Debug disclosure — the one place on this page that is DELIBERATELY raw
    // internals (#3493 lists it under "deliberately not flagged") — does not render
    // here at all, and the sweep can be the whole page without arguing about it.
    const main = page.getByRole("main");
    await expect(main).toContainText("mmHg");
    await expect(main).not.toContainText("mm[Hg]");

    // STORAGE IS UNTOUCHED, and that is the half a rendering assertion cannot see.
    // A "fix" that normalized on write would satisfy everything above and would have
    // rewritten the document's own words.
    const stored = new Database(DB_PATH);
    try {
      const unit = stored
        .prepare(`SELECT unit FROM medical_records WHERE source = ?`)
        .get(RECORD_SOURCE) as { unit: string };
      expect(unit.unit).toBe("mm[Hg]");
    } finally {
      stored.close();
    }
  });

  test("the Document card states its open-original door once (#3493)", async ({
    page,
  }) => {
    await page.goto(`/import/${ids[PROVENANCE]}`);

    const card = page
      .getByRole("heading", { name: "Document", exact: true })
      .locator("xpath=ancestor::div[contains(@class,'card')][1]");
    // The no-preview line is still there — the card must still SAY why it shows no
    // preview; what left is the second link to the same place.
    await expect(card).toContainText("Inline preview isn’t available");
    // Counted, not "the second one is gone": a count is the assertion that survives
    // somebody adding a third.
    await expect(
      card.getByRole("link", { name: /Open (the )?original/i })
    ).toHaveCount(1);
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
