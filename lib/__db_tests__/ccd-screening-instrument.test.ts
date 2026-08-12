// DB INTEGRATION TIER — a screening instrument in a CCD imports as a SCORE through the
// existing instrument substrate (#2321), end to end through a real import
// (ingestMedicalUpload → the C-CDA parser → import-persist).
//
// Before this, the ten question texts each became a bandless pseudo-biomarker: an
// ai-coined canonical name, a series, a permanent slot under Data → Coverage. #2318
// stopped the identity half; this proves the other half — the screening is
// UNDERSTOOD, as one banded score row plus per-item `instrument_responses`, and no
// question text coins a name.
//
// Two refusals are asserted here too, because both are safety decisions rather than
// parser fussiness: a screening the document attributes to somebody else, and a
// half-answered one. Neither may produce a score, and neither may be silent.
//
// SYNTHETIC ONLY: invented patients, fictional dates, published public-domain item
// wording. No PHI.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ingestMedicalUpload } from "@/lib/medical-pipeline";
import { seedActor } from "@/lib/__action_tests__/harness";
import { parseImportReport } from "@/lib/import-report";
import {
  getInstrumentStates,
  getInstrumentResponses,
} from "@/lib/instrument-records";
import { getUsedCanonicalNames } from "@/lib/queries/medical";
import { instrumentDef, instrumentItemOptions } from "@/lib/mental-health";

const EPDS = instrumentDef("EPDS");

// The answer that scores `value` on item `i`, taken from the instrument's own printed
// options — so the fixture states the ANSWER a document prints, never the number.
function answerScoring(i: number, value: number): string {
  return instrumentItemOptions("EPDS", i).find((o) => o.value === value)!.label;
}

// One observation per question, exactly as an EHR files a screening: the question text
// as the printed name, the chosen answer as a free-text value, no number, no unit, no
// reference range.
function itemEntries(scores: (number | null)[]): string {
  return EPDS.items
    .map((item, i) => {
      const v = scores[i];
      if (v == null) return "";
      return `      <entry><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.86"/>
        <code code="EPDSITEM${i + 1}" codeSystem="1.2.3.4.5" displayName="${item}"/>
        <effectiveTime value="20260304"/>
        <value xsi:type="ST">${answerScoring(i, v)}</value>
      </observation></entry>`;
    })
    .join("\n");
}

// `subject` is the literal <subject> block the section's entries carry, if any.
function ccda(scores: (number | null)[], subject: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <id root="1.2.3.4" extension="20260304001"/>
  <effectiveTime value="20260304"/>
  <recordTarget><patientRole><patient>
    <name><given>Wren</given><family>Placeholder</family></name>
    <administrativeGenderCode code="F"/>
    <birthTime value="19950101"/>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.14"/>
      <code code="47420-5" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Functional Status</title>
      ${subject}
${itemEntries(scores)}
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;
}

const OWN_PATIENT = `<subject><relatedSubject classCode="PAT"/></subject>`;
const THE_MOTHER = `<subject><relatedSubject classCode="PRS"><code code="MTH" displayName="Mother"/></relatedSubject></subject>`;

async function importOnce(scores: (number | null)[], subject: string) {
  const { login, profile } = seedActor();
  await ingestMedicalUpload(
    login.id,
    profile.id,
    new File([Buffer.from(ccda(scores, subject))], "screening.xml", {
      type: "application/xml",
    })
  );
  return profile;
}

function storedReport(profileId: number) {
  const raw = db
    .prepare(
      `SELECT import_report FROM medical_documents
        WHERE profile_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(profileId) as { import_report: string | null };
  return parseImportReport(raw.import_report);
}

// A screening whose total is 9 — below the 10 and 13 cut-offs, in the minimal band —
// but whose self-harm item (item 10) is positive. The item, not the total, escalates.
const NON_SEVERE_WITH_SELF_HARM = [1, 1, 1, 1, 1, 1, 1, 1, 0, 1];

describe("a CCD screening instrument imports as a score (#2321)", () => {
  it("stores ONE banded score row, not ten pseudo-analytes", async () => {
    const profile = await importOnce(
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      OWN_PATIENT
    );
    const rows = db
      .prepare(
        `SELECT category, canonical_name AS canon, value_num FROM medical_records
          WHERE profile_id = ?`
      )
      .all(profile.id) as {
      category: string;
      canon: string;
      value_num: number | null;
    }[];
    expect(rows).toEqual([
      { category: "instrument", canon: "EPDS", value_num: 0 },
    ]);
  });

  it("no question text becomes a canonical name", async () => {
    const profile = await importOnce(
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      OWN_PATIENT
    );
    const names = getUsedCanonicalNames(profile.id);
    expect(names).not.toContain(EPDS.items[0]);
    expect(names.some((n) => n.startsWith("I have "))).toBe(false);
  });

  it("keeps the per-item answers in instrument_responses, banded and escalating", async () => {
    const profile = await importOnce(NON_SEVERE_WITH_SELF_HARM, OWN_PATIENT);
    const state = getInstrumentStates(profile.id).find(
      (s) => s.instrument === "EPDS"
    )!;
    expect(state.latest?.total).toBe(9);
    // Well below the severe band — so if this escalates, the ITEM did it.
    expect(state.latest?.band.label).toBe("Minimal");
    expect(state.crisis).toMatchObject({
      escalate: true,
      severe: false,
      selfHarm: true,
    });
    const answers = getInstrumentResponses(profile.id, state.latest!.id);
    expect(Object.keys(answers)).toHaveLength(10);
    expect(answers[EPDS.selfHarmItemIndex!]).toBe(1);
  });

  it("refuses a screening the document attributes to another subject, and says so", async () => {
    const profile = await importOnce(
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      THE_MOTHER
    );
    const scores = db
      .prepare(
        "SELECT COUNT(*) AS n FROM medical_records WHERE profile_id = ? AND category = 'instrument'"
      )
      .get(profile.id) as { n: number };
    expect(scores.n).toBe(0);
    // Nothing is lost: the answers are still on the document as assessments.
    const kept = db
      .prepare(
        "SELECT COUNT(*) AS n FROM medical_records WHERE profile_id = ? AND category = 'assessment'"
      )
      .get(profile.id) as { n: number };
    expect(kept.n).toBe(10);
    const report = storedReport(profile.id)!;
    expect(report.drops).toContainEqual(
      expect.objectContaining({ label: "EPDS", reason: "other_subject" })
    );
  });

  it("refuses a partly answered screening under its own reason", async () => {
    const profile = await importOnce(
      [0, 0, 0, 0, 0, 0, 0, 0, 0, null],
      OWN_PATIENT
    );
    const scores = db
      .prepare(
        "SELECT COUNT(*) AS n FROM medical_records WHERE profile_id = ? AND category = 'instrument'"
      )
      .get(profile.id) as { n: number };
    expect(scores.n).toBe(0);
    expect(storedReport(profile.id)!.drops).toContainEqual(
      expect.objectContaining({
        label: "EPDS",
        reason: "incomplete_instrument",
      })
    );
  });
});
