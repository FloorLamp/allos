// PURE TIER — recognising a screening instrument in a clinical document (#2321) and
// folding its per-question rows into one score.
//
// The orientation tests are the point of this file. EPDS scores items 1, 2 and 4 from
// 0 down the printed list and REVERSES the other seven, so an inverted item still
// produces a plausible-looking total in a real band — it is just the wrong band. Each
// item is therefore pinned individually rather than through a total that could be
// right for the wrong reasons.
//
// SYNTHETIC ONLY: invented answers, fictional dates. No PHI.

import { describe, expect, it } from "vitest";
import {
  answerValueFor,
  attributesToPatient,
  foldInstrumentText,
  recognizeInstrument,
  type DocumentSubjectScope,
  type InstrumentAttribution,
  type InstrumentItemCandidate,
  type InstrumentSubject,
} from "@/lib/instrument-recognize";
import { foldInstrumentScores } from "@/lib/instrument-import";
import {
  crisisDecision,
  instrumentDef,
  instrumentItemOptions,
  severityBand,
} from "@/lib/mental-health";
import type { ImportedRecord } from "@/lib/health-import";

const EPDS = instrumentDef("EPDS");

// The two attribution facts, spelled at each call site so a test never leaves the
// document scope implicit. `OWN` is the ordinary single-patient CCD that states its
// subject; `SILENT` is the same document restating nothing (#2558's case).
function attr(
  stated: InstrumentSubject,
  scope: DocumentSubjectScope = "single-patient"
): InstrumentAttribution {
  return { stated, scope };
}
const OWN = attr("patient");

// The full instrument as a document would print it: every question with a chosen
// answer. `pick` maps an item index to the position of the option in its PRINTED list,
// which is deliberately NOT the score — that is the whole thing under test.
function epdsCandidates(
  pick: (i: number) => number
): InstrumentItemCandidate[] {
  return EPDS.items.map((item, i) => ({
    name: item,
    answerText: instrumentItemOptions("EPDS", i)[pick(i)].label,
  }));
}

describe("EPDS item orientation (#2321)", () => {
  // Items 1, 2 and 4 run 0→3 down the printed list; items 3 and 5-10 run 3→0.
  const FORWARD = new Set([0, 1, 3]);

  it.each(EPDS.items.map((item, i) => [i, item] as const))(
    "item %i scores its printed options in the published direction",
    (i) => {
      const options = instrumentItemOptions("EPDS", i);
      expect(options.map((o) => o.value)).toEqual(
        FORWARD.has(i) ? [0, 1, 2, 3] : [3, 2, 1, 0]
      );
    }
  );

  it("scores the least-severe answer to every item as 0, not as a printed position", () => {
    // Answering every item with its own 0-valued option is a total of 0 whichever way
    // the item is oriented. An inverted item would show up here as a stray 3.
    const answers = EPDS.items.map((_, i) => {
      const options = instrumentItemOptions("EPDS", i);
      return answerValueFor(
        "EPDS",
        i,
        options.find((o) => o.value === 0)!.label
      );
    });
    expect(answers).toEqual(EPDS.items.map(() => 0));
  });

  it("reads the FIRST printed option as 0 on a forward item and 3 on a reversed one", () => {
    // "As much as I always could" is item 1's first printed option and worth 0.
    expect(answerValueFor("EPDS", 0, "As much as I always could")).toBe(0);
    // "Yes, most of the time" is item 3's first printed option and worth 3.
    expect(answerValueFor("EPDS", 2, "Yes, most of the time")).toBe(3);
  });

  it("refuses an answer the item does not offer rather than guessing a near one", () => {
    expect(answerValueFor("EPDS", 0, "Somewhat less than before")).toBeNull();
    expect(answerValueFor("EPDS", 0, "")).toBeNull();
    // An option belonging to a DIFFERENT item is not this item's answer.
    expect(answerValueFor("EPDS", 0, "Hardly ever")).toBeNull();
  });

  it("bands the published cut-offs where the published instrument puts them", () => {
    expect(severityBand("EPDS", 9).label).toBe("Minimal");
    expect(severityBand("EPDS", 10).label).toBe("Possible depression");
    expect(severityBand("EPDS", 13).label).toBe("Probable depression");
    expect(severityBand("EPDS", 20).label).toBe("Severe");
  });
});

