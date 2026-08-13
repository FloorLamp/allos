// DB INTEGRATION TIER — visit-diagnosis rank dedup (issue #2589). Drives the REAL
// persist path end to end:
//   extractFromCcda → healthRecordToPersistInput → persistDocumentImport
// with a CCD whose encounter nests the SAME diagnosis twice — once plain, once with the
// source's " - Primary" rank qualifier baked into the display name — and asserts the
// stored `encounters.diagnoses` summary holds ONE entry. The pure tier
// (lib/__tests__/visit-diagnoses.test.ts) proves the rule; this proves the writer
// applies it, and that the healing migration applies the very same rule to a summary
// already on disk.
//
// Fictional patient, reserved-style ids, synthetic diagnosis names — no PHI.

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { runMigrations } from "@/lib/migrations/runner";
import { extractFromCcda } from "@/lib/cda";
import { healthRecordToPersistInput } from "@/lib/import-shape";
import { persistDocumentImport } from "@/lib/import-persist";
import { up as dedupeStoredSummaries } from "@/lib/migrations/versions/20260812-visit-diagnosis-rank-dedupe";

// The long Z-code name from the live report: one diagnosis, listed twice, four wrapped
// lines on a phone card.
const CARRIER_DX =
  "Encounter of male for testing for genetic disease carrier status for procreative management";
// A name that legitimately carries a hyphenated clause — the case a general
// trailing-hyphen guess would eat.
const CLAUSE_DX = "Type 2 diabetes mellitus - uncontrolled";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function newDocument(profileId: number, filename: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, ?, '', 'processing', 'ccd')`
      )
      .run(profileId, filename).lastInsertRowid
  );
}

// A Problem Observation, as Epic nests them under an encounter's entryRelationship.
function problemObs(display: string): string {
  return `<entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
      <code code="282291009" codeSystem="2.16.840.1.113883.6.96"/>
      <value xsi:type="CD" code="171121004" codeSystem="2.16.840.1.113883.6.96" displayName="${display}"/>
    </observation></entryRelationship>`;
}

function ccdWithEncounterDiagnoses(displays: string[]): string {
  return `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <effectiveTime value="20260608"/>
  <recordTarget><patientRole><patient>
    <name><given>Robin</given><family>Sample</family></name>
    <administrativeGenderCode code="M"/>
    <birthTime value="19900101"/>
  </patient></patientRole></recordTarget>
  <component><structuredBody><component>
    <section>
      <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Encounters</title>
      <entry><encounter classCode="ENC" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
        <id root="1.2.3" extension="ENC-2589"/>
        <code code="99213" codeSystem="2.16.840.1.113883.6.12" displayName="Office Visit"/>
        <effectiveTime><low value="20260608"/></effectiveTime>
        ${displays.map(problemObs).join("")}
      </encounter></entry>
    </section>
  </component></structuredBody></component>
</ClinicalDocument>`;
}

function importXml(profileId: number, docId: number, xml: string): void {
  const parsed = extractFromCcda(xml);
  const input = healthRecordToPersistInput(parsed, "ccd-test", "CCD");
  persistDocumentImport(profileId, docId, input);
}

function storedSummary(profileId: number): string | null {
  const row = db
    .prepare(
      `SELECT diagnoses FROM encounters WHERE profile_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(profileId) as { diagnoses: string | null } | undefined;
  return row?.diagnoses ?? null;
}

describe("CCD import — encounter diagnoses deduped across the rank qualifier (#2589)", () => {
  it("stores ONE entry when the source repeats a diagnosis with ' - Primary'", () => {
    const profileId = newProfile("Dx Dedupe (test)");
    const docId = newDocument(profileId, "carrier-visit.xml");
    importXml(
      profileId,
      docId,
      ccdWithEncounterDiagnoses([CARRIER_DX, `${CARRIER_DX} - Primary`])
    );
    expect(storedSummary(profileId)).toBe(CARRIER_DX);
  });

  it("keeps distinct diagnoses, orders the primary first, and leaves a hyphenated clause alone", () => {
    const profileId = newProfile("Dx Order (test)");
    const docId = newDocument(profileId, "clinic-visit.xml");
    importXml(
      profileId,
      docId,
      ccdWithEncounterDiagnoses([
        CLAUSE_DX,
        "Essential hypertension - Primary",
        "Essential hypertension",
      ])
    );
    expect(storedSummary(profileId)).toBe(
      `Essential hypertension; ${CLAUSE_DX}`
    );
  });
});

