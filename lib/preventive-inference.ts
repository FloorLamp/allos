import {
  PREVENTIVE_CONCEPT_MAP,
  type ConceptMatcher,
} from "./preventive-concept-map";
import type { PreventiveKind } from "./preventive-catalog";
import type { PreventiveSatisfaction } from "./preventive-status";

// Pure, DB-free record → preventive-satisfaction inference (issue #86). Given
// existing records — coded/named procedures, lab/vitals results, completed
// appointments/encounters, completed care-plan items — this derives the SAME
// `(ruleKey, date)` satisfactions the manual "mark done" stream produces, so both
// feed one assessor (`lib/preventive-status.ts`) unchanged. The query layer
// (`lib/queries/upcoming.ts`) does the profile-scoped reads and merges the
// results; everything here is pure and unit-tested.
//
// CONSERVATIVE (issue #86): a record must carry a clear code (exact match against
// the concept map) OR a whole-word name synonym OR — for labs — an exact canonical
// biomarker name. Ambiguous text never matches. A record with no usable date is
// skipped (it can't be placed on the timeline). Nothing is inferred beyond what
// the curated `lib/preventive-concept-map.ts` maps.

// One record to test for satisfaction evidence. `name` is the free-text label
// (procedure name / appointment title / encounter type+reason / care-plan
// description). `canonicalName` is set only for lab/vitals result rows. `date`
// is when the event happened (YYYY-MM-DD); a null/blank date drops the record.
// `allow` gates which rule kinds this record's SOURCE may satisfy — procedures &
// labs pass `["screening"]`, appointments & encounters `["visit"]`, care-plan
// items may pass both.
export interface InferenceRecord {
  code: string | null;
  name: string | null;
  canonicalName?: string | null;
  date: string | null;
  allow: PreventiveKind[];
  shape: EvidenceShape;
}

// ---- WHAT THE `name` ACTUALLY IS (issue #3025) -----------------------------
//
// A second axis beside `allow`, and independent of it. `allow` says which rule KINDS a
// source may satisfy; this says what kind of THING its `name` is, which decides which
// needles may be read from it.
//
//   • "event"    — the label of something that HAPPENED: a procedure, a completed
//                  appointment, an encounter, a completed care-plan item. Every needle
//                  applies, `eventNames` included.
//   • "document" — the TITLE OF A FILED DOCUMENT: a medical_records row. Only `names`
//                  apply, and the title's own PROSE — a refusal, a request genre — can
//                  withhold them. It can never withhold a code or a canonical name.
//
// It exists because #3025 admitted the `report` category into this stream, and a report
// is a document. The concept map's behavioural-health needles ("counseling",
// "psychotherapy") were written for the visit stream, where the word names an encounter
// that happened; in a document title the same word names a topic. "Nutrition Counseling
// Note" satisfied BOTH depression and anxiety screening for a year, against a control
// where both were overdue — a false satisfaction, which is a screening that is never
// nudged again.
//
// A DOCUMENT IS NOT ONLY A `report`. Every clinical observation is document-shaped here,
// labs and vitals included — their `name` is what a lab printed on a line, not the label
// of an event. That is why the prose guards below touch ONLY the name path: an exact
// code or canonical biomarker name is an IDENTITY, and an identity must always beat a
// title's prose. A first draft of this returned `[]` before either was consulted, so
// "Lipid panel — fasting not done" carrying `canonical_name = LDL Cholesterol` stopped
// satisfying `lipid_screening` — a regression against main on a safety signal, caused by
// a guard that was true of its own function and false of the stream it ran in.
export type EvidenceShape = "event" | "document";

// ---- A document title's own prose (issue #3025) ----------------------------
//
// TWO SEPARATE THINGS A TITLE CAN SAY, and they are scoped differently on purpose.
//
// A REFUSAL qualifies a SUBJECT: "Screening mammogram declined by patient" is the record
// of a refusal, and reading it as the mammogram is a missed cancer screening. But
// "Pap smear — patient declined HPV co-test" refuses an ANCILLARY, and the Pap on the
// left of the dash happened. So a refusal is scoped to the CLAUSE it sits in, and only
// the needles inside that clause are withheld. A title with no refusal word anywhere is
// matched exactly as it always was, whole-text — clause splitting can only ever change
// the answer for a title that carries a refusal.
//
// A REQUEST GENRE classifies the WHOLE DOCUMENT: an order, a referral, a reminder, a
// consent form and a leaflet are documents ABOUT a screening that has not happened. It is
// read from the title's HEAD — the first clause, where a document states what it is — so
// "Order for screening mammogram" is a request while "Colonoscopy report; standing order
// for repeat in 10 years" is a colonoscopy report.
//
// DOCUMENT TITLES ONLY. The event streams (an encounter's type + reason + notes +
// provider, a care-plan description) are whole sentences where a refusal may be about
// something else entirely, and they pre-date this change; widening these guards onto them
// is a separate ruling with its own regression surface.

