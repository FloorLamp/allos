import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";

// Timeline linked context (issue #662): an IMPORTED visit deep-links the other
// records its source document produced — the care-plan items / procedures /
// medications sharing its document_id. Informational lineage reference, never a
// causal claim. This spec plants a self-contained import lineage (a document + an
// encounter carrying its id + one sibling of each kind) directly in the DB and
// asserts the visit card renders the "From this visit's document" links, then
// removes them — never touching a shared-seed row a neighbor exact-counts.
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";
const DOC_FILE = "e2e-lineage-ccd.xml";
const VISIT_TYPE = "E2E Lineage Visit";

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    const doc = handle
      .prepare("SELECT id FROM medical_documents WHERE filename = ?")
      .get(DOC_FILE) as { id: number } | undefined;
    if (doc) {
      for (const table of [
        "procedures",
        "care_plan_items",
        "intake_items",
        "encounters",
      ]) {
        handle
          .prepare(`DELETE FROM ${table} WHERE document_id = ?`)
          .run(doc.id);
      }
      handle.prepare("DELETE FROM medical_documents WHERE id = ?").run(doc.id);
    }
  } finally {
    handle.close();
  }
}

function seed() {
  const handle = new Database(DB_PATH);
  try {
    const date = todayStr();
    const docId = Number(
      handle
        .prepare(
          `INSERT INTO medical_documents
             (profile_id, filename, stored_path, extraction_status, doc_type)
           VALUES (1, ?, '', 'done', 'ccd')`
        )
        .run(DOC_FILE).lastInsertRowid
    );
    handle
      .prepare(
        `INSERT INTO encounters (profile_id, date, type, reason, document_id)
         VALUES (1, ?, ?, 'annual checkup', ?)`
      )
      .run(date, VISIT_TYPE, docId);
    handle
      .prepare(
        `INSERT INTO procedures (profile_id, name, date, source, document_id)
         VALUES (1, 'E2E Colonoscopy', ?, 'extracted', ?)`
      )
      .run(date, docId);
    handle
      .prepare(
        `INSERT INTO care_plan_items (profile_id, description, source, document_id)
         VALUES (1, 'E2E follow-up in 6 months', 'extracted', ?)`
      )
      .run(docId);
    handle
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, source, document_id)
         VALUES (1, 'E2E Lisinopril', 'medication', 'extracted', ?)`
      )
      .run(docId);
  } finally {
    handle.close();
  }
}

test.describe("timeline linked context — visit → document lineage (#662)", () => {
  test.beforeAll(() => {
    cleanup();
    seed();
  });
  test.afterAll(cleanup);

  test("an imported visit links the records its document produced", async ({
    page,
  }) => {
    // Filter to the Visit category so the planted visit is on the first page
    // regardless of how much other history exists.
    await page.goto("/timeline?category=visit");

    const card = page.locator(".group").filter({ hasText: VISIT_TYPE }).first(); // first-ok: the timeline card for VISIT_TYPE, a visit THIS spec created (unique type)
    await expect(card).toBeVisible();

    const refs = card.getByTestId("timeline-linked-refs");
    await expect(refs).toBeVisible();
    await expect(refs).toContainText("From this visit’s document");

    // Each sibling kind is linked to its domain surface.
    const colonoscopy = refs.getByRole("link", {
      name: "Procedure: E2E Colonoscopy",
    });
    await expect(colonoscopy).toHaveAttribute(
      "href",
      "/records/history/procedures"
    );
    await expect(
      refs.getByRole("link", { name: "Care plan: E2E follow-up in 6 months" })
    ).toHaveAttribute("href", "/records/care/overview");
    await expect(
      refs.getByRole("link", { name: "Medication: E2E Lisinopril" })
    ).toHaveAttribute("href", "/medications");
  });
});
