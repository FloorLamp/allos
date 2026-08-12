// Folding a document's per-question rows into ONE instrument SCORE (#2321). PURE — no
// DB/network, unit-tested in lib/__tests__/instrument-import.test.ts.
//
// `lib/instrument-recognize.ts` answers "do these questions spell out an instrument,
// and what did it score?". This module applies that answer to what the clinical
// parsers actually hold — `ImportedRecord`s — and is the ONLY place that turns a
// recognition into rows:
//
//   • SCORED → the per-question records LEAVE (their answers now ride on the score, in
//     `instrument_responses`) and one `instrument`-category record takes their place,
//     under the instrument's curated canonical name. That name is the whole point: it
//     joins the shared range/flag machinery, the severity band and the crisis decision
//     the in-app administration path already feeds, and NO question text ever coins an
//     identity of its own.
//   • REFUSED → nothing moves. The per-question records keep their #2318 `assessment`
//     treatment — stored, dated, viewable on the document, carrying no biomarker
//     identity — and the SCORE is reported as one reasoned drop, so a screening the
//     app declined to score is visible in the import debugger rather than absent.
//
// The refusals are reported with their own DropReasons because "no value" and "other"
// would both be lies: the document carried plenty of value, and the reason a reader
// needs ("this score is somebody else's" / "this screening is half-answered") is
// exactly the thing a generic bucket erases.

import type { ImportedRecord } from "./health-import";
import type { ImportDrop } from "./import-report";
import { instrumentDef } from "./mental-health";
import {
  recognizeInstrument,
  type InstrumentAttribution,
} from "./instrument-recognize";

export interface InstrumentFold {
  records: ImportedRecord[];
  drops: ImportDrop[];
}

// The candidates: the `assessment` rows this document filed with a printed answer.
// #2318 already routes a questionnaire item there — no number, no unit, no range, no
// analyte identity — so this reads exactly the population that used to become
// per-question pseudo-biomarkers, and never touches a real reading.
function isCandidate(r: ImportedRecord): boolean {
  return r.category === "assessment" && (r.value ?? "").trim() !== "";
}

// Fold one section's records. `attribution` is the document's own statement of whose
// screening this is plus how many patients the document is about (see
// lib/instrument-recognize.ts on what silence means); `section` names the originating
// section for the drop's context.
export function foldInstrumentScores(
  records: readonly ImportedRecord[],
  attribution: InstrumentAttribution,
  section: string
): InstrumentFold {
  const candidateIdx: number[] = [];
  records.forEach((r, i) => {
    if (isCandidate(r)) candidateIdx.push(i);
  });
  if (candidateIdx.length < 2) return { records: [...records], drops: [] };

  const recognized = recognizeInstrument(
    candidateIdx.map((i) => ({
      name: records[i].name,
      answerText: records[i].value,
    })),
    attribution
  );
  if (recognized.kind === "none") return { records: [...records], drops: [] };

  const def = instrumentDef(recognized.instrument);
  if (recognized.kind === "refused") {
    return {
      records: [...records],
      drops: [
        {
          kind: "lab",
          label: def.title,
          reason:
            recognized.why === "subject"
              ? "other_subject"
              : "incomplete_instrument",
          section,
        },
      ],
    };
  }

  const consumed = new Set(recognized.consumed.map((c) => candidateIdx[c]));
  // The score is dated and provenanced by the ITEMS it was computed from — the first
  // one in document order. A screening is administered in one sitting, so the items
  // share a date; taking the first keeps the score on the day the answers were given
  // rather than on the document's own generation day.
  const first = records[[...consumed][0]];
  const score: ImportedRecord = {
    category: "instrument",
    name: def.title,
    canonical: def.canonicalName,
    value: String(recognized.total),
    value_num: recognized.total,
    unit: null,
    date: first.date,
    occurred_at: first.occurred_at ?? null,
    // The instrument's own code is the SCORE's identity; the per-item survey LOINCs
    // that the questions carried are not this row's, and #2318's strip already keeps
    // them from becoming analyte codes.
    loinc: null,
    // Keyed on the instrument and the day, NOT on the total: re-importing the same
    // document must land on the same row, and a corrected total for the same sitting
    // is the same measurement re-stated, not a second screening.
    external_id: `ccda:instrument:${def.canonicalName.toLowerCase()}:${first.date}`,
    provider: first.provider ?? null,
    instrumentAnswers: recognized.answers,
  };
  return {
    records: [...records.filter((_, i) => !consumed.has(i)), score],
    drops: [],
  };
}
