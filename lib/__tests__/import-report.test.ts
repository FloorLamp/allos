import { describe, expect, it } from "vitest";
import { parseCcda } from "@/lib/cda";
import { parseFhirBundle } from "@/lib/fhir";
import {
  emptyReport,
  groupDropsByReason,
  summarizeCoverage,
  mergeReports,
  reasonLabel,
  rowDropCount,
  isRowDrop,
  parseImportReport,
  serializeImportReport,
  type ImportDrop,
  type CoverageEntry,
  type ImportReport,
} from "@/lib/import-report";

// The import DEBUGGER: drop-reason classification + coverage.
// These are pure — parseCcda / parseFhirBundle build the report from a fixture, and
// the derivations (grouping, coverage split, merge, (de)serialize) are exercised
// directly.

// ---- pure derivations ----

describe("groupDropsByReason", () => {
  it("groups by reason in the actionable order, dropping empty groups", () => {
    const drops: ImportDrop[] = [
      { kind: "lab", label: "A", reason: "deduped" },
      { kind: "lab", label: "B", reason: "no_value" },
      { kind: "lab", label: "C", reason: "no_value" },
      { kind: "section", label: "Insurance", reason: "unrecognized_section" },
    ];
    const groups = groupDropsByReason(drops);
    expect(groups.map((g) => g.reason)).toEqual([
      "no_value",
      "deduped",
      "unrecognized_section",
    ]);
    expect(groups[0].drops).toHaveLength(2);
    expect(groups[0].label).toBe(reasonLabel("no_value"));
  });
});

describe("summarizeCoverage", () => {
  it("splits consumed vs present-but-not-consumed, deduped by title", () => {
    const coverage: CoverageEntry[] = [
      { key: "results", title: "Results", consumed: true, present: 5 },
      // Same section from a second XDM document: OR consumed, max present.
      { key: "results", title: "Results", consumed: false, present: 3 },
      { key: "ins", title: "Insurance", consumed: false, present: 1 },
      { key: "func", title: "Functional Status", consumed: false, present: 1 },
    ];
    const { consumed, notConsumed } = summarizeCoverage(coverage);
    expect(consumed.map((c) => c.title)).toEqual(["Results"]);
    expect(consumed[0].present).toBe(5);
    // Sorted by title.
    expect(notConsumed.map((c) => c.title)).toEqual([
      "Functional Status",
      "Insurance",
    ]);
  });
});

describe("mergeReports", () => {
  it("concatenates drops/coverage and sums counts; ignores nullish", () => {
    const a: ImportReport = {
      drops: [{ kind: "lab", label: "A", reason: "no_value" }],
      coverage: [
        { key: "results", title: "Results", consumed: true, present: 1 },
      ],
      imported: 2,
      considered: 3,
    };
    const b: ImportReport = {
      drops: [
        { kind: "section", label: "Insurance", reason: "unrecognized_section" },
      ],
      coverage: [
        { key: "ins", title: "Insurance", consumed: false, present: 1 },
      ],
      imported: 1,
      considered: 1,
    };
    const merged = mergeReports([a, undefined, b]);
    expect(merged.drops).toHaveLength(2);
    expect(merged.coverage).toHaveLength(2);
    expect(merged.imported).toBe(3);
    expect(merged.considered).toBe(4);
    expect(mergeReports([])).toEqual(emptyReport());
  });
});

describe("rowDropCount / isRowDrop", () => {
  it("counts candidate-row drops but not unrecognized sections", () => {
    const report: ImportReport = {
      drops: [
        { kind: "lab", label: "A", reason: "no_value" },
        { kind: "section", label: "Insurance", reason: "unrecognized_section" },
      ],
      coverage: [],
      imported: 5,
      considered: 6,
    };
    expect(rowDropCount(report)).toBe(1);
    expect(report.drops.filter(isRowDrop)).toHaveLength(1);
  });
});

