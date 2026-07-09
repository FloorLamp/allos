import type { ExtractedResult } from "./medical-extract";
import type { BodyMetricKind } from "./types";
import { normalizeCanonicalKey } from "./canonical-name";
import { round, toKg } from "./units";

// Derives body_metrics rows from a medical document's extracted results, so a
// DEXA scan or vitals panel that reports weight / body fat % / resting HR also
// lands in Body Metrics. Provenance uses the body_metrics.source column with a
// 'document:<id>' value, so imported rows can be replaced on reprocess and
// removed with the document — manual rows (source NULL) and integration rows
// (e.g. 'health-connect') are never touched.

export const DOCUMENT_SOURCE_PREFIX = "document:";

export function documentSource(docId: number): string {
  return `${DOCUMENT_SOURCE_PREFIX}${docId}`;
}

// One body-metrics row derived from a document (per date). weight_kg is nullable
// (#120): a date reporting only body fat or resting HR still produces a row, so a
// weightless vitals reading has a home in body_metrics rather than being split off.
export interface DocBodyMetric {
  date: string;
  weight_kg: number | null;
  body_fat_pct: number | null;
  resting_hr: number | null;
}

// Metric recognition matches on the same order-independent token key the
// canonical-name machinery uses, so comma inversions ("Heart Rate, Resting")
// and "%"/punctuation variants match without hand-listing each spelling.
const keySet = (names: string[]) =>
  new Set(names.map((n) => normalizeCanonicalKey(n)));

// Total body weight only — regional DEXA masses ("Arms Total Mass") and organ
// weights have different token sets, so they can't be mistaken for a body weight.
const WEIGHT_NAMES = keySet([
  "Weight",
  "Body Weight",
  "Body Mass",
  "Total Mass",
  "Total Body Mass",
  "Total Body Weight",
]);

const BODY_FAT_NAMES = keySet([
  "Body Fat",
  "Body Fat Percent",
  "Body Fat Percentage",
  "Body Fat Pct",
  "Total Body Fat",
]);

const RESTING_HR_NAMES = keySet([
  "Resting Heart Rate",
  "Resting HR",
  "Resting Pulse",
  "Resting Pulse Rate",
]);

// body_metrics.date must stay YYYY-MM-DD (string ordering and chart parsing rely
// on it), and the AI's collected_date/document_date are only *asked* to be ISO.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function isoOrNull(s: string | null): string | null {
  return s && ISO_DATE.test(s) ? s : null;
}

// Convert a reported weight to canonical kg. Only explicitly recognized units
// are accepted: a missing unit is genuinely ambiguous (a US report's unit-less
// "180" is pounds), and storing a wrong-unit weight corrupts every weight
// consumer — so ambiguous rows are skipped rather than guessed (unknown unit →
// null). Since every value reaching the plausibility band is already
// unit-converted from an explicit unit, the band is a pure sanity guard: the
// lower bound is 2 kg (a small term newborn) so infant/toddler weights import
// and feed the pediatric growth charts (#101) — the old 20 kg floor silently
// dropped them. 400 kg caps mis-unitted garbage.
function weightToKg(value: number, unit: string | null): number | null {
  const u = (unit ?? "").toLowerCase().replace(/[^a-z]/g, "");
  let kg: number;
  if (u === "kg" || u === "kgs" || u === "kilogram" || u === "kilograms")
    kg = value;
  else if (
    u === "lb" ||
    u === "lbs" ||
    u === "lbav" || // UCUM avoirdupois pound "[lb_av]"
    u === "pound" ||
    u === "pounds"
  )
    kg = toKg(value, "lb");
  else if (u === "g" || u === "gram" || u === "grams") kg = value / 1000;
  else return null;
  return kg >= 2 && kg <= 400 ? round(kg, 2) : null;
}

