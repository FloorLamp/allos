// Per-record extraction confidence (#1601): the ONE pure model for "how sure was
// the extractor about this row, and which rows deserve a human's attention first".
// No DB / network — a leaf module, so import-report can hold the persisted summary
// shape and every surface (the import detail card, the Review feed badge, tests)
// reads the same computation.
//
// POLICY (deliberate, from the issue): confidence ORDERS human attention and
// NOTHING else. Nothing auto-accepts, auto-rejects, hides, or re-weights a value
// because the model hedged — every extracted row is still imported and still
// reviewable. A low-confidence row is a row to LOOK at first, not a row we trust
// less in a calculation.
//
// It also degrades to nothing: a document extracted before this existed, a
// deterministic CCD/FHIR import (which has no model to ask), and an offline/keyless
// extraction all carry no confidence at all. `null` ranks as "unknown" — after the
// rows the model actually hedged on, never as a synthetic "low".

import { strOrNull } from "./parse";

// The coarse vocabulary the model answers in. Deliberately three buckets, not a
// score: a calibrated number is not something a document extractor can honestly
// produce, and a reviewer only needs "start here".
export const EXTRACTION_CONFIDENCES = ["high", "medium", "low"] as const;
export type ExtractionConfidence = (typeof EXTRACTION_CONFIDENCES)[number];

// Which extracted domain a flagged row came from — the same vocabulary as
// ImportReport's DropKind (minus its section/resource entries, which are not rows).
// Declared HERE, not imported from ./import-report, so this module stays a leaf that
// import-report can depend on; lib/__tests__/extraction-confidence.test.ts pins the
// two lists in sync.
export const CONFIDENCE_KINDS = [
  "lab",
  "vitals",
  "immunization",
  "medication",
  "allergy",
  "condition",
  "encounter",
  "procedure",
  "family_history",
  "care_plan",
  "care_goal",
  "genomic_variant",
  "imaging_study",
  "optical_prescription",
  "dental_procedure",
] as const;
export type ConfidenceKind = (typeof CONFIDENCE_KINDS)[number];

// The longest reason we keep. A reason is a review HINT ("date smudged on the
// scan", "unit ambiguous"), so it stays a phrase; anything longer is truncated
// rather than dropped, since even a clipped hint beats none.
const MAX_REASON_CHARS = 140;

// Coerce the model's `confidence` field to the vocabulary, or null when it said
// nothing usable. Tolerant of case/whitespace and of the near-miss words a model
// reaches for ("med", "moderate", "uncertain") — but never of a guess: an
// unrecognized value is UNKNOWN, not a bucket we invented for it.
export function normalizeConfidence(
  raw: unknown
): ExtractionConfidence | null {
  const s = strOrNull(raw)?.toLowerCase();
  if (!s) return null;
  if (s === "high" || s === "certain" || s === "confident") return "high";
  if (s === "medium" || s === "med" || s === "moderate") return "medium";
  if (s === "low" || s === "uncertain" || s === "unsure") return "low";
  return null;
}

// Coerce the model's short `confidence_reason` to a stored hint. Dropped entirely
// for a HIGH row (the issue asks for a reason on non-high only — "looks fine" is
// noise), and capped so a model that pasted a paragraph can't bloat the report.
export function normalizeConfidenceReason(
  raw: unknown,
  confidence: ExtractionConfidence | null
): string | null {
  if (confidence === "high" || confidence == null) return null;
  const s = strOrNull(raw);
  if (!s) return null;
  return s.length > MAX_REASON_CHARS ? s.slice(0, MAX_REASON_CHARS) : s;
}

// Sort key: the rows a reviewer should open FIRST come first. Unknown sorts LAST —
// a legacy row carries no doubt signal, so it must not jump ahead of a row the model
// explicitly hedged on.
export function confidenceRank(c: ExtractionConfidence | null): number {
  switch (c) {
    case "low":
      return 0;
    case "medium":
      return 1;
    case "high":
      return 2;
    default:
      return 3;
  }
}

// Does this row deserve a human's attention before the others? True for the tiers
// the model itself hedged on. The ONE place that decision is made — the persisted
// `scrutiny` total, the feed badge, and the detail card all trace back here.
export function needsScrutiny(c: ExtractionConfidence | null): boolean {
  return c === "low" || c === "medium";
}

const CONFIDENCE_LABELS: Record<ExtractionConfidence, string> = {
  high: "high confidence",
  medium: "medium confidence",
  low: "low confidence",
};

// Display label for a confidence, including the honest phrasing for an absent one.
export function confidenceLabel(c: ExtractionConfidence | null): string {
  return c ? CONFIDENCE_LABELS[c] : "confidence not reported";
}

// One extraction row the model was NOT fully confident about, as persisted in the
// import report and rendered in the review card. `label` is the row's own name (the
// analyte, condition, substance…) — the same identity the Dropped list shows — so a
// reviewer can find the row it points at.
export interface ConfidenceFlag {
  kind: ConfidenceKind;
  label: string;
  confidence: ExtractionConfidence;
  // The model's short "why" for a non-high row, when it gave one.
  reason: string | null;
}

