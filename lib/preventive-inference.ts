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
//                  apply, and a title that NEGATES its own subject applies nothing.
//
// It exists because #3025 admitted the `report` category into this stream, and a report
// is a document. The concept map's behavioural-health needles ("counseling",
// "psychotherapy") were written for the visit stream, where the word names an encounter
// that happened; in a document title the same word names a topic. "Nutrition Counseling
// Note" satisfied BOTH depression and anxiety screening for a year, against a control
// where both were overdue — a false satisfaction, which is a screening that is never
// nudged again.
export type EvidenceShape = "event" | "document";

// A document title that REFUSES its own subject is not evidence that the subject
// happened — "Screening mammogram declined by patient" is the record of a refusal, and
// reading it as the mammogram is the same false satisfaction one step further on.
//
// DOCUMENT TITLES ONLY, deliberately. The event streams (an encounter's type + reason +
// notes + provider, a care-plan description) are free text where a negation may be about
// something other than the match, and they pre-date this change; widening the guard onto
// them is a separate ruling with its own regression surface.
//
// Whole-word against the same space-wrapped normalization every needle uses, so
// "undeclined" and "cancellation" are not matches.
const NEGATED_DOCUMENT_NEEDLES = [
  "declined",
  "refused",
  "cancelled",
  "canceled",
  "not performed",
  "not done",
  "no show",
].map((n) => ` ${n} `);

// Does this document title refuse its own subject?
export function documentTitleIsNegated(
  name: string | null | undefined
): boolean {
  const text = normalizeMatchText(name);
  return NEGATED_DOCUMENT_NEEDLES.some((n) => text.includes(n));
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

  // A document that refuses its own subject is evidence of nothing, by any path — not
  // by name, and not by a code or canonical name the same row happens to carry.
  if (shape === "document" && documentTitleIsNegated(rec.name)) return [];

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

  const text = normalizeMatchText(rec.name);
  if (text.trim()) {
    for (const { matcher, needles, eventNeedles } of idx.nameNeedles) {
      if (!allowed.has(matcher.kind)) continue;
      if (keys.has(matcher.ruleKey)) continue;
      // The event-only needles are added to the haystack test ONLY for an event —
      // a document title never reaches them (see EvidenceShape).
      const usable =
        shape === "event" ? [...needles, ...eventNeedles] : needles;
      if (usable.some((n) => text.includes(n))) keys.add(matcher.ruleKey);
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
