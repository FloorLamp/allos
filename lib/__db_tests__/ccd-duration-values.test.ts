// DB INTEGRATION TIER — the #2322 duration door, end to end through a REAL import
// (ingestMedicalUpload → the C-CDA parser → import-persist), not through the mapper in
// isolation.
//
// A stress-test CCD carries `Exercise Duration` with the unit `min:sec` and a
// colon-formatted value. Two rows, one of each outcome the door has: one the parse can
// turn into a number, and one it cannot. After import, the first is a real numeric
// reading in a real unit, the SECOND IS NOT STORED AT ALL, and the document's import
// report says why. A stored string that looks like a reading is the defect.
//
// SYNTHETIC ONLY: invented patient, fictional dates, low-entropy values. No PHI.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ingestMedicalUpload } from "@/lib/medical-pipeline";
import { seedActor } from "@/lib/__action_tests__/harness";
import { parseImportReport } from "@/lib/import-report";

const DURATION = "Exercise Duration";

function ccda(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <id root="1.2.3.4" extension="20260701001"/>
  <effectiveTime value="20260701"/>
  <recordTarget><patientRole><patient>
    <name><given>Wren</given><family>Placeholder</family></name>
    <administrativeGenderCode code="F"/>
    <birthTime value="19900101"/>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
      <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Results</title>
      <entry><observation classCode="OBS" moodCode="EVN">
        <code code="EXDUR1" codeSystem="1.2.3.4.5" displayName="${DURATION}"/>
        <effectiveTime value="20260701"/>
        <value xsi:type="PQ" value="10:30" unit="min:sec"/>
      </observation></entry>
      <entry><observation classCode="OBS" moodCode="EVN">
        <code code="EXDUR2" codeSystem="1.2.3.4.5" displayName="${DURATION}"/>
        <effectiveTime value="20260702"/>
        <value xsi:type="PQ" value="not recorded" unit="min:sec"/>
      </observation></entry>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;
}

async function importOnce() {
  const { login, profile } = seedActor();
  const doc = await ingestMedicalUpload(
    login.id,
    profile.id,
    new File([Buffer.from(ccda())], "stress-test.xml", {
      type: "application/xml",
    })
  );
  return { profile, doc };
}

describe("a CCD's colon-formatted durations become numbers or drop (#2322)", () => {
  it("stores the parsable duration as one number in one unit", async () => {
    const { profile } = await importOnce();
    const rows = db
      .prepare(
        `SELECT date, value, value_num, unit FROM medical_records
          WHERE profile_id = ? AND name = ? ORDER BY date`
      )
      .all(profile.id, DURATION) as {
      date: string;
      value: string | null;
      value_num: number | null;
      unit: string | null;
    }[];
    // ONE row: the second observation never became a reading.
    expect(rows).toEqual([
      { date: "2026-07-01", value: "630", value_num: 630, unit: "s" },
    ]);
  });

  it("reports the refused one as a drop instead of silently losing it", async () => {
    const { profile } = await importOnce();
    const raw = db
      .prepare(
        `SELECT import_report FROM medical_documents
          WHERE profile_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(profile.id) as { import_report: string | null };
    const report = parseImportReport(raw.import_report);
    const drop = report?.drops.find((d) => d.label === DURATION);
    expect(drop?.reason).toBe("unparsable_value");
    // Kept + dropped still add up, so the coverage card stays honest.
    expect(report!.considered).toBeGreaterThan(report!.imported);
  });
});