describe("the self-harm item does the work, not the total (#2321)", () => {
  it("escalates a NON-severe total when item 10 is positive", () => {
    // Every item answered at its 0 option except the self-harm item, answered
    // "Hardly ever" (1). The total is 1 — nowhere near the severe band.
    const answers: Record<number, number> = {};
    EPDS.items.forEach((_, i) => {
      answers[i] = 0;
    });
    answers[EPDS.selfHarmItemIndex!] = 1;
    const decision = crisisDecision("EPDS", 1, answers);
    expect(decision.severe).toBe(false);
    expect(decision.selfHarm).toBe(true);
    expect(decision.escalate).toBe(true);
  });

  it("does not escalate the same non-severe total when item 10 is zero", () => {
    const answers: Record<number, number> = {};
    EPDS.items.forEach((_, i) => {
      answers[i] = 0;
    });
    answers[0] = 1;
    expect(crisisDecision("EPDS", 1, answers).escalate).toBe(false);
  });

  it("declares an index at all — a null one would import, score, and never escalate", () => {
    expect(EPDS.selfHarmItemIndex).toBe(EPDS.items.length - 1);
  });
});

// The attribution decision on its own, as a truth table over both axes. It is three
// lines of code guarding a mental-health score's owner, so every cell is pinned rather
// than sampled through the recogniser.
describe("attributesToPatient (#2321 / #2558)", () => {
  const cells: [InstrumentSubject, DocumentSubjectScope, boolean][] = [
    ["patient", "single-patient", true],
    ["patient", "multiple-subjects", true],
    ["unstated", "single-patient", true],
    ["unstated", "multiple-subjects", false],
    ["other", "single-patient", false],
    ["other", "multiple-subjects", false],
  ];
  for (const [stated, scope, expected] of cells) {
    it(`${stated} subject in a ${scope} document → ${expected}`, () => {
      expect(attributesToPatient({ stated, scope })).toBe(expected);
    });
  }

  it("never lets the document scope rescue a STATED other subject", () => {
    // The invariant #2558 must not weaken, asserted as an invariant rather than as two
    // of the rows above: whatever a future scope value means, "somebody else's" wins.
    const scopes: DocumentSubjectScope[] = [
      "single-patient",
      "multiple-subjects",
    ];
    for (const scope of scopes) {
      expect(attributesToPatient({ stated: "other", scope })).toBe(false);
    }
  });
});

