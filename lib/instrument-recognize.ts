// Recognising a SCREENING INSTRUMENT in a clinical document (#2321). PURE — no
// DB/network, unit-tested in lib/__tests__/instrument-recognize.test.ts.
//
// A CCD files a screening instrument as its individual QUESTIONS: one observation per
// item, the question text as the observation's printed name, a free-text answer ("As
// much as I always could") as its value, no number, no unit, no reference range. Two
// things can be done with those rows and both are wrong: dropping them loses the
// screening outright, and storing them as-is files ten fake analytes (#2318 stops the
// second by withholding identity, which is not the same as understanding them).
//
// So this module answers ONE question — "do these observations spell out an instrument
// this app knows, and if so what did it score?" — and the answer feeds the substrate
// that already exists (lib/instrument-records.ts: one score row plus per-item
// `instrument_responses`, severity bands, the crisis decision).
//
// Two REFUSALS are as much a part of the answer as the score, and both are
// safety-relevant rather than fussy:
//
//   • A PARTIAL instrument does not score. A partial total is not a smaller total, it
//     is a different measurement — nine of ten EPDS items answered cannot be banded
//     against cut-offs derived from ten.
//   • An instrument's SUBJECT is not always the chart's patient. Post-natal screening
//     is administered to a PARENT and routinely filed in the CHILD's chart, which is
//     where the rows that opened #2321 came from. Attributing a caregiver's depression
//     score to the child would be wrong clinically, wrong under this app's profile
//     model, and would put a crisis-escalating score on the wrong person — so a STATED
//     other subject refuses, unconditionally and forever.
//
//     SILENCE is the case #2558 re-decided. #2321 shipped it as a refusal too, and the
//     cost of that was invisible: an ordinary CCD is single-patient by construction and
//     establishes its patient ONCE in the header, so most documents restate no subject
//     on the observation. Under the strict rule those documents never scored at all,
//     while their per-question rows imported happily — a user saw ten PHQ-9 questions
//     and no PHQ-9. So silence is now read against the DOCUMENT: where the document
//     names exactly one patient there is nobody else the score could be about, and it
//     scores; where it names more than one, an unattributable score still refuses.
//     That second clause is the entire point — the multi-patient chart is where a
//     guess does the harm, and it is the one place the strict rule still stands.
//
// Neither refusal deletes anything. The item observations keep the #2318 `assessment`
// treatment — stored, dated, viewable on their document, carrying no biomarker
// identity — and the SCORE is what is reported as a reasoned drop.

import {
  INSTRUMENTS,
  instrumentDef,
  instrumentItemOptions,
  type Instrument,
} from "./mental-health";

// One candidate item as the document printed it: the observation's resolved name (the
// question) and its resolved answer text. Deliberately the two strings BOTH clinical
// parsers can produce, so neither has to know how matching works.
export interface InstrumentItemCandidate {
  name: string;
  answerText: string | null;
}

// Whose score is this? Read off the document by the caller (C-CDA states a non-default
// subject with a `<subject><relatedSubject>` participation), never guessed here.
export type InstrumentSubject = "patient" | "other" | "unstated";

// How many people the DOCUMENT is about — a different question from the one above, and
// the one that decides what silence means (#2558). Read off the header by the caller
// (C-CDA: `recordTarget/patientRole`), never guessed here.
export type DocumentSubjectScope =
  // The document names exactly one patient. Nothing it states can be about a second
  // one, so an observation that restates no subject is about that patient.
  | "single-patient"
  // The document names more than one patient — or names none at all, which is the same
  // ignorance wearing a different hat. Silence here is unattributable.
  | "multiple-subjects";

// The two facts a score's attribution rests on, carried together so neither can be
// consulted without the other.
export interface InstrumentAttribution {
  // What THIS screening's observations state.
  stated: InstrumentSubject;
  // What the document as a whole is about.
  scope: DocumentSubjectScope;
}

// THE attribution decision, pure and on its own so it can be read in one sitting: may a
// recognised score be filed as this chart patient's?
//
//   stated "other"    → never, whatever the document is (#2321).
//   stated "patient"  → always; the document said so.
//   stated "unstated" → only in a single-patient document (#2558).
export function attributesToPatient(a: InstrumentAttribution): boolean {
  if (a.stated === "other") return false;
  if (a.stated === "patient") return true;
  return a.scope === "single-patient";
}

export interface RecognizedInstrument {
  instrument: Instrument;
  total: number;
  answers: { itemIndex: number; answer: number }[];
  // Which candidates (by index into the input array) the score CONSUMED. The caller
  // removes exactly these — the answers now live in `instrument_responses`, and
  // leaving the per-question rows behind too would store one screening twice.
  consumed: number[];
}

