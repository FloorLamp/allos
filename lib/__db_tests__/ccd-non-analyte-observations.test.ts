// DB INTEGRATION TIER — the #2318 acceptance criterion, end to end through a REAL
// import (ingestMedicalUpload → the C-CDA parser → import-persist), not through the
// mapper in isolation:
//
//   "After import of a CCD carrying a temperature with a site qualifier, an
//    immunization with lot/expiry, and a questionnaire: none of those appear in
//    canonical_biomarkers, none appear as a Coverage candidate, and none renders as a
//    biomarker series. A genuinely scored, numeric observation still imports as a
//    reading."
//
// The fixture is one document carrying all four shapes at once, because the defect
// was that they arrive TOGETHER and every one of them acquired an analyte identity on
// the way in. The second describe pins the sync contract on the same document: a
// reprocess of it is idempotent — same rows, same counts, no fresh vocabulary.
//
// SYNTHETIC ONLY: invented patient, deep-past-or-fictional dates, an obviously fake
// short lot string, low-entropy values. No PHI.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  ingestMedicalUpload,
  reprocessDocumentById,
} from "@/lib/medical-pipeline";
import { seedActor } from "@/lib/__action_tests__/harness";
import {
  getBiomarkerSeries,
  getCanonicalVocabulary,
  getUsedCanonicalNames,
} from "@/lib/queries";
import { getCoverageGapCandidates } from "@/lib/queries/coverage";
import { countImportedDocumentRows } from "@/lib/import-persist";

// The names the defect turned into analytes.
const SITE = "Temperature site";
const ITEM = "Feeling down, depressed, or hopeless";
const LOT = "Lot Number";
const EXPIRY = "Expiration Date";
const NON_ANALYTES = [SITE, ITEM, LOT, EXPIRY];
// The measurement that must still import as a reading.
const SCORED = "Depression screen total score";
// …which the LOINC map already canonicalizes: the reading joins the real PHQ-9
// series rather than coining a name of its own. That IS the contrast this file
// draws — a measurement gets an identity, a question text does not.
const SCORED_CANONICAL = "PHQ-9";