describe("recognizeInstrument", () => {
  it("scores a complete instrument for the chart's own patient", () => {
    // Every item answered with its second printed option.
    const got = recognizeInstrument(
      epdsCandidates(() => 1),
      OWN
    );
    expect(got.kind).toBe("scored");
    if (got.kind !== "scored") return;
    expect(got.instrument).toBe("EPDS");
    // Forward items contribute 1, reversed items contribute 2.
    expect(got.total).toBe(3 * 1 + 7 * 2);
    expect(got.answers).toHaveLength(10);
  });

  it("refuses when the document names another subject", () => {
    const got = recognizeInstrument(
      epdsCandidates(() => 0),
      attr("other")
    );
    expect(got).toMatchObject({
      kind: "refused",
      why: "subject",
      instrument: "EPDS",
    });
  });

  it("scores an unstated subject in a SINGLE-patient document (#2558)", () => {
    // The ordinary CCD: the patient is established once in the header and the
    // observations never restate it. There is nobody else in the document, so the
    // score is this patient's.
    const got = recognizeInstrument(
      epdsCandidates(() => 0),
      attr("unstated", "single-patient")
    );
    expect(got.kind).toBe("scored");
  });

  it("still refuses an unstated subject when the document names MORE THAN ONE patient", () => {
    // The case the strict rule exists for, and the one #2558 deliberately kept: an
    // unattributable mental-health score in a chart that holds two people would be
    // filed against a coin flip.
    const got = recognizeInstrument(
      epdsCandidates(() => 0),
      attr("unstated", "multiple-subjects")
    );
    expect(got).toMatchObject({
      kind: "refused",
      why: "subject",
      subject: "unstated",
      scope: "multiple-subjects",
    });
  });

  it("refuses a STATED other subject even in a single-patient document", () => {
    // A positive statement about somebody else is not silence, and no amount of
    // single-patient-ness makes the mother's EPDS the infant's.
    expect(
      recognizeInstrument(
        epdsCandidates(() => 0),
        attr("other", "single-patient")
      )
    ).toMatchObject({ kind: "refused", why: "subject", subject: "other" });
  });

  it("refuses a partly answered instrument instead of banding a short total", () => {
    const got = recognizeInstrument(epdsCandidates(() => 0).slice(0, 9), OWN);
    expect(got).toMatchObject({
      kind: "refused",
      why: "partial",
      answered: 9,
      items: 10,
    });
  });

  it("counts an unreadable answer as unanswered, so the instrument refuses", () => {
    const candidates = epdsCandidates(() => 0);
    candidates[4] = { ...candidates[4], answerText: "Declined to answer" };
    expect(recognizeInstrument(candidates, OWN)).toMatchObject({
      kind: "refused",
      why: "partial",
      answered: 9,
    });
  });

  it("recognises nothing in ordinary observations", () => {
    expect(
      recognizeInstrument(
        [
          { name: "Ambulates independently", answerText: "Yes" },
          { name: "Temperature site", answerText: "Oral" },
        ],
        OWN
      )
    ).toEqual({ kind: "none" });
  });

  it("matches published wording through numbering, asterisks and punctuation", () => {
    expect(foldInstrumentText("3. *I have blamed myself, unnecessarily!")).toBe(
      foldInstrumentText("I have blamed myself unnecessarily")
    );
    const numbered = epdsCandidates(() => 0).map((c, i) => ({
      ...c,
      name: `${i + 1}. ${c.name}`,
    }));
    expect(recognizeInstrument(numbered, OWN).kind).toBe("scored");
  });

  it("keeps PHQ-9 and EPDS distinct — one score never stands in for the other", () => {
    const phq = instrumentDef("PHQ-9");
    const got = recognizeInstrument(
      phq.items.map((item) => ({ name: item, answerText: "Not at all" })),
      OWN
    );
    expect(got).toMatchObject({
      kind: "scored",
      instrument: "PHQ-9",
      total: 0,
    });
  });
});

// ---- the record fold -------------------------------------------------------

function assessmentRow(name: string, value: string): ImportedRecord {
  return {
    category: "assessment",
    name,
    canonical: name,
    value,
    value_num: null,
    unit: null,
    date: "2026-03-04",
    external_id: `ccda:obs:${name.toLowerCase()}:2026-03-04:${value}`,
  };
}

function epdsRows(pick: (i: number) => number): ImportedRecord[] {
  return epdsCandidates(pick).map((c) =>
    assessmentRow(c.name, c.answerText ?? "")
  );
}