describe("CCD import — a clinical 'Primary'/'Secondary' pair is NOT a duplicate (#2589)", () => {
  it("stores both etiologies when no plain twin evidences a rank", () => {
    // Primary and secondary hyperparathyroidism are different diseases. The suffix here
    // is the diagnosis, not its rank, and the summary carries nothing that says otherwise.
    const profileId = newProfile("Dx Clinical (test)");
    const docId = newDocument(profileId, "endocrine-visit.xml");
    importXml(
      profileId,
      docId,
      ccdWithEncounterDiagnoses([
        "Hyperparathyroidism - Primary",
        "Hyperparathyroidism - Secondary",
      ])
    );
    expect(storedSummary(profileId)).toBe(
      "Hyperparathyroidism - Primary; Hyperparathyroidism - Secondary"
    );
  });

  it("stores a lone qualified diagnosis whole", () => {
    const profileId = newProfile("Dx Lone Clause (test)");
    const docId = newDocument(profileId, "adrenal-visit.xml");
    importXml(
      profileId,
      docId,
      ccdWithEncounterDiagnoses(["Adrenal insufficiency - Secondary"])
    );
    expect(storedSummary(profileId)).toBe("Adrenal insufficiency - Secondary");
  });
});

describe("migration — stored summaries healed with the same rule (#2589)", () => {
  it("rewrites an already-stored duplicate pair and leaves a clean row untouched", () => {
    const profileId = newProfile("Dx Migration (test)");
    const insert = db.prepare(
      `INSERT INTO encounters (profile_id, date, type, diagnoses, source)
       VALUES (?, '2026-05-04', 'Office Visit', ?, 'manual')`
    );
    const dupeId = Number(
      insert.run(profileId, `${CARRIER_DX}; ${CARRIER_DX} - Primary`)
        .lastInsertRowid
    );
    const cleanId = Number(
      insert.run(profileId, `${CLAUSE_DX}; Acute sinusitis`).lastInsertRowid
    );

    dedupeStoredSummaries(db);

    const read = db.prepare(`SELECT diagnoses FROM encounters WHERE id = ?`);
    expect((read.get(dupeId) as { diagnoses: string }).diagnoses).toBe(
      CARRIER_DX
    );
    expect((read.get(cleanId) as { diagnoses: string }).diagnoses).toBe(
      `${CLAUSE_DX}; Acute sinusitis`
    );
  });
});

// Through the REAL runner, on the REAL migrated schema, because that is the thing that
// touches a live install: the pass reads EVERY encounters row, never consults `source`,
// and rewrites in place with no tombstone. A row it must not touch has exactly one
// chance to be left alone. Every row below is one the earlier strip-on-sight rule
// destroyed — the paired etiologies, the lone clause, and an unrelated list whose only
// crime was containing the word.
describe("migration through runMigrations — clinical rows survive untouched (#2589)", () => {
  const UNTOUCHED = [
    "Hyperparathyroidism - Primary; Hyperparathyroidism - Secondary",
    "Amyloidosis - Primary; Amyloidosis - Secondary",
    "Multiple sclerosis - Primary; Multiple sclerosis - Secondary",
    "Adrenal insufficiency - Secondary",
    "C; B; A - Primary; D",
    `${CLAUSE_DX}; Acute sinusitis`,
  ];

  it("is a no-op on every clinical row and still heals the motivating duplicate", () => {
    const mem = new Database(":memory:");
    try {
      // Build the real schema the way a real install does.
      runMigrations(mem);
      const profileId = Number(
        mem.prepare("INSERT INTO profiles (name) VALUES (?)").run("Dx Runner")
          .lastInsertRowid
      );
      const insert = mem.prepare(
        `INSERT INTO encounters (profile_id, date, type, diagnoses, source)
         VALUES (?, '2026-05-04', 'Office Visit', ?, 'ccd')`
      );
      const ids = UNTOUCHED.map((s) =>
        Number(insert.run(profileId, s).lastInsertRowid)
      );
      const dupeId = Number(
        insert.run(profileId, `${CARRIER_DX}; ${CARRIER_DX} - Primary`)
          .lastInsertRowid
      );

      // Forget this one migration in the name-keyed ledger and re-run: the runner
      // re-applies exactly it, against rows that now exist. This is the real apply
      // path, not a direct `up()` call.
      mem
        .prepare(`DELETE FROM schema_migrations WHERE name = ?`)
        .run("20260812-visit-diagnosis-rank-dedupe");
      runMigrations(mem);

      const read = mem.prepare(`SELECT diagnoses FROM encounters WHERE id = ?`);
      ids.forEach((id, i) => {
        expect((read.get(id) as { diagnoses: string }).diagnoses).toBe(
          UNTOUCHED[i]
        );
      });
      expect((read.get(dupeId) as { diagnoses: string }).diagnoses).toBe(
        CARRIER_DX
      );
    } finally {
      mem.close();
    }
  });
});