// DEXA reports print "Total Body Fat" both as a percentage and as a MASS
// (kg/lb) — a mass value inside 1–75 would silently pass as a percent, so only
// percent-ish (or absent) units are accepted.
function bodyFatPct(value: number, unit: string | null): number | null {
  const u = (unit ?? "").toLowerCase().replace(/[^a-z%]/g, "");
  if (u !== "" && u !== "%" && u !== "percent" && u !== "pct") return null;
  return value >= 1 && value <= 75 ? round(value, 1) : null;
}

function restingHr(value: number): number | null {
  return value >= 25 && value <= 150 ? Math.round(value) : null;
}

// A body metric that belongs in body_metrics rather than medical_records (#120):
// weight / body fat % / resting HR. Returns null for a clinical vital (BP, temp,
// SpO2, respiratory rate) or a lab, which stay in medical_records. Matches on the
// order-independent token key, so spellings/inversions/units don't matter.
// BodyMetricKind (weight | body_fat | resting_hr) is the shared metric-kind enum
// from ./types, also used by goals and getLatestBodyMetric.
export function bodyMetricKind(
  name: string | null | undefined,
  canonical: string | null | undefined
): BodyMetricKind | null {
  const keys = [
    normalizeCanonicalKey(canonical ?? ""),
    normalizeCanonicalKey(name ?? ""),
  ];
  if (keys.some((k) => WEIGHT_NAMES.has(k))) return "weight";
  if (keys.some((k) => BODY_FAT_NAMES.has(k))) return "body_fat";
  if (keys.some((k) => RESTING_HR_NAMES.has(k))) return "resting_hr";
  return null;
}

// A generic reading any import path can hand to the body-metrics projection.
export interface BodyMetricReading {
  name: string | null;
  canonical: string | null;
  value_num: number | null;
  unit: string | null;
  date: string | null;
}