describe("serialize / parseImportReport", () => {
  it("round-trips a report and tolerates null / malformed input", () => {
    const report: ImportReport = {
      drops: [{ kind: "lab", label: "A", reason: "no_value" }],
      coverage: [{ key: "r", title: "Results", consumed: true, present: 1 }],
      imported: 1,
      considered: 2,
      unmappedLoincs: [{ loinc: "12345-6", name: "Some Assay", count: 2 }],
    };
    const json = serializeImportReport(report)!;
    expect(parseImportReport(json)).toEqual(report);
    expect(serializeImportReport(null)).toBeNull();
    expect(parseImportReport(null)).toBeNull();
    expect(parseImportReport("")).toBeNull();
    expect(parseImportReport("{not json")).toBeNull();
    // Missing fields default without throwing.
    expect(parseImportReport("{}")).toEqual({
      drops: [],
      coverage: [],
      imported: 0,
      considered: 0,
      unmappedLoincs: [],
    });
  });
});

// ---- CCD end-to-end: the parser populates the report ----

// A Results section with a real lab (kept), a null-flavored "Comment(s)" row (the
// Epic service-comment noise → null_flavor), and a value-less "Result" row
// (no_value); a Problems section stating "No known problems" (negated); and an
// Insurance section no extractor consumes (unrecognized_section).
const CCD = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <recordTarget><patientRole><patient>
    <name><given>Jamie</given><family>Rivera</family></name>
    <administrativeGenderCode code="F"/>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
      <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Results</title>
      <entry><organizer classCode="BATTERY" moodCode="EVN">
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="2093-3" codeSystem="2.16.840.1.113883.6.1" displayName="Cholesterol"/>
          <effectiveTime value="20230101"/>
          <value xsi:type="PQ" value="180" unit="mg/dL"/>
        </observation></component>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="8251-1" codeSystem="2.16.840.1.113883.6.1" displayName="Comment(s)"/>
          <effectiveTime value="20230101"/>
          <value xsi:type="ST" nullFlavor="NA"/>
        </observation></component>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="99999-9" codeSystem="2.16.840.1.113883.6.1"/>
          <effectiveTime value="20230101"/>
          <value xsi:type="ST"/>
        </observation></component>
      </organizer></entry>
    </section></component>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
      <code code="11450-4" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Problems</title>
      <entry><act classCode="ACT" moodCode="EVN">
        <statusCode code="active"/>
        <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
          <value xsi:type="CD" displayName="No known problems"/>
        </observation></entryRelationship>
      </act></entry>
    </section></component>
    <component><section>
      <code code="48768-6" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Insurance</title>
      <entry><observation/></entry>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;

describe("parseCcda → import report", () => {
  const parsed = parseCcda(CCD);
  const report = parsed.report!;

  it("attaches a report with kept-vs-considered counts", () => {
    expect(report).toBeDefined();
    // Only the Cholesterol lab imports.
    expect(parsed.records.map((r) => r.name)).toEqual(["Cholesterol"]);
    // Exact, independently-derived counts (NOT `imported + rowDropCount`, which is
    // how `considered` is defined and so can never fail): one kept lab, exactly
    // three row drops — Comment(s) (null_flavor), value-less Result (no_value), and
    // the No-known-problems negation — so considered is 4.
    expect(report.imported).toBe(1);
    expect(rowDropCount(report)).toBe(3);
    expect(report.considered).toBe(4);
    const byReason = report.drops.reduce<Record<string, number>>((m, d) => {
      m[d.reason] = (m[d.reason] ?? 0) + 1;
      return m;
    }, {});
    expect(byReason.null_flavor).toBe(1);
    expect(byReason.no_value).toBe(1);
    expect(byReason.negated).toBe(1);
    expect(byReason.unrecognized_section).toBe(1); // Insurance
  });

  it("captures the null-flavored Comment(s) row as null_flavor", () => {
    const nf = report.drops.filter((d) => d.reason === "null_flavor");
    expect(nf).toHaveLength(1);
    expect(nf[0].label).toBe("Comment(s)");
    expect(nf[0].kind).toBe("lab");
  });

  it("captures the value-less lab as no_value", () => {
    expect(report.drops.some((d) => d.reason === "no_value")).toBe(true);
  });

  it("captures the No-known-problems negation", () => {
    expect(
      report.drops.some((d) => d.kind === "condition" && d.reason === "negated")
    ).toBe(true);
  });

  it("lists Insurance as present-but-not-consumed", () => {
    const { consumed, notConsumed } = summarizeCoverage(report.coverage);
    expect(consumed.map((c) => c.title)).toContain("Results");
    expect(notConsumed.map((c) => c.title)).toContain("Insurance");
    // The unconsumed section is also an unrecognized_section drop.
    expect(
      report.drops.some(
        (d) => d.reason === "unrecognized_section" && d.label === "Insurance"
      )
    ).toBe(true);
  });
});