describe("foldInstrumentScores", () => {
  it("replaces the question rows with ONE score under the curated canonical name", () => {
    const folded = foldInstrumentScores(
      epdsRows(() => 0),
      OWN,
      "Results"
    );
    expect(folded.drops).toEqual([]);
    expect(folded.records).toHaveLength(1);
    const score = folded.records[0];
    // Every item answered with its FIRST PRINTED option, which is worth 0 on the three
    // forward items and 3 on the seven reversed ones — 21, not 0. Printed position is
    // not the score, and a fold that ignored orientation would answer 0 here.
    expect(score).toMatchObject({
      category: "instrument",
      canonical: "EPDS",
      value_num: 21,
      date: "2026-03-04",
      loinc: null,
    });
    expect(score.instrumentAnswers).toHaveLength(10);
    // No question text survives as a canonical name.
    expect(folded.records.some((r) => r.canonical.startsWith("I have "))).toBe(
      false
    );
  });

  it("keys the score on the instrument and the day, not on the total", () => {
    const a = foldInstrumentScores(
      epdsRows(() => 0),
      OWN,
      "Results"
    );
    const b = foldInstrumentScores(
      epdsRows(() => 1),
      OWN,
      "Results"
    );
    expect(a.records[0].external_id).toBe(b.records[0].external_id);
  });

  it("leaves the rows alone and reports the SCORE as a reasoned drop when refused", () => {
    const rows = epdsRows(() => 0);
    const folded = foldInstrumentScores(rows, attr("other"), "Results");
    expect(folded.records).toHaveLength(rows.length);
    expect(folded.records.every((r) => r.category === "assessment")).toBe(true);
    expect(folded.drops).toEqual([
      {
        kind: "lab",
        label: "EPDS",
        reason: "other_subject",
        section: "Results",
      },
    ]);
  });

  it("reports a partly answered instrument under its own reason", () => {
    const folded = foldInstrumentScores(
      epdsRows(() => 0).slice(0, 9),
      OWN,
      "Functional Status"
    );
    expect(folded.drops[0]).toMatchObject({
      reason: "incomplete_instrument",
      label: "EPDS",
      section: "Functional Status",
    });
  });

  // #2553. Every assertion above holds on a document that happens to print the items
  // in the instrument's own order, where "the first item" and "the first row" are the
  // same row — which is exactly why the mismatch survived review. This fixture makes
  // the two orders DISAGREE: the document prints item 10 first and item 1 last, and
  // each row carries its own date and performer. Only a fold that reads DOCUMENT
  // position answers 2026-03-01 here; one that reads the instrument's item numbering
  // answers 2026-03-10, the row the document printed LAST.
  const shuffledEpdsRows = (): ImportedRecord[] =>
    epdsRows(() => 0)
      .reverse()
      .map((row, position) => {
        const day = `2026-03-${String(position + 1).padStart(2, "0")}`;
        return {
          ...row,
          date: day,
          occurred_at: `${day}T09:00:00Z`,
          provider: {
            name: `Riverbend Clinic ${position + 1}`,
            type: "organization" as const,
            npi: null,
            identifier: null,
            phone: null,
            address: null,
          },
          external_id: `${row.external_id}:${position}`,
        };
      });

  it("dates and provenances the score from the row the DOCUMENT printed first", () => {
    const folded = foldInstrumentScores(shuffledEpdsRows(), OWN, "Results");
    expect(folded.records).toHaveLength(1);
    expect(folded.records[0]).toMatchObject({
      canonical: "EPDS",
      value_num: 21,
      date: "2026-03-01",
      occurred_at: "2026-03-01T09:00:00Z",
      provider: { name: "Riverbend Clinic 1" },
    });
  });

  it("keys the score on the document-first day too", () => {
    // The dedupe key embeds that same date, so an item-index read would put the same
    // sitting on a different row than a re-import whose section happened to print the
    // items in the instrument's order.
    const folded = foldInstrumentScores(shuffledEpdsRows(), OWN, "Results");
    expect(folded.records[0].external_id).toBe(
      "ccda:instrument:epds:2026-03-01"
    );
  });

  it("never touches a real reading — a lab row is not a candidate", () => {
    const lab: ImportedRecord = {
      category: "lab",
      name: "Glucose",
      canonical: "Glucose",
      value: "95",
      value_num: 95,
      unit: "mg/dL",
      date: "2026-03-04",
      external_id: "ccda:obs:glucose:2026-03-04:95",
    };
    const folded = foldInstrumentScores(
      [lab, ...epdsRows(() => 0)],
      OWN,
      "Results"
    );
    expect(folded.records).toContainEqual(lab);
  });
});
