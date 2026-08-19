// DB INTEGRATION TIER — adopting the source-supplied RxCUI through the CCDA/FHIR
// import path (#3070), over the REAL pipeline: extractFromCcda →
// healthRecordToPersistInput → persistDocumentImport. Pins:
//   • the observed albuterol record (RxNorm OID, code 630208) lands with
//     rxcui = '630208' and rxcui_ingredients still NULL (#279 stays a separate step);
//   • an NDC-coded medication stays uncoded;
//   • a reprocess is idempotent (one item, same code);
//   • a renewal FILLS an uncoded existing med but never overwrites a
//     user-confirmed/hand-edited code;
//   • the #1045 data-quality gap counts only genuinely uncoded items.
// All fixtures synthetic (codes are the issue's own cited RxCUIs, no PHI).

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { extractFromCcda } from "@/lib/cda";
import { healthRecordToPersistInput } from "@/lib/import-shape";
import { persistDocumentImport } from "@/lib/import-persist";
import { getMedicationsMissingRxcuiCount } from "@/lib/queries";

// The observed record's shape: an active med-list entry whose material code the
// issuing system stamped with the RxNorm OID.
const ALBUTEROL_CCD = `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <effectiveTime value="20251204"/>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.1.1"/>
    <code code="10160-0" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Medications</title>
    <entry><substanceAdministration classCode="SBADM" moodCode="EVN">
      <statusCode code="active"/>
      <effectiveTime type="IVL_TS"><low value="20251204"/></effectiveTime>
      <consumable><manufacturedProduct><manufacturedMaterial>
        <code code="630208" codeSystem="2.16.840.1.113883.6.88"/>
        <name>albuterol (2.5 MG/3ML) 0.083% nebulizer solution</name>
      </manufacturedMaterial></manufacturedProduct></consumable>
    </substanceAdministration></entry>
  </section></component></structuredBody></component>
</ClinicalDocument>`;

// The same entry carrying only an NDC — must never land in rxcui.
const NDC_CCD = ALBUTEROL_CCD.replace(
  `<code code="630208" codeSystem="2.16.840.1.113883.6.88"/>`,
  `<code code="12345-6789-01" codeSystem="2.16.840.1.113883.6.69"/>`
);

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function newDocument(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, 'meds.ccd', '', 'processing', 'ccd')`
      )
      .run(profileId).lastInsertRowid
  );
}

function importCcd(profileId: number, docId: number, xml: string): void {
  persistDocumentImport(
    profileId,
    docId,
    healthRecordToPersistInput(extractFromCcda(xml), "ccd-test", "CCD")
  );
}

function meds(profileId: number): {
  id: number;
  name: string;
  rxcui: string | null;
  rxcui_ingredients: string | null;
}[] {
  return db
    .prepare(
      `SELECT id, name, rxcui, rxcui_ingredients FROM intake_items
        WHERE profile_id = ? AND kind = 'medication' ORDER BY id`
    )
    .all(profileId) as any;
}

// A manual tracked med with an OPEN course (the renewal target shape).
function seedManualMed(
  profileId: number,
  name: string,
  rxcui: string | null
): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation, rxcui)
         VALUES (?, ?, 1, 'medication', 'daily', 'must', ?)`
      )
      .run(profileId, name, rxcui).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO medication_courses (item_id, started_on, stopped_on) VALUES (?, '2025-01-01', NULL)`
  ).run(id);
  return id;
}

describe("import adopts the source-supplied RxCUI (#3070)", () => {
  it("writes the observed albuterol record's code as rxcui, ingredients stay null, re-import idempotent", () => {
    const p = newProfile("RxcuiAdopt");
    const d = newDocument(p);
    importCcd(p, d, ALBUTEROL_CCD);

    let rows = meds(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].rxcui).toBe("630208");
    // Product code adopted, ingredients NOT fabricated — the #279 decomposition
    // stays the separate (network) step it already is.
    expect(rows[0].rxcui_ingredients).toBeNull();

    // Reprocess the same document: still one item, same code — never a duplicate.
    importCcd(p, d, ALBUTEROL_CCD);
    rows = meds(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].rxcui).toBe("630208");
    expect(rows[0].rxcui_ingredients).toBeNull();
  });

  it("an NDC-coded medication imports with NO rxcui (the code-system check is the gate)", () => {
    const p = newProfile("RxcuiNdc");
    importCcd(p, newDocument(p), NDC_CCD);
    const rows = meds(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].rxcui).toBeNull();
    // …and it is exactly what the data-quality gap should still count.
    expect(getMedicationsMissingRxcuiCount(p)).toBe(1);
  });

  it("a renewal fills an existing UNCODED med's rxcui — and the data-quality gap drops by one", () => {
    const p = newProfile("RxcuiRenewFill");
    const manualId = seedManualMed(p, "Albuterol", null);
    expect(getMedicationsMissingRxcuiCount(p)).toBe(1); // the "confirm 1 match" gap
    importCcd(p, newDocument(p), ALBUTEROL_CCD);
    expect(getMedicationsMissingRxcuiCount(p)).toBe(0); // newly coded — gap gone

    // Renewal, not a new item — and the previously uncoded med now carries the
    // source-supplied code.
    const rows = meds(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(manualId);
    expect(rows[0].rxcui).toBe("630208");
    expect(rows[0].rxcui_ingredients).toBeNull();
  });

  it("a renewal NEVER overwrites a user-confirmed/hand-edited code", () => {
    const p = newProfile("RxcuiRenewKeep");
    // The user confirmed the INGREDIENT-level code (435, albuterol) by hand.
    const manualId = seedManualMed(p, "Albuterol", "435");
    importCcd(p, newDocument(p), ALBUTEROL_CCD);

    const rows = meds(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(manualId);
    expect(rows[0].rxcui).toBe("435"); // the confirmed code wins over the re-import
  });

  it("the data-quality gap drops by the newly coded items and keeps counting the uncoded", () => {
    const p = newProfile("RxcuiGap");
    seedManualMed(p, "Loratadine", null); // genuinely uncoded — stays in the gap
    expect(getMedicationsMissingRxcuiCount(p)).toBe(1);

    importCcd(p, newDocument(p), ALBUTEROL_CCD);
    // The imported albuterol arrives coded, so the gap does NOT grow — it keeps
    // measuring only what no source ever coded.
    expect(getMedicationsMissingRxcuiCount(p)).toBe(1);
    expect(
      meds(p).find((m) => m.name.toLowerCase().includes("albuterol"))!.rxcui
    ).toBe("630208");
  });
});