// Whole-word against the same space-wrapped normalization every needle uses, so
// "undeclined" and "cancellation" are not matches.
const NEGATION_NEEDLES = [
  "declined",
  "refused",
  "cancelled",
  "canceled",
  "not performed",
  "not done",
  "no show",
].map((n) => ` ${n} `);

// The genre words a document uses to say it is a REQUEST for a screening rather than the
// result of one. Read from the first clause only (see above).
const REQUEST_GENRE_NEEDLES = [
  "order",
  "orders",
  "request",
  "requisition",
  "referral",
  "reminder",
  "consent",
  "leaflet",
  "brochure",
  "education",
  "educational",
  "instructions",
  "invitation",
  "due for",
].map((n) => ` ${n} `);

// The clause separators a document title uses. Deliberately NOT a bare hyphen — that
// lives inside "Dual-energy X-ray absorptiometry" and inside "Gyn-PAP" — but a SPACED
// hyphen is the ASCII stand-in for the dash and does separate.
const CLAUSE_SPLIT = /[;:,.()[\]/|\n]|\s[—–-]\s/;

export interface TitleClause {
  /** The clause, normalized and space-wrapped exactly like every needle. */
  text: string;
  /** Does a refusal sit in THIS clause? */
  negated: boolean;
}

// A document title split into clauses, each normalized for whole-word testing.
export function documentTitleClauses(
  name: string | null | undefined
): TitleClause[] {
  return (name ?? "")
    .split(CLAUSE_SPLIT)
    .map((raw) => normalizeMatchText(raw))
    .filter((text) => text.trim().length > 0)
    .map((text) => ({
      text,
      negated: NEGATION_NEEDLES.some((n) => text.includes(n)),
    }));
}

// Is this document a REQUEST for a screening rather than a record of one? Read from the
// title's head, which is where a document says what kind of document it is.
export function documentIsRequest(name: string | null | undefined): boolean {
  const [head] = documentTitleClauses(name);
  if (!head) return false;
  return REQUEST_GENRE_NEEDLES.some((n) => head.text.includes(n));
}

// Normalize free text for whole-word matching: lowercased, every run of
// non-alphanumerics collapsed to a single space, trimmed, then wrapped in single
// spaces so a synonym phrase can be tested as ` phrase ` (whole-word, never a
// substring of a larger token — "pap" won't hit "papilloma").
export function normalizeMatchText(s: string | null | undefined): string {
  if (!s) return " ";
  const core = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return core ? ` ${core} ` : " ";
}

// Normalize a code for exact set membership: trimmed + uppercased. Codes are
// otherwise compared verbatim (no prefix logic), keeping matches specific.
export function normalizeCode(s: string | null | undefined): string {
  return (s ?? "").trim().toUpperCase();
}

// Whether a status string denotes a COMPLETED/fulfilled event — the only states
// that count as evidence for appointment/care-plan inference. Conservative: an
// unknown/blank/planned/cancelled status is NOT completion.
const COMPLETED_STATUSES = new Set([
  "completed",
  "complete",
  "done",
  "finished",
  "fulfilled",
  "achieved",
  "resolved",
]);
export function isCompletedStatus(status: string | null | undefined): boolean {
  return COMPLETED_STATUSES.has((status ?? "").trim().toLowerCase());
}

// Lazily-built reverse indexes over the curated concept map, so a lookup is O(1)
// per record rather than a scan of every matcher.
interface Indexes {
  byCode: Map<string, ConceptMatcher[]>;
  byCanonical: Map<string, ConceptMatcher[]>;
  // Precomputed ` phrase ` needles per matcher for whole-word name testing.
  // `needles` holds `names` — legal against any record; `eventNeedles` holds
  // `eventNames`, legal only against an EVENT-shaped record (see EvidenceShape).
  nameNeedles: {
    matcher: ConceptMatcher;
    needles: string[];
    eventNeedles: string[];
  }[];
}

let cached: Indexes | null = null;
function indexes(): Indexes {
  if (cached) return cached;
  const byCode = new Map<string, ConceptMatcher[]>();
  const byCanonical = new Map<string, ConceptMatcher[]>();
  const nameNeedles: Indexes["nameNeedles"] = [];
  const push = (
    m: Map<string, ConceptMatcher[]>,
    key: string,
    v: ConceptMatcher
  ) => {
    const arr = m.get(key);
    if (arr) arr.push(v);
    else m.set(key, [v]);
  };
  for (const matcher of PREVENTIVE_CONCEPT_MAP) {
    for (const code of matcher.codes)
      push(byCode, normalizeCode(code), matcher);
    for (const cn of matcher.canonicalResultNames) {
      push(byCanonical, cn.trim().toLowerCase(), matcher);
    }
    // Each needle is already space-wrapped (` phrase `), so a substring test
    // against the equally space-wrapped record text is a whole-word match.
    nameNeedles.push({
      matcher,
      needles: matcher.names.map((n) => normalizeMatchText(n)),
      eventNeedles: matcher.eventNames.map((n) => normalizeMatchText(n)),
    });
  }
  cached = { byCode, byCanonical, nameNeedles };
  return cached;
}

