import { describe, it, expect } from "vitest";
import {
  normalizeTriageLabel,
  recordConfidenceKind,
  resolveTriageTarget,
  triageFocus,
  triageRowId,
  type TriageRow,
} from "../confidence-triage";

// The resolution decision behind the "Check these first" links (#2339): a flag's
// label → the row it names, WITHOUT guessing. Three answers matter, and the two
// unhappy ones matter most: several matches must filter rather than select (a
// reviewer sent to the wrong row may edit it), and no match must be visible as
// "no match" rather than a link that lands nowhere.

const labRow = (id: number, ...labels: (string | null)[]): TriageRow => ({
  kind: "lab",
  tabKey: "lab",
  rowId: triageRowId("lab", id),
  labels,
});

describe("triageRowId", () => {
  it("separates the same row id on different tabs", () => {
    // A medical_records id and a conditions id collide freely, so the tab is part
    // of the identity — otherwise a lab link would land on a condition.
    expect(triageRowId("lab", 7)).not.toBe(triageRowId("conditions", 7));
  });
});

describe("normalizeTriageLabel", () => {
  it("folds case and collapses whitespace", () => {
    expect(normalizeTriageLabel("  Vitamin   D  ")).toBe("vitamin d");
    expect(normalizeTriageLabel("VITAMIN D")).toBe("vitamin d");
  });
});

describe("recordConfidenceKind", () => {
  it("maps a records category to the kind its flag was written under", () => {
    expect(recordConfidenceKind("prescription")).toBe("medication");
    expect(recordConfidenceKind("vitals")).toBe("vitals");
    expect(recordConfidenceKind("lab")).toBe("lab");
    // Every other analyte-ish category is flagged as a lab, including one the
    // vocabulary never named.
    expect(recordConfidenceKind("biomarker")).toBe("lab");
    expect(recordConfidenceKind("genomics")).toBe("lab");
    expect(recordConfidenceKind(null)).toBe("lab");
  });
});

describe("resolveTriageTarget", () => {
  it("links straight at the row when the label names exactly one", () => {
    const rows = [labRow(1, "Ferritin"), labRow(2, "Vitamin D")];
    expect(
      resolveTriageTarget({ kind: "lab", label: "Vitamin D" }, rows)
    ).toEqual({
      status: "row",
      tabKey: "lab",
      rowId: triageRowId("lab", 2),
    });
  });

  it("matches a stored row through any of the names it goes by", () => {
    // The flag records the name the MODEL used; the table renders the name the row
    // was stored under, and a canonicalized analyte legitimately differs.
    const rows = [labRow(3, "25-OH vitamin D", "Vitamin D")];
    expect(
      resolveTriageTarget({ kind: "lab", label: "Vitamin D" }, rows)
    ).toMatchObject({ status: "row", rowId: triageRowId("lab", 3) });
    expect(
      resolveTriageTarget({ kind: "lab", label: " 25-oh   VITAMIN d " }, rows)
    ).toMatchObject({ status: "row", rowId: triageRowId("lab", 3) });
  });

  it("filters the owning tab when several rows carry the label", () => {
    const rows = [
      labRow(1, "Glucose"),
      labRow(2, "Glucose"),
      labRow(3, "Iron"),
    ];
    expect(
      resolveTriageTarget({ kind: "lab", label: "Glucose" }, rows)
    ).toEqual({ status: "filter", tabKey: "lab" });
  });

  it("filters the FIRST matching tab when the name spans two of them", () => {
    // Rows arrive in tab-strip order, so the first match is the leftmost tab.
    const rows: TriageRow[] = [
      labRow(1, "Glucose"),
      { ...labRow(9, "Glucose"), tabKey: "biomarker" },
    ];
    expect(
      resolveTriageTarget({ kind: "lab", label: "Glucose" }, rows)
    ).toMatchObject({ status: "filter", tabKey: "lab" });
  });

  it("reports missing when nothing carries the label", () => {
    const rows = [labRow(1, "Ferritin")];
    expect(
      resolveTriageTarget({ kind: "lab", label: "Vitamin D" }, rows)
    ).toEqual({ status: "missing" });
  });

  it("reports missing for an empty or whitespace-only label", () => {
    expect(resolveTriageTarget({ kind: "lab", label: "   " }, [])).toEqual({
      status: "missing",
    });
  });

  it("never resolves across kinds", () => {
    // A condition and a lab may share a name; the flag says which domain it meant,
    // and answering with the other one is exactly the wrong-row failure mode.
    const rows: TriageRow[] = [
      labRow(1, "Iron deficiency"),
      {
        kind: "condition",
        tabKey: "conditions",
        rowId: triageRowId("conditions", 4),
        labels: ["Iron deficiency"],
      },
    ];
    expect(
      resolveTriageTarget({ kind: "condition", label: "Iron deficiency" }, rows)
    ).toEqual({
      status: "row",
      tabKey: "conditions",
      rowId: triageRowId("conditions", 4),
    });
  });

  it("matches a medication on the identity its own domain keys on", () => {
    // The flag carries the printed prescription line; the med the import created
    // is named by the drug alone, with "10 mg" living on its dose. medNameKey is
    // the same collapse the import/renewal/family paths use, so the link lands on
    // the med the writer actually created rather than reporting it missing.
    const rows: TriageRow[] = [
      {
        kind: "medication",
        tabKey: "medications",
        rowId: triageRowId("medications", 5),
        labels: ["Lisinopril"],
      },
    ];
    expect(
      resolveTriageTarget(
        { kind: "medication", label: "Lisinopril 10 mg" },
        rows
      )
    ).toMatchObject({ status: "row", tabKey: "medications" });
    // A different drug still misses — the collapse is an identity, not a fuzz.
    expect(
      resolveTriageTarget(
        { kind: "medication", label: "Metformin 500 mg" },
        rows
      )
    ).toEqual({ status: "missing" });
  });

  it("ignores a row whose alternate name is absent", () => {
    const rows = [labRow(1, "Ferritin", null)];
    expect(
      resolveTriageTarget({ kind: "lab", label: "Ferritin" }, rows)
    ).toMatchObject({ status: "row" });
  });
});

describe("triageFocus", () => {
  const rows = [
    labRow(1, "Glucose"),
    labRow(2, "Glucose"),
    labRow(3, "Ferritin"),
  ];

  it("highlights the single row a label resolves to", () => {
    expect(triageFocus("Ferritin", rows)).toEqual({
      label: "Ferritin",
      rowIds: [triageRowId("lab", 3)],
      mode: "highlight",
    });
  });

  it("filters to every row carrying an ambiguous label", () => {
    expect(triageFocus("glucose", rows)).toEqual({
      label: "glucose",
      rowIds: [triageRowId("lab", 1), triageRowId("lab", 2)],
      mode: "filter",
    });
  });

  it("reports missing rather than silently highlighting nothing", () => {
    // The row was renamed or deleted between the card rendering and the click:
    // re-resolving here is what turns that into something the page can say.
    expect(triageFocus("Vitamin D", rows)).toEqual({
      label: "Vitamin D",
      rowIds: [],
      mode: "missing",
    });
  });
});