// One document, four shapes:
//   • Vitals — a body temperature (a real reading) whose measurement SITE arrives as
//     its own observation in the Functional Status section;
//   • Immunizations — a vaccine whose LOT NUMBER and EXPIRATION DATE are ALSO filed
//     as free-standing Results observations, which is how they became "analytes";
//   • Results — an assessment-scale instrument with a scored numeric TOTAL and one
//     answered ITEM carrying a real survey LOINC and a free-text answer.
function ccda(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <id root="1.2.3.4" extension="20260601001"/>
  <effectiveTime value="20260601"/>
  <recordTarget><patientRole><patient>
    <name><given>Wren</given><family>Placeholder</family></name>
    <administrativeGenderCode code="F"/>
    <birthTime value="19900101"/>
  </patient></patientRole></recordTarget>
  <component><structuredBody>

    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.4.1"/>
      <code code="8716-3" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Vital Signs</title>
      <entry><organizer classCode="CLUSTER" moodCode="EVN">
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="8310-5" codeSystem="2.16.840.1.113883.6.1" displayName="Body temperature"/>
          <effectiveTime value="20260601"/>
          <value xsi:type="PQ" value="98.4" unit="[degF]"/>
        </observation></component>
      </organizer></entry>
    </section></component>

    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.14"/>
      <code code="47420-5" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Functional Status</title>
      <entry><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.67"/>
        <code code="54522-8" codeSystem="2.16.840.1.113883.6.1" displayName="${SITE}"/>
        <effectiveTime value="20260601"/>
        <value xsi:type="CD" code="123851003" codeSystem="2.16.840.1.113883.6.96" displayName="Oral"/>
      </observation></entry>
    </section></component>

    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.2.1"/>
      <code code="11369-6" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Immunizations</title>
      <entry><substanceAdministration classCode="SBADM" moodCode="EVN">
        <effectiveTime value="20260601"/>
        <consumable><manufacturedProduct><manufacturedMaterial>
          <code code="140" codeSystem="2.16.840.1.113883.12.292" displayName="Influenza, seasonal, injectable"/>
          <lotNumberText>FAKE-01</lotNumberText>
        </manufacturedMaterial></manufacturedProduct></consumable>
      </substanceAdministration></entry>
    </section></component>

    <component><section>
      <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Results</title>
      <entry><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.69"/>
        <code code="44261-6" codeSystem="2.16.840.1.113883.6.1" displayName="${SCORED}"/>
        <effectiveTime value="20260601"/>
        <value xsi:type="PQ" value="4" unit="{score}"/>
      </observation></entry>
      <entry><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.86"/>
        <code code="44255-8" codeSystem="2.16.840.1.113883.6.1" displayName="${ITEM}"/>
        <effectiveTime value="20260601"/>
        <value xsi:type="ST">Not at all</value>
      </observation></entry>
      <entry><observation classCode="OBS" moodCode="EVN">
        <code code="LOT" codeSystem="1.2.3.4.5" displayName="${LOT}"/>
        <effectiveTime value="20260601"/>
        <value xsi:type="ST">FAKE-01</value>
      </observation></entry>
      <entry><observation classCode="OBS" moodCode="EVN">
        <code code="EXP" codeSystem="1.2.3.4.5" displayName="${EXPIRY}"/>
        <effectiveTime value="20260601"/>
        <value xsi:type="ST">2027-01-31</value>
      </observation></entry>
    </section></component>

  </structuredBody></component>
</ClinicalDocument>`;
}

function upload(name: string): File {
  return new File([Buffer.from(ccda())], name, { type: "application/xml" });
}

interface StoredRow {
  category: string;
  name: string;
  value: string | null;
  value_num: number | null;
  external_id: string | null;
}

function records(profileId: number): StoredRow[] {
  return db
    .prepare(
      `SELECT category, name, value, value_num, external_id FROM medical_records
        WHERE profile_id = ? ORDER BY category, name`
    )
    .all(profileId) as StoredRow[];
}

async function importOnce(filename = "summary.xml") {
  const { login, profile } = seedActor();
  await ingestMedicalUpload(login.id, profile.id, upload(filename));
  return { login, profile };
}

describe("a CCD's non-analyte observations earn no biomarker identity (#2318)", () => {
  it("stores no record at all for a vaccine lot number or expiry", async () => {
    const { profile } = await importOnce();
    const names = records(profile.id).map((r) => r.name);
    expect(names).not.toContain(LOT);
    expect(names).not.toContain(EXPIRY);
    // …and the vaccine itself imported, carrying the lot where it belongs: on the
    // immunization entry, which is why the observation rows were redundant.
    expect(
      db
        .prepare(
          "SELECT vaccine, notes FROM immunizations WHERE profile_id = ? ORDER BY vaccine"
        )
        .all(profile.id)
    ).toEqual([{ vaccine: "influenza", notes: "Lot FAKE-01" }]);
  });

  it("files the site qualifier and the questionnaire item as `assessment`", async () => {
    const { profile } = await importOnce();
    const byName = new Map(records(profile.id).map((r) => [r.name, r]));
    expect(byName.get(SITE)?.category).toBe("assessment");
    expect(byName.get(SITE)?.value).toBe("Oral");
    expect(byName.get(ITEM)?.category).toBe("assessment");
    expect(byName.get(ITEM)?.value).toBe("Not at all");
  });

  it("registers none of them in the canonical vocabulary", async () => {
    const { profile } = await importOnce();
    const vocab = getCanonicalVocabulary();
    for (const name of NON_ANALYTES) expect(vocab, name).not.toContain(name);
    // Nothing about the profile's own used-name list either — the one read that
    // makes a stored name an ANALYTE.
    const used = getUsedCanonicalNames(profile.id);
    for (const name of NON_ANALYTES) expect(used, name).not.toContain(name);
  });

  it("offers none of them as a Coverage candidate", async () => {
    const { profile } = await importOnce();
    const candidates = getCoverageGapCandidates(profile.id).map((c) => c.label);
    for (const name of NON_ANALYTES) {
      expect(candidates, name).not.toContain(name);
    }
  });

  it("renders none of them as a biomarker series", async () => {
    const { profile } = await importOnce();
    for (const name of NON_ANALYTES) {
      expect(getBiomarkerSeries(profile.id, name), name).toEqual([]);
    }
  });

  it("still imports the genuinely scored observation as a reading", async () => {
    const { profile } = await importOnce();
    const byName = new Map(records(profile.id).map((r) => [r.name, r]));
    const scored = byName.get(SCORED);
    expect(scored?.category).toBe("lab");
    expect(scored?.value_num).toBe(4);
    // It IS an analyte: catalogued, charted, and offered for coverage like any other.
    expect(getUsedCanonicalNames(profile.id)).toContain(SCORED_CANONICAL);
    expect(getBiomarkerSeries(profile.id, SCORED_CANONICAL)).toHaveLength(1);
    // …and so is the real vital beside it.
    expect(byName.get("Body temperature")?.category).toBe("vitals");
  });
});

describe("re-importing the same CCD is idempotent (#2318)", () => {
  it("a reprocess reproduces the same rows, the same counts, and no new vocabulary", async () => {
    const { login, profile } = await importOnce();
    const doc = db
      .prepare(
        "SELECT id, extracted_count FROM medical_documents WHERE profile_id = ?"
      )
      .get(profile.id) as { id: number; extracted_count: number };

    const before = records(profile.id);
    const vocabBefore = getCanonicalVocabulary();
    const footprintBefore = countImportedDocumentRows(profile.id, doc.id);

    reprocessDocumentById(login.id, profile.id, doc.id);

    // Same logical rows — the assessment rows dedupe onto their prior external_id
    // rather than duplicating, exactly like the labs beside them.
    expect(records(profile.id)).toEqual(before);
    expect(countImportedDocumentRows(profile.id, doc.id)).toEqual(
      footprintBefore
    );
    expect(
      db
        .prepare("SELECT extracted_count FROM medical_documents WHERE id = ?")
        .get(doc.id)
    ).toMatchObject({ extracted_count: doc.extracted_count });
    // No fresh ai-coined name appeared on the second pass either.
    expect(getCanonicalVocabulary()).toEqual(vocabBefore);
  });

  it("counts the assessment rows in the document's own footprint", async () => {
    const { profile } = await importOnce();
    const doc = db
      .prepare("SELECT id FROM medical_documents WHERE profile_id = ?")
      .get(profile.id) as { id: number };

    // `assessment` is a medical_records category, and medical_records is one
    // IMPORT_FOOTPRINT_TABLES entry with no category filter — so the extracted-count
    // tally, the reprocess/delete clear-set and the reassign move all reach these
    // rows automatically. This pins that: the tally counts every stored record.
    expect(countImportedDocumentRows(profile.id, doc.id)).toBe(
      records(profile.id).length +
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM immunizations WHERE profile_id = ?"
            )
            .get(profile.id) as { n: number }
        ).n
    );
  });
});