// Whole-document confidence outcome, persisted on
// medical_documents.import_report.confidence. Absent for every path that has no
// model answer (deterministic imports, pre-#1601 documents, offline extraction).
export interface ExtractionConfidenceSummary {
  // How the document's rows split across the vocabulary. `unknown` counts rows the
  // model answered nothing usable for — visible rather than folded into a tier.
  counts: Record<ExtractionConfidence | "unknown", number>;
  // How many rows deserve a look (needsScrutiny), PRECOMPUTED so no other surface
  // re-decides which tiers those are — including the SQL the Review feed badge
  // projects it with.
  scrutiny: number;
  // The scrutiny rows themselves, lowest-confidence first.
  flags: ConfidenceFlag[];
}

// One extracted row as this module sees it: what kind it is, what it's called, and
// what the model said about it.
export interface ConfidenceItem {
  kind: ConfidenceKind;
  label: string;
  confidence: ExtractionConfidence | null;
  reason: string | null;
}

// Order rows for review: lowest confidence first, unknown last, and STABLE within a
// tier so the document's own order (the order the rows appear on the page) survives.
export function rankByConfidence<T extends { confidence: ExtractionConfidence | null }>(
  items: T[]
): T[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort(
      (a, b) =>
        confidenceRank(a.item.confidence) - confidenceRank(b.item.confidence) ||
        a.i - b.i
    )
    .map((x) => x.item);
}

// Reduce a document's extracted rows to the persisted summary. Returns null when NO
// row carried a confidence at all — the honest answer for a deterministic import or
// a pre-#1601 extraction is "no signal", not a summary of zeros, so a surface can
// tell "the model was sure" apart from "nobody asked".
export function summarizeExtractionConfidence(
  items: ConfidenceItem[]
): ExtractionConfidenceSummary | null {
  if (!items.some((i) => i.confidence != null)) return null;
  const counts: ExtractionConfidenceSummary["counts"] = {
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
  };
  for (const item of items) counts[item.confidence ?? "unknown"] += 1;
  const flags: ConfidenceFlag[] = rankByConfidence(
    items.filter((i) => needsScrutiny(i.confidence))
  ).map((i) => ({
    kind: i.kind,
    label: i.label,
    // Narrowed by needsScrutiny above — a flag always carries a real tier.
    confidence: i.confidence as ExtractionConfidence,
    reason: i.reason,
  }));
  return { counts, scrutiny: flags.length, flags };
}

// Merge per-document summaries (an XDM package's several documents). Counts add,
// flags concatenate and are re-ranked so the merged list still reads lowest-first.
// Null when no document had a signal.
export function mergeConfidenceSummaries(
  summaries: (ExtractionConfidenceSummary | null | undefined)[]
): ExtractionConfidenceSummary | null {
  const present = summaries.filter(
    (s): s is ExtractionConfidenceSummary => s != null
  );
  if (!present.length) return null;
  const counts: ExtractionConfidenceSummary["counts"] = {
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
  };
  for (const s of present) {
    counts.high += s.counts?.high ?? 0;
    counts.medium += s.counts?.medium ?? 0;
    counts.low += s.counts?.low ?? 0;
    counts.unknown += s.counts?.unknown ?? 0;
  }
  const flags = rankByConfidence(present.flatMap((s) => s.flags ?? []));
  return { counts, scrutiny: flags.length, flags };
}

// Parse a STORED summary back into shape, tolerating a legacy/partial/garbled blob
// the same way parseImportReport tolerates a garbled report: an unusable value
// degrades to null (no signal) instead of throwing on a review surface.
export function parseConfidenceSummary(
  raw: unknown
): ExtractionConfidenceSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const rawCounts =
    obj.counts && typeof obj.counts === "object"
      ? (obj.counts as Record<string, unknown>)
      : {};
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  const counts: ExtractionConfidenceSummary["counts"] = {
    high: num(rawCounts.high),
    medium: num(rawCounts.medium),
    low: num(rawCounts.low),
    unknown: num(rawCounts.unknown),
  };
  const flags: ConfidenceFlag[] = (Array.isArray(obj.flags) ? obj.flags : [])
    .map((f) => {
      const row = (f ?? {}) as Record<string, unknown>;
      const confidence = normalizeConfidence(row.confidence);
      const label = strOrNull(row.label);
      const kind = strOrNull(row.kind) as ConfidenceKind | null;
      if (!confidence || !label || !kind) return null;
      return {
        kind,
        label,
        confidence,
        reason: normalizeConfidenceReason(row.reason, confidence),
      } satisfies ConfidenceFlag;
    })
    .filter((f): f is ConfidenceFlag => f != null);
  const ranked = rankByConfidence(flags);
  // A summary with neither a count nor a flag carries no signal at all.
  if (
    !ranked.length &&
    counts.high + counts.medium + counts.low + counts.unknown === 0
  )
    return null;
  // `scrutiny` is re-derived rather than trusted from the blob: it is a computed
  // answer, and a stored one could disagree with the flags beside it.
  return { counts, scrutiny: ranked.length, flags: ranked };
}
