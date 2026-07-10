import type { ExtractedResult } from "./medical-extract";
import { normalizeCanonicalKey } from "./canonical-name";
import { round } from "./units";

// Head (occipital-frontal) circumference has a single home in metric_samples
// (metric = 'head_circumference_cm'), NOT body_metrics or the biomarker
// vocabulary — that's where the pediatric head-circ-for-age growth curve reads
// from (getMetricDailyTotals(_, "head_circumference_cm")). So an imported "Head
// Circumference" vital needs its own recognizer + projection, EXACTLY parallel to
// the height arm in ./height-extract (which routes to metric_samples 'height_cm').
// Kept pure + unit-tested; the persist writer (lib/import-persist) is the only DB
// caller.

// Metric recognition matches on the same order-independent token key the
// canonical-name machinery uses, so spelling/punctuation variants match without
// hand-listing each one.
const keySet = (names: string[]) =>
  new Set(names.map((n) => normalizeCanonicalKey(n)));

// A person's head circumference only. The occipital-frontal circumference (OFC)
// has several portal spellings; the token-set key makes word order / punctuation
// irrelevant, so these cover the common variants.
const HEADCIRC_NAMES = keySet([
  "Head Circumference",
  "Occipital Frontal Circumference",
  "Head Occipital Frontal Circumference",
  "Head Occipital-frontal circumference by Tape measure",
  "OFC",
]);

// LOINC codes that denote a head (occipital-frontal) circumference MEASUREMENT,
// used when the import carries a LOINC (the deterministic CCD/FHIR path threads it
// onto each reading). The percentile code 8289-1 ("Head Occipital-frontal
// circumference Percentile") is DELIBERATELY excluded — it is a derived percentile,
// not a circumference measurement, and must never be projected as a cm value.
export const HEADCIRC_LOINCS = new Set([
  "8287-5", // Head Occipital-frontal circumference by Tape measure
  "9843-4", // Head circumference (alias)
]);

// Percentile LOINCs — a derived percentile is NEVER a cm measurement. Treated as
// an explicit negative (not just absence from HEADCIRC_LOINCS) so that a source
// which mislabels a percentile row with a measurement display name still can't be
// recognized as a measurement on the name path — it no longer relies solely on
// headCircToCm's unit/20–70 guard to reject it.
export const HEADCIRC_PERCENTILE_LOINCS = new Set([
  "8289-1", // Head Occipital-frontal circumference Percentile
]);

const CM_PER_IN = 2.54;
const CM_PER_M = 100;

// body_metrics/metric_samples dates must stay YYYY-MM-DD (string ordering + chart
// parsing rely on it); the AI's collected_date/document_date are only *asked* to
// be ISO, so re-validate.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function isoOrNull(s: string | null): string | null {
  return s && ISO_DATE.test(s) ? s : null;
}

// Convert a reported head circumference to canonical cm. Only explicitly
// recognized units are accepted (cm, in, m): a missing/unknown unit is genuinely
// ambiguous, so it is skipped rather than guessed. The 20–70 cm plausibility band
// spans a small preterm neonate up to a large adult head, and drops mis-unitted
// garbage (a value in mm, or one that slipped through the recognizer).
export function headCircToCm(
  value: number,
  unit: string | null
): number | null {
  const u = (unit ?? "").toLowerCase().replace(/[^a-z]/g, "");
  let cm: number;
  if (u === "cm" || u === "centimeter" || u === "centimeters") cm = value;
  else if (
    u === "in" ||
    u === "ini" || // UCUM international inch "[in_i]"
    u === "inch" ||
    u === "inches"
  )
    cm = value * CM_PER_IN;
  else if (u === "m" || u === "meter" || u === "meters") cm = value * CM_PER_M;
  else return null;
  return cm >= 20 && cm <= 70 ? round(cm, 1) : null;
}

// True when a reading is a head-circumference MEASUREMENT — by LOINC (preferred,
// when the import carries one) or by the order-independent name/canonical token
// key. The percentile code 8289-1 is not in HEADCIRC_LOINCS, so a percentile row
// is never recognized as a measurement.
export function isHeadCircReading(
  name: string | null | undefined,
  canonical: string | null | undefined,
  loinc?: string | null
): boolean {
  if (loinc && HEADCIRC_PERCENTILE_LOINCS.has(loinc)) return false;
  if (loinc && HEADCIRC_LOINCS.has(loinc)) return true;
  const keys = [
    normalizeCanonicalKey(canonical ?? ""),
    normalizeCanonicalKey(name ?? ""),
  ];
  return keys.some((k) => k !== "" && HEADCIRC_NAMES.has(k));
}

// A generic reading any import path can hand to the head-circ projection. `loinc`
// is optional — the deterministic CCD/FHIR path threads it; the AI path leaves it
// null and relies on name/canonical.
export interface HeadCircReading {
  name: string | null;
  canonical: string | null;
  value_num: number | null;
  unit: string | null;
  date: string | null;
  loinc?: string | null;
}

// One head-circumference sample derived from a document (per date).
export interface DocHeadCirc {
  date: string;
  head_circumference_cm: number;
}

// Fold readings into at most one head-circ sample per date (first plausible value
// wins on duplicates). Dates come from each reading, falling back to the document
// date; both must be ISO, and a reading with no real date is skipped — inventing a
// date would make an old scan's reading the newest everywhere. A reading whose
// value is rejected by headCircToCm's guards produces no sample (it stays a
// generic record — see withoutCapturedHeadCircs).
export function headCircsFromReadings(
  readings: HeadCircReading[],
  documentDate: string | null
): DocHeadCirc[] {
  const fallbackDate = isoOrNull(documentDate);
  const byDate = new Map<string, number>();
  for (const r of readings) {
    if (r.value_num == null) continue;
    if (!isHeadCircReading(r.name, r.canonical, r.loinc ?? null)) continue;
    const date = isoOrNull(r.date) ?? fallbackDate;
    if (!date) continue;
    const cm = headCircToCm(r.value_num, r.unit);
    if (cm == null) continue;
    if (!byDate.has(date)) byDate.set(date, cm); // first plausible value wins
  }
  return [...byDate.entries()]
    .map(([date, head_circumference_cm]) => ({ date, head_circumference_cm }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// AI-extraction adapter over headCircsFromReadings (dates from collected_date). The
// AI extractor carries no LOINC, so recognition here is by name/canonical only.
export function headCircsFromExtraction(
  results: ExtractedResult[],
  documentDate: string | null
): DocHeadCirc[] {
  return headCircsFromReadings(
    results.map((r) => ({
      name: r.name,
      canonical: r.canonical_name,
      value_num: r.value_num,
      unit: r.unit,
      date: r.collected_date,
      loinc: null,
    })),
    documentDate
  );
}
