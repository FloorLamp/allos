// SERVER-ACTION TIER — reassign a mis-filed document to another profile.
// Runs the real reassignDocument against the throwaway temp DB
// with the auth chokepoint mocked (setup.ts): it proves the move re-points EVERY
// owned row to the destination, leaves the source with zero rows for the document,
// nulls nothing it shouldn't, moves the on-disk file, and is rejected when the
// login can't reach the destination.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { reassignDocument } from "@/app/(app)/medical/actions";
import { getReprocessSnapshot, reconcileFlags } from "@/lib/queries";
import {
  persistDocumentImport,
  IMPORT_FOOTPRINT_TABLES,
} from "@/lib/import-persist";
import { computeImportDiff } from "@/lib/import-diff";
import type { PersistInput } from "@/lib/import-shape";
import { db } from "@/lib/db";
import { createLogin, createProfile, actAs, fd } from "./harness";

const DATE = "2020-06-01";

function makeInput(): PersistInput {
  return {
    records: [
      {
        category: "lab",
        name: "Glucose",
        canonical: "Glucose",
        value: "95",
        value_num: 95,
        unit: "mg/dL",
        date: DATE,
        reference_range: null,
        flag: null,
        panel: null,
        notes: null,
        source: "ccda",
        external_id: "obs:glucose",
        loinc: null,
        provider: null,
        courses: null,
      },
      {
        category: "prescription",
        name: "Lisinopril 10 mg",
        canonical: "Lisinopril",
        value: null,
        value_num: null,
        unit: null,
        date: DATE,
        reference_range: null,
        flag: null,
        panel: null,
        notes: "Take one daily",
        source: "ccda",
        external_id: "med:lisinopril",
        loinc: null,
        provider: null,
        courses: null,
      },
    ],
    immunizations: [
      {
        date: DATE,
        vaccine: "influenza",
        dose_label: null,
        notes: null,
        external_id: "imm:flu",
        provider: null,
      },
    ],
    allergies: [
      {
        substance: "Penicillin",
        substance_code: null,
        substance_code_system: null,
        reaction: "hives",
        severity: "moderate",
        status: "active",
        onset_date: null,
        external_id: "alg:pcn",
      },
    ],
    conditions: [
      {
        name: "Hypertension",
        code: null,
        code_system: null,
        status: "active",
        onset_date: null,
        resolved_date: null,
        external_id: "cond:htn",
      },
    ],
    encounters: [
      {
        date: DATE,
        end_date: null,
        type: "office visit",
        class_code: null,
        reason: "annual physical",
        diagnoses: [],
        provider: null,
        location: null,
        notes: null,
        external_id: "enc:physical",
      },
    ],
    // The four tables reassign used to strand cross-profile (#201) — populated so the
    // move/empties assertions actually exercise them.
    procedures: [
      {
        name: "Appendectomy",
        code: null,
        code_system: null,
        date: DATE,
        provider: null,
        external_id: "proc:appy",
      },
    ],
    familyHistory: [
      {
        relation: "mother",
        condition: "Diabetes",
        code: null,
        code_system: null,
        onset_age: 55,
        deceased: 0,
        external_id: "fh:dm",
      },
    ],
    carePlanItems: [
      {
        description: "Colonoscopy screening",
        code: null,
        code_system: null,
        category: "procedure",
        planned_date: DATE,
        status: "planned",
        provider: null,
        external_id: "cp:colo",
      },
    ],
    careGoals: [
      {
        description: "Lower systolic BP below 130",
        code: null,
        code_system: null,
        target_date: DATE,
        status: "in-progress",
        external_id: "cg:bp",
      },
    ],
    bodyMetrics: [
      { date: DATE, weight_kg: 80, body_fat_pct: null, resting_hr: null },
    ],
    heights: [{ date: DATE, height_cm: 175 }],
    headCircs: [],
    demographics: null,
    meta: {
      docType: "ccd",
      source: "ccd",
      documentDate: DATE,
      patientName: "Test Patient",
      raw: null,
      model: null,
      importReport: null,
    },
    canonicalNamesToRegister: [],
    providers: [],
  };
}