// ---- FHIR end-to-end ----

const BUNDLE = JSON.stringify({
  resourceType: "Bundle",
  entry: [
    {
      resource: {
        resourceType: "Observation",
        status: "final",
        code: { text: "Glucose" },
        effectiveDateTime: "2023-01-01",
        valueQuantity: { value: 95, unit: "mg/dL" },
      },
    },
    {
      // Retracted reading → negated drop.
      resource: {
        resourceType: "Observation",
        status: "entered-in-error",
        code: { text: "Bad Reading" },
        effectiveDateTime: "2023-01-01",
        valueQuantity: { value: 1, unit: "x" },
      },
    },
    {
      // No mapper → unrecognized resource type in coverage + a resource drop.
      // (Procedure + FamilyMemberHistory now HAVE mappers, so DocumentReference
      // stands in as the genuinely-unconsumed support type.)
      resource: { resourceType: "DocumentReference", status: "current" },
    },
  ],
});

describe("parseFhirBundle → import report", () => {
  const parsed = parseFhirBundle(BUNDLE);
  const report = parsed.report!;

  it("keeps the good observation and drops the retracted one as negated", () => {
    expect(parsed.records.map((r) => r.name)).toEqual(["Glucose"]);
    expect(
      report.drops.some(
        (d) => d.reason === "negated" && d.label === "Bad Reading"
      )
    ).toBe(true);
  });

  it("marks an unmapped support type as present-but-not-consumed", () => {
    const { consumed, notConsumed } = summarizeCoverage(report.coverage);
    expect(consumed.map((c) => c.title)).toContain("Observation");
    expect(notConsumed.map((c) => c.title)).toContain("DocumentReference");
  });

  // Fidelity invariant (b): no candidate is both imported AND reported as a genuine
  // (non-duplicate) drop. Kept reading names must never appear as a non-deduped
  // drop label — if the instrumentation double-counted a kept row as dropped, this
  // fails.
  it("never reports a kept reading as a genuine drop", () => {
    const keptNames = new Set(parsed.records.map((r) => r.name));
    const genuineDropLabels = report.drops
      .filter((d) => d.reason !== "deduped")
      .map((d) => d.label);
    for (const label of genuineDropLabels) {
      expect(keptNames.has(label)).toBe(false);
    }
  });
});

// F1: reference-consumed support resources — a MedicationRequest's Medication and
// the performer Practitioner/Organization — are top-level entries with no mapper of
// their own, yet ARE consumed (by reference). They must read CONSUMED, not "present
// but not consumed", and must NOT emit unrecognized_section drops.
const REFERENCE_BUNDLE = JSON.stringify({
  resourceType: "Bundle",
  entry: [
    {
      fullUrl: "urn:med1",
      resource: {
        resourceType: "Medication",
        id: "med1",
        code: { text: "Lisinopril 10 mg" },
      },
    },
    {
      resource: {
        resourceType: "MedicationRequest",
        status: "active",
        medicationReference: { reference: "Medication/med1" },
        authoredOn: "2023-02-02",
        dosageInstruction: [{ text: "1 tab daily" }],
      },
    },
    {
      resource: {
        resourceType: "Practitioner",
        id: "p1",
        name: [{ text: "Dr. Ada Vance" }],
      },
    },
    {
      resource: {
        resourceType: "Organization",
        id: "o1",
        name: "Sample Clinic",
      },
    },
    // A genuinely-unconsumed support type — stays not-consumed.
    { resource: { resourceType: "DocumentReference", status: "current" } },
  ],
});

