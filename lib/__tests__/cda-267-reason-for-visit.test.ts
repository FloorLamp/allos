import { describe, expect, it } from "vitest";
import { extractFromCcda } from "../cda";
import {
  chiefComplaintsFromSections,
  encompassingEncounterInfo,
  selectReasonTarget,
  sectionNarrativeText,
} from "../cda/extractors";
import type { CdaSection } from "../cda/constants";
import type { ImportedEncounter } from "../health-import";

// Coverage for issue #267: a narrative-only Reason for Visit section (LOINC
// 29299-5, zero structured entries) some hospital systems emit was dropped, and
// the exactly-one-encounter correlation rule skipped documents carrying the visit
// plus a companion event-type Encounter Activity. All fixtures are SYNTHETIC —
// obviously-fictional patients/clinicians, invented dates and identifiers.

// Wrap section XML in a minimal ClinicalDocument. `componentOf` is optional so a
// test can attach the document's encompassing visit.
function doc(opts: { sections: string[]; componentOf?: string }): string {
  return `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <effectiveTime value="20260603"/>
  <recordTarget><patientRole><patient>
    <name><given>Test</given><family>Patient</family></name>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    ${opts.sections.map((s) => `<component>${s}</component>`).join("")}
  </structuredBody></component>
  ${opts.componentOf ?? ""}
</ClinicalDocument>`;
}

// A Reason for Visit section that is NARRATIVE ONLY — a free-text <text> blob with
// zero structured <entry> observations (the hospital-document flavor from #267).
const REASON_NARRATIVE_ONLY = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.12"/>
  <code code="29299-5" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Reason for Visit</title>
  <text>Patient presents with worsening shortness of breath and chest tightness over the past three days.</text>
</section>`;

// A Reason for Visit section WITH a structured chief-complaint observation.
const REASON_WITH_ENTRY = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.12"/>
  <code code="29299-5" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Reason for Visit</title>
  <text>Ignore this narrative — the entry wins.</text>
  <entry><observation classCode="OBS" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.19"/>
    <code code="8661-1" codeSystem="2.16.840.1.113883.6.1"/>
    <value xsi:type="CD" code="29857009" codeSystem="2.16.840.1.113883.6.96"
      displayName="Chest pain"/>
  </observation></entry>
</section>`;

// One ambulatory Encounter Activity with the given id extension + date.
function encounter(idExt: string, display: string, date = "20260603"): string {
  return `<entry><encounter classCode="ENC" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
    <id root="1.2.3" extension="${idExt}"/>
    <code code="99284" codeSystem="2.16.840.1.113883.6.12" displayName="${display}">
      <translation code="AMB" codeSystem="2.16.840.1.113883.5.4"/>
    </code>
    <effectiveTime><low value="${date}"/></effectiveTime>
  </encounter></entry>`;
}

// An Encounters section wrapping the given <entry> encounter blocks.
function encountersSection(...entries: string[]): string {
  return `<section>
  <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Encounters</title>
  ${entries.join("")}
</section>`;
}

// componentOf/encompassingEncounter pointing at the given id (+ optional period).
function componentOf(idExt: string, date?: string): string {
  const eff = date
    ? `<effectiveTime><low value="${date}"/></effectiveTime>`
    : "";
  return `<componentOf><encompassingEncounter>
    <id root="1.2.3" extension="${idExt}"/>
    ${eff}
  </encompassingEncounter></componentOf>`;
}

describe("narrative-only Reason for Visit fallback (#267)", () => {
  it("attaches the stripped narrative as the reason when there are no entries", () => {
    const r = extractFromCcda(
      doc({
        sections: [
          encountersSection(encounter("VISIT-1", "ED Visit")),
          REASON_NARRATIVE_ONLY,
        ],
      })
    );
    expect(r.encounters).toHaveLength(1);
    expect(r.encounters![0].reason).toBe(
      "Patient presents with worsening shortness of breath and chest tightness over the past three days."
    );
  });

  it("still prefers the structured chief complaint over the narrative", () => {
    const r = extractFromCcda(
      doc({
        sections: [
          encountersSection(encounter("VISIT-1", "Office Visit")),
          REASON_WITH_ENTRY,
        ],
      })
    );
    expect(r.encounters![0].reason).toBe("Chest pain");
  });

  it("sectionNarrativeText drops bare placeholders and empties", () => {
    expect(sectionNarrativeText({ text: "  Chest pain  " })).toBe("Chest pain");
    expect(sectionNarrativeText({ text: "   " })).toBeNull();
    expect(sectionNarrativeText({ text: "N/A" })).toBeNull();
    expect(sectionNarrativeText({})).toBeNull();
  });

  it("chiefComplaintsFromSections dedups a repeated narrative across sections", () => {
    const section = (): CdaSection => ({
      code: "29299-5",
      templateIds: ["2.16.840.1.113883.10.20.22.2.12"],
      title: "Reason for Visit",
      entries: [],
      raw: { text: "Fever and cough" },
    });
    expect(chiefComplaintsFromSections([section(), section()])).toEqual([
      "Fever and cough",
    ]);
  });
});