// Why a recognised instrument did NOT score. Each maps to one reported drop.
export type InstrumentRefusal =
  | {
      why: "partial";
      instrument: Instrument;
      answered: number;
      items: number;
    }
  // The score could not be attributed to the chart's patient. Both halves of the
  // decision are carried, because "the document said it is the mother's" and "the
  // document said nothing and there are two patients in it" are different facts about
  // the same refusal, and a reader of the drop deserves to know which one happened.
  | {
      why: "subject";
      instrument: Instrument;
      subject: InstrumentSubject;
      scope: DocumentSubjectScope;
    };

export type InstrumentRecognition =
  // Nothing here spells out an instrument this app knows — the caller does exactly
  // what it did before.
  | { kind: "none" }
  | ({ kind: "scored" } & RecognizedInstrument)
  | ({ kind: "refused" } & InstrumentRefusal);

// Fold a printed question or answer to its comparable form. Documents re-print
// published wording with item numbering ("3. I have blamed myself…"), the reverse-score
// asterisk the published sheet marks, typographic apostrophes, and trailing
// punctuation; none of those change which item or option it is. Everything that is not
// a letter or a digit collapses to a single space, which also folds hyphens, en dashes
// and the "—" the published text uses mid-sentence.
export function foldInstrumentText(s: string | null | undefined): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/^[\s*]*\d{1,2}\s*[.)]\s*/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// The instruments a document can be recognised as. Every entry in the catalog — the
// recognition rule is the catalog, so an instrument added there is recognisable at the
// import door with no second registration to forget.
function itemIndexFor(instrument: Instrument, folded: string): number {
  return instrumentDef(instrument).items.findIndex(
    (item) => foldInstrumentText(item) === folded
  );
}

// The score one printed answer carries for one item, or null when the text matches no
// option the item offers. NEVER a nearest match: an unrecognised answer makes the
// instrument partial, which refuses, rather than contributing a guessed number to a
// total that then gets banded.
export function answerValueFor(
  instrument: Instrument,
  itemIndex: number,
  answerText: string | null
): number | null {
  const folded = foldInstrumentText(answerText);
  if (!folded) return null;
  const hit = instrumentItemOptions(instrument, itemIndex).find(
    (o) => foldInstrumentText(o.label) === folded
  );
  return hit ? hit.value : null;
}

// Which instrument, if any, these candidates spell out: the one the MOST of them match
// an item of, requiring at least two matched items so a single incidental phrase can
// never nominate an instrument. Ties keep catalog order, which is stable.
function nominate(candidates: readonly InstrumentItemCandidate[]): {
  instrument: Instrument;
  // item index → the index of the candidate answering it.
  matched: Map<number, number>;
} | null {
  let best: {
    instrument: Instrument;
    matched: Map<number, number>;
  } | null = null;
  for (const instrument of INSTRUMENTS) {
    const matched = new Map<number, number>();
    for (let i = 0; i < candidates.length; i++) {
      const idx = itemIndexFor(
        instrument,
        foldInstrumentText(candidates[i].name)
      );
      // First match wins for a repeated item — a document that prints the same
      // question twice is not two answers.
      if (idx >= 0 && !matched.has(idx)) matched.set(idx, i);
    }
    if (matched.size < 2) continue;
    if (!best || matched.size > best.matched.size)
      best = { instrument, matched };
  }
  return best;
}

// THE recognition. `attribution` is the caller's reading of the document: what this
// screening's observations STATE about their subject, and how many patients the
// document as a whole is about. See the header on what silence means.
export function recognizeInstrument(
  candidates: readonly InstrumentItemCandidate[],
  attribution: InstrumentAttribution
): InstrumentRecognition {
  const nominated = nominate(candidates);
  if (!nominated) return { kind: "none" };
  const { instrument, matched } = nominated;
  const items = instrumentDef(instrument).items.length;

  // The subject question is asked BEFORE the answers are read: whose score this is
  // does not depend on how it scored, and refusing early keeps a wrong-subject total
  // from ever existing as a number.
  if (!attributesToPatient(attribution))
    return {
      kind: "refused",
      why: "subject",
      instrument,
      subject: attribution.stated,
      scope: attribution.scope,
    };

  const answers: { itemIndex: number; answer: number }[] = [];
  const consumed: number[] = [];
  for (const [itemIndex, at] of [...matched].sort((a, b) => a[0] - b[0])) {
    const answer = answerValueFor(
      instrument,
      itemIndex,
      candidates[at].answerText
    );
    if (answer == null) continue;
    answers.push({ itemIndex, answer });
    consumed.push(at);
  }
  // EVERY item, answered on an option the instrument actually offers. An unreadable
  // answer counts as unanswered, so a document the parser half-understood refuses
  // instead of banding a total that is missing points.
  if (answers.length !== items)
    return {
      kind: "refused",
      why: "partial",
      instrument,
      answered: answers.length,
      items,
    };
  return {
    kind: "scored",
    instrument,
    total: answers.reduce((sum, a) => sum + a.answer, 0),
    answers,
    consumed,
  };
}