describe("parseFhirBundle → reference-consumed coverage (F1)", () => {
  const report = parseFhirBundle(REFERENCE_BUNDLE).report!;
  const { consumed, notConsumed } = summarizeCoverage(report.coverage);

  it("treats Medication / Practitioner / Organization as consumed", () => {
    const consumedTitles = consumed.map((c) => c.title);
    expect(consumedTitles).toEqual(
      expect.arrayContaining([
        "Medication",
        "MedicationRequest",
        "Practitioner",
        "Organization",
      ])
    );
    expect(notConsumed.map((c) => c.title)).not.toContain("Medication");
  });

  it("emits no unrecognized_section drop for reference-consumed types", () => {
    const unrecognized = report.drops
      .filter((d) => d.reason === "unrecognized_section")
      .map((d) => d.label);
    expect(unrecognized).not.toContain("Medication");
    expect(unrecognized).not.toContain("Practitioner");
    expect(unrecognized).not.toContain("Organization");
    // But the genuinely-unconsumed DocumentReference IS still flagged.
    expect(notConsumed.map((c) => c.title)).toContain("DocumentReference");
    expect(unrecognized).toContain("DocumentReference");
  });
});

// Dedupe fidelity (c): two byte-identical Observations share an external_id, so one
// is kept and the other becomes exactly one `deduped` drop — the kept row is present
// once and accounted for once.
const DUP_BUNDLE = JSON.stringify({
  resourceType: "Bundle",
  entry: [1, 2].map(() => ({
    resource: {
      resourceType: "Observation",
      status: "final",
      code: { text: "Heart rate" },
      effectiveDateTime: "2023-01-01",
      valueQuantity: { value: 72, unit: "bpm" },
    },
  })),
});

describe("parseFhirBundle → dedupe fidelity (c)", () => {
  const parsed = parseFhirBundle(DUP_BUNDLE);
  const report = parsed.report!;

  it("keeps one copy and records exactly one deduped drop", () => {
    expect(parsed.records).toHaveLength(1);
    const deduped = report.drops.filter((d) => d.reason === "deduped");
    expect(deduped).toHaveLength(1);
    expect(deduped[0].label).toBe("Heart rate");
    expect(report.imported).toBe(1);
    expect(rowDropCount(report)).toBe(1);
  });
});

// F2: a CCD carrying a Reason-for-Visit section but NO encounter to correlate it
// onto — the chief complaint is genuinely NOT consumed, so the section reads
// not-consumed (and becomes an unrecognized_section drop).
const REASON_NO_ENCOUNTER_CCD = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <component><structuredBody>
    <component><section>
      <code code="29299-5" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Reason for Visit</title>
      <entry><observation classCode="OBS" moodCode="EVN">
        <value xsi:type="CD" displayName="Cough"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>
      </observation></entry>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;

describe("parseCcda → Reason for Visit consumption (F2)", () => {
  it("reads Reason for Visit as NOT consumed when there's no encounter", () => {
    const report = parseCcda(REASON_NO_ENCOUNTER_CCD).report!;
    const { consumed, notConsumed } = summarizeCoverage(report.coverage);
    expect(consumed.map((c) => c.title)).not.toContain("Reason for Visit");
    expect(notConsumed.map((c) => c.title)).toContain("Reason for Visit");
  });
});

// Fix 3: a CCD lab whose LOINC has no canonical mapping still imports (under its
// printed name) AND is listed in report.unmappedLoincs — while a mapped lab in the
// same document is NOT listed.
const UNMAPPED_LOINC_CCD = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <component><structuredBody>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
      <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Results</title>
      <entry><organizer classCode="BATTERY" moodCode="EVN">
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="2093-3" codeSystem="2.16.840.1.113883.6.1" displayName="Cholesterol"/>
          <effectiveTime value="20230101"/>
          <value xsi:type="PQ" value="180" unit="mg/dL"/>
        </observation></component>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="55555-5" codeSystem="2.16.840.1.113883.6.1" displayName="Novel Marker"/>
          <effectiveTime value="20230101"/>
          <value xsi:type="PQ" value="7" unit="ng/mL"/>
        </observation></component>
      </organizer></entry>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;

describe("parseCcda → unmapped lab LOINC surfacing (Fix 3)", () => {
  const parsed = parseCcda(UNMAPPED_LOINC_CCD);
  const report = parsed.report!;

  it("imports both labs", () => {
    expect(parsed.records.map((r) => r.name).sort()).toEqual([
      "Cholesterol",
      "Novel Marker",
    ]);
  });

  it("lists only the unmapped LOINC, not the canonicalized one", () => {
    expect(report.unmappedLoincs).toEqual([
      { loinc: "55555-5", name: "Novel Marker", count: 1 },
    ]);
    // The unmapped lab is imported, not dropped.
    expect(report.drops.some((d) => d.label === "Novel Marker")).toBe(false);
  });
});