describe("multi-encounter Reason for Visit correlation (#267)", () => {
  const visitAndCompanion = encountersSection(
    encounter("VISIT-1", "ED Visit"),
    encounter("EVENT-9", "Admission Event")
  );

  it("attaches the reason to the encompassing visit (matched by id), not the companion", () => {
    const r = extractFromCcda(
      doc({
        sections: [visitAndCompanion, REASON_NARRATIVE_ONLY],
        componentOf: componentOf("VISIT-1"),
      })
    );
    expect(r.encounters).toHaveLength(2);
    const visit = r.encounters!.find(
      (e) => e.external_id === "ccda:encounter:VISIT-1"
    );
    const companion = r.encounters!.find(
      (e) => e.external_id === "ccda:encounter:EVENT-9"
    );
    expect(visit!.reason).toBe(
      "Patient presents with worsening shortness of breath and chest tightness over the past three days."
    );
    expect(companion!.reason).toBeNull();
  });

  it("matches by encompassing period when it carries no id", () => {
    const r = extractFromCcda(
      doc({
        sections: [
          encountersSection(
            encounter("VISIT-1", "ED Visit", "20260603"),
            encounter("EVENT-9", "Admission Event", "20260601")
          ),
          REASON_NARRATIVE_ONLY,
        ],
        componentOf: componentOf("", "20260603"),
      })
    );
    const visit = r.encounters!.find((e) => e.date === "2026-06-03");
    const other = r.encounters!.find((e) => e.date === "2026-06-01");
    expect(visit!.reason).toContain("shortness of breath");
    expect(other!.reason).toBeNull();
  });

  it("skips correlation when several encounters are genuinely ambiguous (no encompassing hint)", () => {
    const r = extractFromCcda(
      doc({ sections: [visitAndCompanion, REASON_NARRATIVE_ONLY] })
    );
    expect(r.encounters).toHaveLength(2);
    expect(r.encounters!.every((e) => e.reason === null)).toBe(true);
  });
});

describe("selectReasonTarget / encompassingEncounterInfo pure logic (#267)", () => {
  const enc = (external_id: string, date: string): ImportedEncounter => ({
    date,
    end_date: null,
    type: null,
    code: null,
    code_system: null,
    class_code: null,
    reason: null,
    diagnoses: [],
    provider: null,
    location: null,
    notes: null,
    external_id,
  });

  it("returns the sole reason-less encounter", () => {
    expect(
      selectReasonTarget([enc("ccda:encounter:A", "2026-06-03")], null)
    ).toBe(0);
  });

  it("returns -1 when the sole encounter already has a reason", () => {
    const e = { ...enc("ccda:encounter:A", "2026-06-03"), reason: "Cough" };
    expect(selectReasonTarget([e], null)).toBe(-1);
  });

  it("prefers the encompassing id among several", () => {
    const list = [
      enc("ccda:encounter:A", "2026-06-03"),
      enc("ccda:encounter:B", "2026-06-03"),
    ];
    expect(
      selectReasonTarget(list, {
        externalId: "ccda:encounter:B",
        start: null,
        end: null,
        activity: null,
      })
    ).toBe(1);
  });

  it("falls back to matching start date when the encompassing carries no id", () => {
    const list = [
      enc("ccda:encounter:A", "2026-06-01"),
      enc("ccda:encounter:B", "2026-06-03"),
    ];
    expect(
      selectReasonTarget(list, {
        externalId: null,
        start: "2026-06-03",
        end: null,
        activity: null,
      })
    ).toBe(1);
  });

  it("returns -1 when several encounters share the encompassing period", () => {
    const list = [
      enc("ccda:encounter:A", "2026-06-03"),
      enc("ccda:encounter:B", "2026-06-03"),
    ];
    expect(
      selectReasonTarget(list, {
        externalId: null,
        start: "2026-06-03",
        end: null,
        activity: null,
      })
    ).toBe(-1);
  });

  it("reads the encompassingEncounter id + period off a parsed document node", () => {
    const cd = {
      componentOf: {
        encompassingEncounter: {
          id: { "@_root": "1.2.3", "@_extension": "VISIT-1" },
          effectiveTime: { low: { "@_value": "20260603" } },
        },
      },
    };
    expect(encompassingEncounterInfo(cd)).toMatchObject({
      externalId: "ccda:encounter:VISIT-1",
      start: "2026-06-03",
      end: null,
      activity: {
        date: "2026-06-03",
        external_id: "ccda:encounter:VISIT-1",
      },
    });
    expect(encompassingEncounterInfo({})).toBeNull();
  });
});
