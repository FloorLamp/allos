// SERVER-ACTION TIER — the "From your records" medication bridge (issue #817).
//
// The bridge lets a user "Track this" from an imported prescription record
// (medical_records category='prescription'), materializing a structured
// kind='medication' intake_item linked to the source document so reassign/delete stay
// whole (#199-#203), and dismiss a suggestion through the name-keyed findings bus
// (#203). These tests drive the real Server Actions against the throwaway temp DB.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  trackMedicationFromRecord,
  dismissMedicationRecord,
} from "@/app/(app)/medications/actions";
import { medBridgeDismissalKey } from "@/lib/medication-record-match";
import { seedActor, createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

// A medical_documents row + a prescription medical_records row referencing it.
// Returns the record id (and the document id). document_id is a real FK (foreign_keys
// is ON at runtime), so the document must exist before the tracked med links to it.
function seedPrescription(
  profileId: number,
  name: string,
  opts: { documentId?: number | null; canonical?: string | null } = {}
): { recordId: number; documentId: number | null } {
  let documentId = opts.documentId;
  if (documentId === undefined) {
    documentId = Number(
      db
        .prepare(
          `INSERT INTO medical_documents
             (profile_id, filename, stored_path, extraction_status, extracted_count)
           VALUES (?, 'rx.xml', '', 'done', 1)`
        )
        .run(profileId).lastInsertRowid
    );
  }
  const recordId = Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, canonical_name, document_id, source)
         VALUES (?, '2026-06-01', 'prescription', ?, ?, ?, 'ccda')`
      )
      .run(profileId, name, opts.canonical ?? name, documentId).lastInsertRowid
  );
  return { recordId, documentId };
}

function medRow(profileId: number, name: string) {
  return db
    .prepare(
      `SELECT id, name, kind, source, document_id, active, as_needed
         FROM intake_items
        WHERE profile_id = ? AND name = ? AND kind = 'medication'`
    )
    .get(profileId, name) as
    | {
        id: number;
        name: string;
        kind: string;
        source: string | null;
        document_id: number | null;
        active: number;
        as_needed: number;
      }
    | undefined;
}

function dismissalKeys(profileId: number): string[] {
  return (
    db
      .prepare(
        "SELECT signal_key FROM upcoming_dismissals WHERE profile_id = ? ORDER BY signal_key"
      )
      .all(profileId) as { signal_key: string }[]
  ).map((r) => r.signal_key);
}

describe("trackMedicationFromRecord", () => {
  it("materializes a tracked med linked to the source document", async () => {
    const { profile } = seedActor();
    const { recordId, documentId } = seedPrescription(
      profile.id,
      "Lisinopril 10 mg",
      { canonical: "Lisinopril" }
    );

    const res = await trackMedicationFromRecord(fd({ record_id: recordId }));
    expect(res.ok).toBe(true);

    // cleanMedicationName strips the strength, so the tracked med is "Lisinopril".
    const med = medRow(profile.id, "Lisinopril");
    expect(med).toBeDefined();
    expect(med!.kind).toBe("medication");
    // Linked to the source document so reassign/delete stay whole (#199-#203).
    expect(med!.source).toBe("extracted");
    expect(med!.document_id).toBe(documentId);
    expect(med!.active).toBe(1);

    // It opened a course and revalidated the surfaces.
    const courses = db
      .prepare("SELECT COUNT(*) AS n FROM medication_courses WHERE item_id = ?")
      .get(med!.id) as { n: number };
    expect(courses.n).toBe(1);
    expect(revalidate).toHaveBeenCalledWith("/medications");
  });

  it("carries a null document_id through for a documentless record", async () => {
    const { profile } = seedActor();
    const { recordId } = seedPrescription(profile.id, "Metformin", {
      documentId: null,
    });
    const res = await trackMedicationFromRecord(fd({ record_id: recordId }));
    expect(res.ok).toBe(true);
    const med = medRow(profile.id, "Metformin");
    expect(med?.document_id).toBeNull();
    expect(med?.source).toBe("extracted");
  });

  it("refuses a missing / non-prescription record id (no-op)", async () => {
    const { profile } = seedActor();
    const res = await trackMedicationFromRecord(fd({ record_id: 999999 }));
    expect(res.ok).toBe(false);
    const count = db
      .prepare(
        "SELECT COUNT(*) AS n FROM intake_items WHERE profile_id = ? AND kind = 'medication'"
      )
      .get(profile.id) as { n: number };
    expect(count.n).toBe(0);
  });

  it("does not track another profile's prescription record", async () => {
    const login = createLogin({ role: "admin" });
    const a = createProfile("Bridge-A", login.id);
    const b = createProfile("Bridge-B", login.id);
    const { recordId } = seedPrescription(b.id, "Atorvastatin");

    // Acting as A, tracking B's record: the scoped read (id AND profile_id) finds
    // nothing, so it's a no-op even for an admin acting as A.
    actAs(login, a);
    const res = await trackMedicationFromRecord(fd({ record_id: recordId }));
    expect(res.ok).toBe(false);
    expect(medRow(a.id, "Atorvastatin")).toBeUndefined();
  });
});

describe("dismissMedicationRecord", () => {
  it("stores the name-keyed med-bridge dismissal", async () => {
    const { profile } = seedActor();
    const key = medBridgeDismissalKey({
      name: "Amoxicillin 500 mg",
      canonical_name: "Amoxicillin",
    });
    const res = await dismissMedicationRecord(fd({ dedupe_key: key }));
    expect(res.ok).toBe(true);
    expect(dismissalKeys(profile.id)).toContain("med-bridge:amoxicillin");
    expect(revalidate).toHaveBeenCalledWith("/medications");
  });

  it("refuses a key outside the med-bridge namespace", async () => {
    const { profile } = seedActor();
    const res = await dismissMedicationRecord(fd({ dedupe_key: "dose:12" }));
    expect(res.ok).toBe(false);
    expect(dismissalKeys(profile.id)).toEqual([]);
  });
});
