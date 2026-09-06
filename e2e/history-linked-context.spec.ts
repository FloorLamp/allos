import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath, frozenNow } from "./worker-env";

// Linked context on the record (issue #662): an IMPORTED visit deep-links the other
// records its source document produced — the care-plan items / procedures /
// medications sharing its document_id. Informational lineage reference, never a
// causal claim. This spec plants a self-contained import lineage (a document + an
// encounter carrying its id + one sibling of each kind) directly in the DB and
// asserts the visit ROW's disclosure renders the "From this visit's document" links,
// then removes them — never touching a shared-seed row a neighbor exact-counts.
//
// IT IS THE SPEC PHASE 2C DELETED WITH ITS SUBJECT. `/timeline`'s card was the only
// renderer these refs ever had, so the guard went with the route and the capability
// was gathered-and-unshown until phase 2d gave the row a disclosure. Restored here
// rather than rewritten: the seed and the four link assertions are the ones that were
// running, so what changed is the surface, which is the whole point.
//
// THE DISCLOSURE IS A CLICK, and that is the part a ported assertion gets wrong. The
// record's row is one line: nothing in the panel is in the DOM until the detail cell
// is tapped, so an assertion that merely looked for the refs would fail as "not
// found" and read like a regression in the gather.
const DB_PATH = workerDbPath();
const DOC_FILE = "e2e-lineage-ccd.xml";
const VISIT_TYPE = "E2E Lineage Visit";

function todayStr(): string {
  return frozenNow().toISOString().slice(0, 10);
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

test.describe("the record's linked context — visit → document lineage (#662)", () => {
  test.beforeAll(() => {
    cleanup();
    seed();
  });
  test.afterAll(cleanup);

  test("an imported visit links the records its document produced", async ({
    page,
  }) => {
    // Filter to the visit kind so the planted visit is on the first page regardless
    // of how much other history exists.
    await page.goto("/history?kind=visit");

    // eslint-disable-next-line no-restricted-properties -- first-ok: the record row for VISIT_TYPE, a visit THIS spec created (unique type)
    const row = page
      .getByTestId("history-row")
      .filter({ hasText: VISIT_TYPE })
      .first();
    await expect(row).toBeVisible();

    // Nothing is disclosed until the row is asked. Asserted before the click so a
    // panel that shipped permanently open — which would break the one-line rule for
    // every reader — cannot pass this spec by being there already.
    await expect(page.getByTestId("history-linked-refs")).toHaveCount(0);
    // Measured at 390px, where the one-line rule is load-bearing and where a panel
    // nested inside the row would show up as the row growing.
    await page.setViewportSize({ width: 390, height: 844 });
    const beforeOpen = Math.round((await row.boundingBox())?.height ?? -1);
    await row.getByTestId("history-row-disclosure").click();
    const afterOpen = Math.round((await row.boundingBox())?.height ?? -2);

    const refs = page.getByTestId("history-linked-refs");
    await expect(refs).toBeVisible();
    // EXACT, NOT CONTAINED: "From this visit" is a prefix of the document wording, so
    // a containment assertion here would pass on a panel that had lost the scope
    // (#2920) and started claiming an encounter link this document never had.
    await expect(refs.getByTestId("history-linked-scope")).toHaveText(
      "From this visit’s document"
    );

    // Each sibling kind is linked to its domain surface.
    // THE ROW IS STILL ONE LINE WITH ITS PANEL OPEN (#3958's owner ruling), asserted
    // as a RELATIONSHIP between two readings of the same element rather than against a
    // pixel constant: the row's own height before the click and after it. The panel is
    // a SIBLING `<li>` for exactly this reason, and an absolute ceiling would pass on a
    // tree where the row grew by a line and the constant happened to allow it.
    expect(afterOpen).toEqual(beforeOpen);

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
