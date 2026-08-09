import { describe, expect, it } from "vitest";
import { mergeImportResults, parseCcda } from "@/lib/cda";
import { parseFhirBundle } from "@/lib/fhir";
import {
  emptyReport,
  groupDropsByReason,
  collapseDrops,
  summarizeCoverage,
  mergeReports,
  reasonLabel,
  rowDropCount,
  isRowDrop,
  keptRowCount,
  withFootprintCounts,
  reconcileStoredReportCounts,
  parseImportReport,
  serializeImportReport,
  tallyUnmappedLoincs,
  tallyUnresolvedNames,
  unmappedCodeIssueUrl,
  unresolvedNameIssueUrl,
  splitDeclaredNames,
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

// #270: hundreds of near-identical drops (the real-world CCD case that made the
// page unusable) must collapse to a handful of ×N rows.
describe("collapseDrops", () => {
  it("collapses a hundreds-of-duplicates group into one ×N row per (label, section)", () => {
    const drops: ImportDrop[] = [];
    // 300 identical "Comment(s)" rows from Results — the Epic per-panel noise.
    for (let i = 0; i < 300; i++)
      drops.push({
        kind: "lab",
        label: "Comment(s)",
        reason: "null_flavor",
        section: "Results",
      });
    // 150 identical rows of the same label from a DIFFERENT section — must stay
    // a separate row (the source path distinguishes them).
    for (let i = 0; i < 150; i++)
      drops.push({
        kind: "vitals",
        label: "Comment(s)",
        reason: "null_flavor",
        section: "Vital Signs",
      });
    // One singleton.
    drops.push({
      kind: "lab",
      label: "Rare Analyte",
      reason: "null_flavor",
      section: "Results",
    });
    const collapsed = collapseDrops(drops);
    expect(collapsed).toEqual([
      { kind: "lab", label: "Comment(s)", section: "Results", count: 300 },
      {
        kind: "vitals",
        label: "Comment(s)",
        section: "Vital Signs",
        count: 150,
      },
      { kind: "lab", label: "Rare Analyte", section: "Results", count: 1 },
    ]);
    // Counts sum back to the raw total, so the group-header badge stays truthful.
    expect(collapsed.reduce((n, d) => n + d.count, 0)).toBe(drops.length);
  });

  it("preserves first-seen order and treats a missing section as its own bucket", () => {
    const drops: ImportDrop[] = [
      { kind: "lab", label: "B", reason: "deduped" },
      { kind: "lab", label: "A", reason: "deduped", section: "Results" },
      { kind: "lab", label: "B", reason: "deduped" },
      { kind: "lab", label: "A", reason: "deduped" },
    ];
    expect(collapseDrops(drops)).toEqual([
      { kind: "lab", label: "B", section: undefined, count: 2 },
      { kind: "lab", label: "A", section: "Results", count: 1 },
      { kind: "lab", label: "A", section: undefined, count: 1 },
    ]);
  });
});

// #270: the "Report unmapped code" prefill. The PHI guard is the point of these
// tests — the URL must carry the code/name/unit catalog identity and NOTHING else.
describe("unmappedCodeIssueUrl", () => {
  it("builds a prefilled new-issue URL containing exactly code, name, and unit", () => {
    const url = unmappedCodeIssueUrl({
      loinc: "55555-5",
      name: "Novel Marker",
      unit: "ng/mL",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://github.com/FloorLamp/allos/issues/new"
    );
    // Exactly the two prefill params — nothing else rides along.
    expect([...parsed.searchParams.keys()].sort()).toEqual(["body", "title"]);
    expect(parsed.searchParams.get("title")).toBe(
      "Unmapped LOINC 55555-5: Novel Marker"
    );
    // Pin the FULL body so no field can sneak in unnoticed: only the code, the
    // display name, and the unit appear — never values/dates/ranges/patient or
    // provider strings.
    expect(parsed.searchParams.get("body")).toBe(
      [
        "A health-record import surfaced a lab code with no canonical mapping, so its readings don't group with a canonical biomarker or pick up its reference band.",
        "",
        "- LOINC: `55555-5`",
        "- Display name: Novel Marker",
        "- Unit: `ng/mL`",
        "",
        "Please consider adding this code to the canonical biomarker map (`scripts/gen-canonical-biomarkers.ts` / `lib/biomarker-loinc.ts`).",
      ].join("\n")
    );
  });

  it("tolerates a missing unit (older stored reports) without leaking anything", () => {
    const url = unmappedCodeIssueUrl({ loinc: "12345-6", name: "Some Assay" });
    const body = new URL(url).searchParams.get("body")!;
    expect(body).toContain("- LOINC: `12345-6`");
    expect(body).toContain("- Display name: Some Assay");
    expect(body).toContain("- Unit: (none carried)");
  });
});

// #918 §4: the AI path's parallel — unresolved canonical names. Same PHI guard as
// the unmapped-code prefill: name + unit catalog identity, and nothing else.
describe("unresolvedNameIssueUrl", () => {
  it("builds a prefilled new-issue URL containing exactly name and unit", () => {
    const url = unresolvedNameIssueUrl({ name: "Urobilinogen", unit: "mg/dL" });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://github.com/FloorLamp/allos/issues/new"
    );
    expect([...parsed.searchParams.keys()].sort()).toEqual(["body", "title"]);
    expect(parsed.searchParams.get("title")).toBe(
      "Unresolved analyte: Urobilinogen"
    );
    // Pin the FULL body: only the name and unit — never values/dates/ranges/patient.
    expect(parsed.searchParams.get("body")).toBe(
      [
        "An AI-extracted health record surfaced a lab analyte whose name matched no canonical biomarker, so its readings don't group with a canonical biomarker or pick up its reference band. (The AI path has no LOINC to fall back on — identity is the name alone.)",
        "",
        "- Analyte name: Urobilinogen",
        "- Unit: `mg/dL`",
        "",
        "Please consider adding an alias (`lib/canonical-name.ts` `CANONICAL_ALIASES`) if this is a known analyte named differently, or curating a new entry (`lib/curated-biomarkers.ts`) if it isn't modeled yet.",
      ].join("\n")
    );
  });

  it("tolerates a missing unit without leaking anything", () => {
    const body = new URL(
      unresolvedNameIssueUrl({ name: "Some Analyte" })
    ).searchParams.get("body")!;
    expect(body).toContain("- Analyte name: Some Analyte");
    expect(body).toContain("- Unit: (none carried)");
  });
});

describe("tallyUnresolvedNames", () => {
  it("folds case-insensitively, sums counts, and sorts most-frequent first", () => {
    const tallied = tallyUnresolvedNames([
      { name: "Protein", unit: null },
      { name: "PROTEIN", unit: "mg/dL" },
      { name: "Ketones", unit: "mg/dL" },
      { name: "Protein" },
    ]);
    // Protein folds to one entry (first-seen spelling), count 3, first non-null unit.
    expect(tallied).toEqual([
      { name: "Protein", count: 3, unit: "mg/dL" },
      { name: "Ketones", count: 1, unit: "mg/dL" },
    ]);
  });

  it("survives a serialize → parse round trip and merges across documents", () => {
    const a: ImportReport = {
      ...emptyReport(),
      unresolvedNames: [{ name: "Protein", count: 2, unit: "mg/dL" }],
    };
    const b: ImportReport = {
      ...emptyReport(),
      unresolvedNames: [{ name: "protein", count: 1, unit: null }],
    };
    const round = parseImportReport(serializeImportReport(a));
    expect(round?.unresolvedNames).toEqual([
      { name: "Protein", count: 2, unit: "mg/dL" },
    ]);
    // Merge sums the two documents' Protein into one row.
    expect(mergeReports([a, b]).unresolvedNames).toEqual([
      { name: "Protein", count: 3, unit: "mg/dL" },
    ]);
  });

  it("defaults unresolvedNames to [] for a report stored before the field existed", () => {
    const legacy = JSON.stringify({
      drops: [],
      coverage: [],
      imported: 1,
      considered: 1,
    });
    expect(parseImportReport(legacy)?.unresolvedNames).toEqual([]);
  });
});

// #270: the unit rides the unmapped-code tally (catalog identity for the report
// prefill), keeping the first non-null unit per code.
describe("tallyUnmappedLoincs units", () => {
  it("carries the first non-null unit per code through the tally", () => {
    const tallied = tallyUnmappedLoincs([
      { loinc: "55555-5", name: "Novel Marker", unit: null },
      { loinc: "55555-5", name: "Novel Marker", unit: "ng/mL" },
      { loinc: "12345-6", name: "Some Assay" },
    ]);
    expect(tallied).toEqual([
      { loinc: "55555-5", name: "Novel Marker", count: 2, unit: "ng/mL" },
      { loinc: "12345-6", name: "Some Assay", count: 1, unit: null },
    ]);
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
    const { consumed, ignored, notConsumed } = summarizeCoverage(coverage);
    expect(consumed.map((c) => c.title)).toEqual(["Results"]);
    expect(consumed[0].present).toBe(5);
    // No `ignored` flag on these (older stored reports) → they stay notConsumed.
    expect(ignored).toEqual([]);
    // Sorted by title.
    expect(notConsumed.map((c) => c.title)).toEqual([
      "Functional Status",
      "Insurance",
    ]);
  });

  it("routes recognized-but-ignored entries to their own bucket (#268)", () => {
    const coverage: CoverageEntry[] = [
      { key: "results", title: "Results", consumed: true, present: 5 },
      {
        key: "insurance",
        title: "Insurance",
        consumed: false,
        present: 2,
        ignored: true,
      },
      { key: "Mystery", title: "Mystery", consumed: false, present: 1 },
      // A section consumed by one document and flagged ignored by another
      // stays CONSUMED — reading it into a sink wins.
      {
        key: "goals",
        title: "Goals",
        consumed: false,
        present: 1,
        ignored: true,
      },
      { key: "goals", title: "Goals", consumed: true, present: 1 },
    ];
    const { consumed, ignored, notConsumed } = summarizeCoverage(coverage);
    expect(consumed.map((c) => c.title)).toEqual(["Goals", "Results"]);
    expect(ignored.map((c) => c.title)).toEqual(["Insurance"]);
    expect(notConsumed.map((c) => c.title)).toEqual(["Mystery"]);
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

// ---- #1827: one vocabulary for "what counts as an imported row" ----

describe("keptRowCount", () => {
  it("sums every row-bearing kept list, ignoring absent ones", () => {
    expect(
      keptRowCount({
        records: [1, 2],
        immunizations: [1],
        allergies: [1],
        conditions: [1],
        encounters: [1],
        procedures: [1],
        familyHistory: [1],
        carePlanItems: [1],
        careGoals: [1],
        appointments: [1],
        genomicVariants: [1],
        imagingStudies: [1],
        opticalPrescriptions: [1],
        dentalProcedures: [1],
        bodyMetrics: [1],
        heights: [1],
        headCircs: [1],
      })
    ).toBe(18);
    expect(keptRowCount({})).toBe(0);
    // The domains the old hand-maintained sums forgot still count: a document that
    // carries ONLY them is not an empty import.
    expect(
      keptRowCount({
        imagingStudies: [1],
        opticalPrescriptions: [1],
        dentalProcedures: [1],
        genomicVariants: [1],
        appointments: [1],
      })
    ).toBe(5);
  });
});

describe("withFootprintCounts / reconcileStoredReportCounts", () => {
  const parseTime: ImportReport = {
    drops: [
      // Two row drops + one section drop, so `considered` has something to follow.
      { kind: "lab", label: "Comment(s)", reason: "null_flavor" },
      { kind: "medication", label: "Unreadable sig", reason: "no_value" },
      { kind: "section", label: "Insurance", reason: "unrecognized_section" },
    ],
    coverage: [
      { key: "results", title: "Results", consumed: true, present: 4 },
    ],
    // What a parse guessed — here, blind to the medications it kept.
    imported: 2,
    considered: 4,
  };

  it("rebinds imported to the footprint tally and considered to footprint + row drops", () => {
    const rebound = withFootprintCounts(parseTime, 9);
    expect(rebound.imported).toBe(9);
    expect(rebound.considered).toBe(11);
    // Everything else is carried through untouched.
    expect(rebound.drops).toEqual(parseTime.drops);
    expect(rebound.coverage).toEqual(parseTime.coverage);
    // Pure: the input report is not mutated.
    expect(parseTime.imported).toBe(2);
  });

  it("rebinds a stored report in place, and leaves a report-less / unusable blob alone", () => {
    const stored = reconcileStoredReportCounts(
      serializeImportReport(parseTime),
      9
    );
    const parsed = parseImportReport(stored)!;
    expect(parsed.imported).toBe(9);
    expect(parsed.considered).toBe(11);
    expect(parsed.drops).toHaveLength(3);
    // No report to reconcile (the paths that store none) stays null; an unparseable
    // blob is left exactly as it came rather than rewritten or dropped.
    expect(reconcileStoredReportCounts(null, 9)).toBeNull();
    expect(reconcileStoredReportCounts("{not json", 9)).toBe("{not json");
  });

  it("keeps the report's other fields across the rebind (confidence survives)", () => {
    const withConfidence: ImportReport = {
      ...parseTime,
      unmappedLoincs: [
        { loinc: "55555-5", name: "Novel Marker", count: 1, unit: "ng/mL" },
      ],
      confidence: {
        counts: { high: 1, medium: 1, low: 0, unknown: 0 },
        scrutiny: 1,
        flags: [
          {
            kind: "lab",
            label: "Novel Marker",
            confidence: "medium",
            reason: "unit could be mg/dL or mmol/L",
          },
        ],
      },
    };
    const parsed = parseImportReport(
      reconcileStoredReportCounts(serializeImportReport(withConfidence), 3)
    )!;
    expect(parsed.imported).toBe(3);
    expect(parsed.confidence?.scrutiny).toBe(1);
    expect(parsed.unmappedLoincs).toEqual(withConfidence.unmappedLoincs);
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
      unresolvedNames: [{ name: "Urobilinogen", count: 1, unit: "mg/dL" }],
      // Nothing here is a declared name (#2313), so the read-time split leaves the
      // declined half empty — parse always answers with both halves.
      declinedNames: [],
      reconciliation: {
        confirmed: 4,
        total: 5,
        flags: [{ name: "Ferritin", value: "999", verdict: "value_mismatch" }],
      },
      // Per-record extraction confidence (#1601) rides along in the same report.
      confidence: {
        counts: { high: 3, medium: 1, low: 1, unknown: 0 },
        scrutiny: 2,
        flags: [
          {
            kind: "lab",
            label: "Ferritin",
            confidence: "low",
            reason: "value smudged",
          },
          {
            kind: "condition",
            label: "Asthma",
            confidence: "medium",
            reason: null,
          },
        ],
      },
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
      unresolvedNames: [],
      declinedNames: [],
      reconciliation: null,
      // A report with no confidence key degrades to "no signal", not zeros (#1601).
      confidence: null,
    });
  });

  it("tolerates a garbled confidence block without losing the rest of the report (#1601)", () => {
    // A stored report whose confidence block is junk (hand-edited, truncated write,
    // an older writer's shape): the review surfaces must still get the drops and
    // counts, with confidence degrading to "no signal".
    const parsed = parseImportReport(
      JSON.stringify({
        drops: [{ kind: "lab", label: "A", reason: "no_value" }],
        coverage: [],
        imported: 4,
        considered: 5,
        confidence: "very sure",
      })
    );
    expect(parsed?.imported).toBe(4);
    expect(parsed?.drops).toHaveLength(1);
    expect(parsed?.confidence).toBeNull();

    // A partially-usable block keeps the rows it can read, drops the ones it can't,
    // and re-derives `scrutiny` rather than trusting a disagreeing stored total.
    const partial = parseImportReport(
      JSON.stringify({
        drops: [],
        coverage: [],
        imported: 2,
        considered: 2,
        confidence: {
          counts: { high: 1, medium: 1, low: 1, unknown: 0 },
          scrutiny: 99,
          flags: [
            { kind: "lab", label: "Kept Row", confidence: "medium" },
            { kind: "lab", confidence: "low" }, // no label → unusable
            { kind: "lab", label: "No Tier" }, // no confidence → unusable
          ],
        },
      })
    );
    expect(partial?.confidence?.scrutiny).toBe(1);
    expect(partial?.confidence?.flags.map((f) => f.label)).toEqual([
      "Kept Row",
    ]);
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
    // Insurance is recognized-but-ignored (#268), not an unrecognized gap.
    expect(byReason.unrecognized_section).toBeUndefined();
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

  // #270: the source-path chip must always render — every drop kind populates
  // `section`, including the classifier paths exercised by this CCD.
  it("populates section on every drop", () => {
    for (const d of report.drops) {
      expect(d.section, `${d.reason}:${d.label}`).toBeTruthy();
    }
  });

  it("lists Insurance as recognized-but-ignored, not a gap (#268)", () => {
    const { consumed, ignored, notConsumed } = summarizeCoverage(
      report.coverage
    );
    expect(consumed.map((c) => c.title)).toContain("Results");
    expect(ignored.map((c) => c.title)).toEqual(["Insurance"]);
    expect(notConsumed).toEqual([]);
    // The deliberately-ignored section is NOT an unrecognized_section drop.
    expect(
      report.drops.some(
        (d) => d.reason === "unrecognized_section" && d.label === "Insurance"
      )
    ).toBe(false);
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
      // (Procedure + FamilyMemberHistory + DocumentReference now HAVE mappers, so
      // Device stands in as the genuinely-unconsumed support type.)
      resource: { resourceType: "Device", status: "active" },
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
    expect(notConsumed.map((c) => c.title)).toContain("Device");
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
    { resource: { resourceType: "Device", status: "active" } },
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
    // But the genuinely-unconsumed Device IS still flagged.
    expect(notConsumed.map((c) => c.title)).toContain("Device");
    expect(unrecognized).toContain("Device");
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
    // #270: deduped drops carry the source path too.
    expect(deduped[0].section).toBe("Observation");
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
      { loinc: "55555-5", name: "Novel Marker", count: 1, unit: "ng/mL" },
    ]);
    // The unmapped lab is imported, not dropped.
    expect(report.drops.some((d) => d.label === "Novel Marker")).toBe(false);
  });
});

// ---- #1827: imaging counts, and the single-document and XDM paths agree ----

// A Results section whose ONLY entry is an Epic radiology-study observation
// (LOINC 18782-3, nullFlavor value + structured modality/site) — it becomes an
// imaging STUDY, not a lab record. Both CCD report builders kept it and neither
// counted it, so this document reported "0 imported" while its persist footprint
// wrote a row. Synthetic.
const IMAGING_CCD = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <effectiveTime value="20240301"/>
  <component><structuredBody>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
      <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Results</title>
      <entry><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.2"/>
        <id root="1.2.3" extension="IMG-77"/>
        <code code="18782-3" codeSystem="2.16.840.1.113883.6.1"><originalText>Radiology Study observation (narrative)</originalText></code>
        <statusCode code="completed"/>
        <effectiveTime><low value="20240301120000-0500"/></effectiveTime>
        <value xsi:type="ST" nullFlavor="NA"/>
        <methodCode code="4" codeSystem="1.2.840.114350.1.13.535.2.7.10.x"><originalText>Ultrasound</originalText></methodCode>
        <targetSiteCode code="119" codeSystem="1.2.840.114350.1.13.535.2.7.10.y"><originalText>Breast</originalText></targetSiteCode>
      </observation></entry>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;

describe("parseCcda → a kept imaging study counts as imported", () => {
  const parsed = parseCcda(IMAGING_CCD);

  it("counts the study the parser kept (it used to report zero)", () => {
    expect(parsed.imagingStudies).toHaveLength(1);
    expect(parsed.records).toHaveLength(0);
    expect(parsed.report!.imported).toBe(1);
  });
});

describe("mergeImportResults (XDM) → the merge path counts like the single-doc path", () => {
  it("counts the merged kept set: same document twice collapses, disjoint documents union", () => {
    const labOnly = parseCcda(CCD).report!.imported;
    const imagingOnly = parseCcda(IMAGING_CCD).report!.imported;
    // An XDM package repeating one document's sections collapses to a single kept
    // set — the merged count is the single-document count, not double it.
    const twice = mergeImportResults([
      parseCcda(IMAGING_CCD),
      parseCcda(IMAGING_CCD),
    ]).report!;
    expect(twice.imported).toBe(imagingOnly);
    // Disjoint documents union — and the merge path sees the imaging domain the
    // single-document path sees, because both count through the one registry.
    const both = mergeImportResults([
      parseCcda(CCD),
      parseCcda(IMAGING_CCD),
    ]).report!;
    expect(both.imported).toBe(labOnly + imagingOnly);
    expect(both.considered).toBe(both.imported + rowDropCount(both));
  });
});

// #2313 — the deliberately-uncurated split. The debugger's "Unresolved analytes"
// number is a claim about OUTSTANDING WORK, and a name this repo already decided
// not to curate is not outstanding work. It is FreshnessState's `not-applicable`,
// which must never fold into `due`.
describe("declared-vs-unresolved split (#2313)", () => {
  it("splits a tally by the registry, keeping the declaration on the declined half", () => {
    const { unresolvedNames, declinedNames } = splitDeclaredNames([
      { name: "E2E Novel Marker", count: 2, unit: "ng/mL" },
      { name: "eGFR, African American", count: 1, unit: "mL/min/1.73" },
      { name: "Diuretic Screen, Urine", count: 1, unit: null },
    ]);
    expect(unresolvedNames).toEqual([
      { name: "E2E Novel Marker", count: 2, unit: "ng/mL" },
    ]);
    expect(declinedNames.map((d) => d.name)).toEqual([
      "eGFR, African American",
      "Diuretic Screen, Urine",
    ]);
    // The declaration rides along so a surface renders the reason (and, for a
    // covered-elsewhere entry, the series that actually carries the quantity)
    // without going back to the registry itself.
    const egfr = declinedNames[0].declaration;
    expect(egfr.kind).toBe("covered-elsewhere");
    // The CURATED name since #2335 — `instead` is resolved against the dataset by the
    // registry's completeness guard and LINKED to by the debugger, so it moved with
    // the rename rather than staying on the retired spelling.
    expect(egfr.kind === "covered-elsewhere" && egfr.instead).toBe(
      "Estimated Glomerular Filtration Rate (eGFR)"
    );
    expect(declinedNames[1].declaration.kind).toBe("out-of-scope");
    // Counts and units survive the move — the declined half is the same row.
    expect(declinedNames[0].count).toBe(1);
    expect(declinedNames[0].unit).toBe("mL/min/1.73");
  });

  it("splits a report stored BEFORE the registry existed, with no rewrite", () => {
    // THE claim of doing this at read time: a blob written when all five names were
    // simply "unresolved" splits correctly the moment the declaration ships.
    const legacy = JSON.stringify({
      drops: [],
      coverage: [],
      imported: 3,
      considered: 3,
      unresolvedNames: [
        { name: "eGFR, Non-African-American", count: 2, unit: "mL/min/1.73" },
        { name: "Beta Adrenergic Blocker Screen", count: 1, unit: null },
        { name: "E2E Novel Marker", count: 1, unit: "ng/mL" },
      ],
    });
    const parsed = parseImportReport(legacy)!;
    expect(parsed.unresolvedNames).toEqual([
      { name: "E2E Novel Marker", count: 1, unit: "ng/mL" },
    ]);
    expect(parsed.declinedNames?.map((d) => d.name)).toEqual([
      "eGFR, Non-African-American",
      "Beta Adrenergic Blocker Screen",
    ]);
  });

  it("folds the declined half back into storage, so a re-persist can't freeze it", () => {
    // Serialization is the inverse: what goes back to the column is the whole
    // unresolved set, exactly as it was stored. Otherwise reconcileStoredReportCounts
    // (parse → re-serialize) would bake TODAY's registry into the blob and a later
    // declaration would stop being retroactive.
    const parsed = parseImportReport(
      JSON.stringify({
        drops: [],
        coverage: [],
        imported: 1,
        considered: 1,
        unresolvedNames: [
          { name: "eGFR, Thai", count: 1, unit: null },
          { name: "E2E Novel Marker", count: 1, unit: "ng/mL" },
        ],
      })
    )!;
    const stored = JSON.parse(serializeImportReport(parsed)!);
    expect(stored.declinedNames).toBeUndefined();
    // Both names are back in the one stored list (re-tallied, so the fold is
    // idempotent rather than appending a second copy).
    expect(stored.unresolvedNames).toEqual([
      { name: "E2E Novel Marker", count: 1, unit: "ng/mL" },
      { name: "eGFR, Thai", count: 1, unit: null },
    ]);
    // And the round trip is stable — re-parsing re-splits to the same two halves.
    expect(parseImportReport(serializeImportReport(parsed))).toEqual(parsed);
  });

  it("merges an XDM package's documents into one pool, then splits it", () => {
    const a: ImportReport = {
      ...emptyReport(),
      unresolvedNames: [{ name: "eGFR, Thai", count: 2, unit: null }],
    };
    const b: ImportReport = {
      ...emptyReport(),
      unresolvedNames: [
        { name: "eGFR, Thai", count: 1, unit: "mL/min/1.73" },
        { name: "E2E Novel Marker", count: 1, unit: "ng/mL" },
      ],
    };
    const merged = mergeReports([a, b]);
    expect(merged.unresolvedNames).toEqual([
      { name: "E2E Novel Marker", count: 1, unit: "ng/mL" },
    ]);
    // The declared name still tallies across documents — it is collapsed, never
    // dropped: the count is what a maintainer reads to see how often it recurs.
    expect(merged.declinedNames).toEqual([
      {
        name: "eGFR, Thai",
        count: 3,
        unit: "mL/min/1.73",
        declaration: merged.declinedNames![0].declaration,
      },
    ]);
  });
});