// Fold readings into at most one body-metrics row per date (the first matching
// value wins on duplicates). Dates come from each reading, falling back to the
// document date; both must be ISO, and a reading with no real date is skipped —
// inventing a date (e.g. "today") would make an old scan's weight the newest
// reading everywhere. A date with only body fat / resting HR and no weight still
// produces a (weightless) row (#120), so nothing is silently dropped; only a date
// with no recognized body metric at all is omitted.
export function bodyMetricsFromReadings(
  readings: BodyMetricReading[],
  documentDate: string | null
): DocBodyMetric[] {
  interface Partial {
    weight_kg: number | null;
    body_fat_pct: number | null;
    resting_hr: number | null;
  }
  const fallbackDate = isoOrNull(documentDate);
  const byDate = new Map<string, Partial>();
  const partialFor = (date: string): Partial => {
    let p = byDate.get(date);
    if (!p) {
      p = { weight_kg: null, body_fat_pct: null, resting_hr: null };
      byDate.set(date, p);
    }
    return p;
  };

  for (const r of readings) {
    if (r.value_num == null) continue;
    const date = isoOrNull(r.date) ?? fallbackDate;
    if (!date) continue;
    const kind = bodyMetricKind(r.name, r.canonical);
    if (kind === "weight") {
      const kg = weightToKg(r.value_num, r.unit);
      const p = partialFor(date);
      if (kg != null && p.weight_kg == null) p.weight_kg = kg;
    } else if (kind === "body_fat") {
      const pct = bodyFatPct(r.value_num, r.unit);
      const p = partialFor(date);
      if (pct != null && p.body_fat_pct == null) p.body_fat_pct = pct;
    } else if (kind === "resting_hr") {
      const hr = restingHr(r.value_num);
      const p = partialFor(date);
      if (hr != null && p.resting_hr == null) p.resting_hr = hr;
    }
  }

  return [...byDate.entries()]
    .filter(([, p]) => hasBodyMetric(p))
    .map(([date, p]) => ({
      date,
      weight_kg: p.weight_kg,
      body_fat_pct: p.body_fat_pct,
      resting_hr: p.resting_hr,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// AI-extraction adapter over bodyMetricsFromReadings (dates from collected_date).
export function bodyMetricsFromExtraction(
  results: ExtractedResult[],
  documentDate: string | null
): DocBodyMetric[] {
  return bodyMetricsFromReadings(
    results.map((r) => ({
      name: r.name,
      canonical: r.canonical_name,
      value_num: r.value_num,
      unit: r.unit,
      date: r.collected_date,
    })),
    documentDate
  );
}

// ---- Persistence decisions (pure; the DB writers call these) ----
// Extracted so the merge / fold / defer rules that decide what actually hits
// body_metrics are unit-tested, not buried in SQL. Each has a DB caller that
// routes through it, so the shipped behavior and the tests can't drift.

// The three nullable measures a body_metrics row carries.
export interface BodyMetricValues {
  weight_kg: number | null;
  body_fat_pct: number | null;
  resting_hr: number | null;
}

export type BodyMetricColumn = "weight_kg" | "body_fat_pct" | "resting_hr";

// True when a reading carries at least one metric worth a row.
export function hasBodyMetric(v: BodyMetricValues): boolean {
  return v.weight_kg != null || v.body_fat_pct != null || v.resting_hr != null;
}

// Merge an incoming reading into an existing same-day/same-source row: a non-null
// incoming value wins (a corrected weight overwrites), otherwise the existing
// value is kept. So a partial sync window fills gaps without blanking what an
// earlier window already stored. The per-column equivalent of COALESCE(?, col),
// used by upsertBodyMetrics (integration ingest).
export function mergeBodyMetric(
  existing: BodyMetricValues,
  incoming: BodyMetricValues
): BodyMetricValues {
  return {
    weight_kg: incoming.weight_kg ?? existing.weight_kg,
    body_fat_pct: incoming.body_fat_pct ?? existing.body_fat_pct,
    resting_hr: incoming.resting_hr ?? existing.resting_hr,
  };
}

// Round a raw (possibly day-averaged) value to each column's stored precision:
// resting HR to a whole bpm, body fat to 0.1%, weight to 0.01 kg.
export function roundBodyMetric(
  column: BodyMetricColumn,
  value: number
): number {
  if (column === "resting_hr") return Math.round(value);
  if (column === "body_fat_pct") return Math.round(value * 10) / 10;
  return Math.round(value * 100) / 100;
}

// Precedence when folding an integration sample into an existing body_metrics row
// (the #120 metric_samples → body_metrics migration): an existing manual/document
// value wins; the sample only fills a gap. The equivalent of COALESCE(col, ?).
export function foldSampleIntoRow(
  existing: number | null,
  sample: number
): number {
  return existing ?? sample;
}

// Which measures a date already has on some existing body_metrics row.
export interface BodyMetricCoverage {
  weight_kg: boolean;
  body_fat_pct: boolean;
  resting_hr: boolean;
}

// True when a document's projected row would add a measure the date doesn't
// already have. A retrospective document still defers when it only repeats
// measures an existing row (manual / integration / another document) already
// carries — so it can't stack a duplicate weight point or outrank a manual entry
// — but a measure the date lacks (e.g. a document's weight for a day that only
// has an integration resting-HR row) is kept, not silently dropped.
export function documentRowAddsMetric(
  row: BodyMetricValues,
  covered: BodyMetricCoverage
): boolean {
  return (
    (row.weight_kg != null && !covered.weight_kg) ||
    (row.body_fat_pct != null && !covered.body_fat_pct) ||
    (row.resting_hr != null && !covered.resting_hr)
  );
}

// The projected rows a document should insert: those that add a measure the date
// doesn't already cover. `coverageFor` probes the existing body_metrics rows.
// Used by persistDocumentImport.
export function undeferredBodyMetrics<
  T extends BodyMetricValues & { date: string },
>(rows: T[], coverageFor: (date: string) => BodyMetricCoverage): T[] {
  return rows.filter((r) => documentRowAddsMetric(r, coverageFor(r.date)));
}