function newDocument(profileId: number, storedPath = ""): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, 'doc.ccd', ?, 'processing', 'ccd')`
      )
      .run(profileId, storedPath).lastInsertRowid
  );
}

const UPLOAD_DIR = path.join(process.cwd(), "data", "uploads", "medical");

// Count every owned row a document produced, straight from the DB, for a profile —
// driven off the SHARED IMPORT_FOOTPRINT_TABLES list (not a hand-maintained set) so
// the count covers the FULL footprint and can't silently omit a table the way the
// original five-table version omitted procedures/family_history/care_plan_items/
// care_goals (the #201 blind spot). Every footprint table contributes here, so the
// "empties the source" assertion is meaningful for all of them.
function ownedRowCount(profileId: number, docId: number): number {
  const src = `document:${docId}`;
  let total = 0;
  for (const t of IMPORT_FOOTPRINT_TABLES) {
    const keyVal = t.key === "document_id" ? docId : src;
    const sql = `SELECT COUNT(*) c FROM ${t.table} WHERE ${t.key} = ? AND profile_id = ?${
      t.extra ? ` AND ${t.extra}` : ""
    }`;
    total += (db.prepare(sql).get(keyVal, profileId) as { c: number }).c;
  }
  return total;
}

describe("reassignDocument", () => {
  it("moves every owned row + the document to the destination and empties the source", async () => {
    const admin = createLogin({ role: "admin" });
    const a = createProfile("REASSIGN-A");
    const b = createProfile("REASSIGN-B");
    const docId = newDocument(a.id);
    persistDocumentImport(a.id, docId, makeInput());
    // Reconcile flags under A first, so the snapshot captures A's final state and
    // the destination reconcile (same demographics — both profiles have no sex set)
    // yields the identical flags, keeping the content comparison about the MOVE, not
    // the flag recompute (which its own test covers).
    reconcileFlags(a.id);
    actAs(admin, a);

    const beforeA = ownedRowCount(a.id, docId);
    expect(beforeA).toBeGreaterThan(0);
    const snapshotA = getReprocessSnapshot(a.id, docId);

    const res = await reassignDocument(fd({ id: docId, destProfileId: b.id }));
    expect(res.status).toBe("done");

    // The document row now belongs to B.
    const owner = db
      .prepare("SELECT profile_id FROM medical_documents WHERE id = ?")
      .get(docId) as { profile_id: number };
    expect(owner.profile_id).toBe(b.id);

    // Source A has zero rows for the document; B has exactly what A had.
    expect(ownedRowCount(a.id, docId)).toBe(0);
    expect(ownedRowCount(b.id, docId)).toBe(beforeA);

    // The imported content is intact under B — identical to A's reconciled snapshot.
    const snapshotB = getReprocessSnapshot(b.id, docId);
    expect(computeImportDiff(snapshotA, snapshotB).hasChanges).toBe(false);
  });

  it("moves the on-disk file into the destination profile's directory", async () => {
    const admin = createLogin({ role: "admin" });
    const a = createProfile("FILE-A");
    const b = createProfile("FILE-B");
    // Write a real stored file under A's upload dir.
    const srcDir = path.join(UPLOAD_DIR, String(a.id));
    fs.mkdirSync(srcDir, { recursive: true });
    // Reserve the doc id first so the stored name mirrors production ("<id>-name").
    const docId = newDocument(a.id);
    const stored = `${docId}-doc.ccd`;
    fs.writeFileSync(path.join(srcDir, stored), "hello");
    const relPath = path.join(
      "data",
      "uploads",
      "medical",
      String(a.id),
      stored
    );
    db.prepare("UPDATE medical_documents SET stored_path = ? WHERE id = ?").run(
      relPath,
      docId
    );
    persistDocumentImport(a.id, docId, makeInput());
    actAs(admin, a);

    const res = await reassignDocument(fd({ id: docId, destProfileId: b.id }));
    expect(res.status).toBe("done");

    const destPath = path.join(UPLOAD_DIR, String(b.id), stored);
    expect(fs.existsSync(destPath)).toBe(true);
    expect(fs.existsSync(path.join(srcDir, stored))).toBe(false);
    const row = db
      .prepare("SELECT stored_path FROM medical_documents WHERE id = ?")
      .get(docId) as { stored_path: string };
    expect(row.stored_path).toContain(path.join(String(b.id), stored));
    // cleanup
    fs.rmSync(destPath, { force: true });
  });

  it("rejects a move to a profile the login can't access (member without a grant)", () => {
    const member = createLogin({ role: "member" });
    const a = createProfile("MEM-A", member.id); // granted
    const b = createProfile("MEM-B"); // NOT granted to the member
    const docId = newDocument(a.id);
    persistDocumentImport(a.id, docId, makeInput());
    actAs(member, a);

    return reassignDocument(fd({ id: docId, destProfileId: b.id })).then(
      (res) => {
        expect(res.status).toBe("error");
        // Rows stayed under A; B got nothing.
        expect(ownedRowCount(a.id, docId)).toBeGreaterThan(0);
        expect(ownedRowCount(b.id, docId)).toBe(0);
        const owner = db
          .prepare("SELECT profile_id FROM medical_documents WHERE id = ?")
          .get(docId) as { profile_id: number };
        expect(owner.profile_id).toBe(a.id);
      }
    );
  });

  it("rejects a no-op move onto the same profile", async () => {
    const admin = createLogin({ role: "admin" });
    const a = createProfile("SAME-A");
    const docId = newDocument(a.id);
    persistDocumentImport(a.id, docId, makeInput());
    actAs(admin, a);
    const res = await reassignDocument(fd({ id: docId, destProfileId: a.id }));
    expect(res.status).toBe("error");
  });

  it("refuses to move a document whose extraction is still in flight", async () => {
    const admin = createLogin({ role: "admin" });
    const a = createProfile("PROC-A");
    const b = createProfile("PROC-B");
    const docId = newDocument(a.id);
    persistDocumentImport(a.id, docId, makeInput());
    // Simulate a reprocess in flight: the row is 'processing' again but still has
    // its previously-imported rows under A.
    db.prepare(
      "UPDATE medical_documents SET extraction_status = 'processing' WHERE id = ?"
    ).run(docId);
    actAs(admin, a);

    const res = await reassignDocument(fd({ id: docId, destProfileId: b.id }));
    expect(res.status).toBe("error");
    expect(res.message).toMatch(/processing/i);
    // Nothing moved: rows + document row stay under A.
    expect(ownedRowCount(a.id, docId)).toBeGreaterThan(0);
    expect(ownedRowCount(b.id, docId)).toBe(0);
    const owner = db
      .prepare("SELECT profile_id FROM medical_documents WHERE id = ?")
      .get(docId) as { profile_id: number };
    expect(owner.profile_id).toBe(a.id);
  });

  it("re-derives biomarker flags against the destination after the move", async () => {
    const admin = createLogin({ role: "admin" });
    const a = createProfile("FLAG-A");
    const b = createProfile("FLAG-B");
    const docId = newDocument(a.id);
    // A single out-of-range Glucose (130 > canonical ref high) so a reconcile has a
    // definite 'high' to derive.
    const input: PersistInput = {
      ...makeInput(),
      records: [
        {
          category: "lab",
          name: "Glucose",
          canonical: "Glucose",
          value: "130",
          value_num: 130,
          unit: "mg/dL",
          date: DATE,
          reference_range: null,
          flag: null,
          panel: null,
          notes: null,
          source: "ccda",
          external_id: "obs:glucose",
          loinc: null,
          provider: null,
          courses: null,
        },
      ],
      immunizations: [],
      bodyMetrics: [],
      heights: [],
    };
    persistDocumentImport(a.id, docId, input);
    // Reconcile under A (the record's flag becomes 'high'), then CORRUPT it so a
    // dest-side reconcile has something to correct. If reassign fails to reconcile
    // the destination, the corrupted flag survives the move — the assertion catches
    // exactly that regression.
    reconcileFlags(a.id);
    db.prepare(
      "UPDATE medical_records SET flag = 'low' WHERE document_id = ? AND profile_id = ?"
    ).run(docId, a.id);
    actAs(admin, a);

    const res = await reassignDocument(fd({ id: docId, destProfileId: b.id }));
    expect(res.status).toBe("done");

    const moved = db
      .prepare(
        "SELECT flag FROM medical_records WHERE document_id = ? AND profile_id = ?"
      )
      .get(docId, b.id) as { flag: string | null };
    // reconcileFlags(dest) ran after the move: the corrupted 'low' is back to 'high'.
    expect(moved.flag).toBe("high");
  });
});