// The catalog rule keys a single record satisfies, gated by `allow` and by `shape`.
// Order of precedence is immaterial (all matches are unioned): exact code, exact
// canonical biomarker name, then whole-word name synonym. Returns a de-duplicated list.
//
// `shape` defaults to "event", which is what every source was before #3025 admitted a
// document category into the stream. The DEFAULT IS THE PERMISSIVE ONE, so the place
// that must not forget to answer is `InferenceRecord`, where it is REQUIRED — a new
// source that never declared its shape is a type error there rather than a silent
// document reading a conversation's word as evidence.
export function matchRuleKeys(
  rec: {
    code?: string | null;
    name?: string | null;
    canonicalName?: string | null;
    shape?: EvidenceShape;
  },
  allow: PreventiveKind[]
): string[] {
  const idx = indexes();
  const allowed = new Set(allow);
  const keys = new Set<string>();
  const shape: EvidenceShape = rec.shape ?? "event";

  // AN IDENTITY BEATS PROSE, ALWAYS. The code and canonical-name paths run first and run
  // unconditionally: an exact CPT/LOINC/SNOMED code and an exact canonical biomarker name
  // are identities the concept map curated, and no wording in a free-text `name` may
  // withhold them. Every clinical observation is document-shaped, so a guard placed in
  // front of these took a lab carrying `canonical_name = LDL Cholesterol` out of
  // `lipid_screening` because its printed name said "fasting not done".
  const code = normalizeCode(rec.code);
  if (code) {
    for (const m of idx.byCode.get(code) ?? []) {
      if (allowed.has(m.kind)) keys.add(m.ruleKey);
    }
  }

  const canonical = (rec.canonicalName ?? "").trim().toLowerCase();
  if (canonical) {
    for (const m of idx.byCanonical.get(canonical) ?? []) {
      if (allowed.has(m.kind)) keys.add(m.ruleKey);
    }
  }

  // THE NAME PATH, where a title's own prose is allowed to speak — and only here.
  const text = normalizeMatchText(rec.name);
  // A REQUEST is not a result: a document whose head says "Order", "Referral",
  // "Reminder", "Consent" or "Leaflet" is about a screening that has not happened, so it
  // contributes no name evidence at all. It keeps whatever a code or canonical name
  // proved, because those are identities.
  const isRequest = shape === "document" && documentIsRequest(rec.name);
  // Clause scoping is paid for ONLY when a refusal is present. With none — the
  // overwhelming majority — the haystack is the whole title, exactly as before, so no
  // existing match can be lost to where a comma happens to fall.
  const clauses = shape === "document" ? documentTitleClauses(rec.name) : [];
  const negatedSomewhere = clauses.some((c) => c.negated);
  const openClauses = clauses.filter((c) => !c.negated);

  if (text.trim() && !isRequest) {
    for (const { matcher, needles, eventNeedles } of idx.nameNeedles) {
      if (!allowed.has(matcher.kind)) continue;
      if (keys.has(matcher.ruleKey)) continue;
      // The event-only needles are added to the haystack test ONLY for an event —
      // a document title never reaches them (see EvidenceShape).
      const usable =
        shape === "event" ? [...needles, ...eventNeedles] : needles;
      // A refusal withholds the needles in ITS OWN clause and no others: the Pap on the
      // left of the dash happened even though the co-test on the right was declined.
      const hit = negatedSomewhere
        ? openClauses.some((c) => usable.some((n) => c.text.includes(n)))
        : usable.some((n) => text.includes(n));
      if (hit) keys.add(matcher.ruleKey);
    }
  }

  return [...keys];
}

// Derive every satisfaction implied by `records`. Each record yielding one or
// more rule matches (and carrying a usable date) contributes a
// `(ruleKey, date)` — the exact shape the manual stream emits — so the caller can
// concatenate these with `preventive_events` and hand the union to the assessor.
export function inferPreventiveSatisfactions(
  records: InferenceRecord[]
): PreventiveSatisfaction[] {
  const out: PreventiveSatisfaction[] = [];
  for (const rec of records) {
    const date = (rec.date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    for (const ruleKey of matchRuleKeys(rec, rec.allow)) {
      out.push({ ruleKey, date });
    }
  }
  return out;
}
