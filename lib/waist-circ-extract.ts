import type { ExtractedResult } from "./medical-extract";
import { normalizeCanonicalKey } from "./canonical-name";
import { round } from "./units";

// Waist circumference has a single home in metric_samples (metric =
// 'waist_circumference_cm'), NOT body_metrics and NOT the biomarker vocabulary —
// the owner's ruling on #2322 made it a `TrendMetricSlug` (`waist-circ`) rather than
// a curated canonical entry, for the reason #1850 made peak flow one: it is
// self-measured with a tape at the metric cadence, and "what is this doing lately?"
// is the only useful question about it. Curating it as a biomarker would have been
// the `Body Mass Index (BMI)` mistake a second time — a body metric imported as a
// biomarker — which #2318 spent a whole issue undoing.
//
// So an imported "Waist Circumference" vital needs its own recognizer + projection,
// EXACTLY parallel to the height and head-circumference arms in ./height-extract and
// ./head-circ-extract (both of which route to metric_samples length metrics). That
// projection is also what earns the slug its `import-projection` declaration in
// METRIC_DOCUMENT_REACH (lib/trend-metric-analytes.ts): without it the slug would
// claim the analyte name and remove the reading from the only surface that showed
// it. Kept pure + unit-tested; the persist writer (lib/import-persist) is the only
// DB caller.

// Metric recognition matches on the same order-independent token key the
// canonical-name machinery uses, so spelling/punctuation variants match without
// hand-listing each one.
const keySet = (names: string[]) =>
  new Set(names.map((n) => normalizeCanonicalKey(n)));

// A person's waist circumference only. The token-set key makes word order and
// punctuation irrelevant, so these cover the common portal spellings.
//
// DELIBERATELY ABSENT, each for a stated reason:
//   • bare "Waist" — a DEXA region label as often as a tape measurement, and this
//     module's whole safety argument is that recognition is exact rather than loose;
//   • "Abdominal Circumference" — the obstetric ultrasound's FETAL measurement uses
//     that name, and it is not the subject's waist;
//   • "Waist-Hip Ratio" — a ratio is not a length (see WAIST_RATIO_LOINCS below).
const WAIST_NAMES = keySet([
  "Waist Circumference",
  "Waist Circumference at Umbilicus",
  "Waist Circumference at Umbilicus by Tape Measure",
  "Waist Girth",
]);

// LOINC codes that denote a waist circumference MEASUREMENT, used when the import
// carries a LOINC (the deterministic CCD/FHIR path threads it onto each reading).
export const WAIST_LOINCS = new Set([
  "8280-0", // Waist Circumference at umbilicus by Tape measure
  "56086-2", // Waist Circumference
  "56115-9", // Waist Circumference by NHANES
]);

// Waist-to-hip RATIO codes — a unitless ratio, never a cm measurement. Treated as an
// explicit negative (not merely absence from WAIST_LOINCS) for the same reason the
// head-circ percentile codes are: a source that mislabels a ratio row with a
// measurement display name must still be rejected on the name path, rather than
// relying solely on waistCircToCm's unit/plausibility guard to catch it.
export const WAIST_RATIO_LOINCS = new Set([
  "60803-4", // Waist/Hip circumference ratio
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

// Convert a reported waist circumference to canonical cm. Only explicitly recognized
// units are accepted (cm, in, m): a missing/unknown unit is genuinely ambiguous — an
// unlabelled "34" is inches in a US portal and 34 cm nowhere plausible for an adult —
// so it is skipped rather than guessed. The 30–200 cm plausibility band spans a small
// child up to the largest recorded adult waist, and drops mis-unitted garbage (a
// value in mm, or a waist-to-hip RATIO that slipped through the recognizer).
export function waistCircToCm(
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
  return cm >= 30 && cm <= 200 ? round(cm, 1) : null;
}

// True when a reading is a waist-circumference MEASUREMENT — by LOINC (preferred,
// when the import carries one) or by the order-independent name/canonical token key.
export function isWaistCircReading(
  name: string | null | undefined,
  canonical: string | null | undefined,
  loinc?: string | null
): boolean {
  if (loinc && WAIST_RATIO_LOINCS.has(loinc)) return false;
  if (loinc && WAIST_LOINCS.has(loinc)) return true;
  const keys = [
    normalizeCanonicalKey(canonical ?? ""),
    normalizeCanonicalKey(name ?? ""),
  ];
  return keys.some((k) => k !== "" && WAIST_NAMES.has(k));
}

// A generic reading any import path can hand to the waist projection. `loinc` is
// optional — the deterministic CCD/FHIR path threads it; the AI path leaves it null
// and relies on name/canonical.
export interface WaistCircReading {
  name: string | null;
  canonical: string | null;
  value_num: number | null;
  unit: string | null;
  date: string | null;
  loinc?: string | null;
}

// One waist-circumference sample derived from a document (per date).
export interface DocWaistCirc {
  date: string;
  waist_circumference_cm: number;
}

// Fold readings into at most one waist sample per date (first plausible value wins on
// duplicates). Dates come from each reading, falling back to the document date; both
// must be ISO, and a reading with no real date is skipped — inventing a date would
// make an old scan's reading the newest everywhere. A reading whose value is rejected
// by waistCircToCm's guards produces no sample (it stays a generic record — see
// withoutCapturedWaistCircs).
export function waistCircsFromReadings(
  readings: WaistCircReading[],
  documentDate: string | null
): DocWaistCirc[] {
  const fallbackDate = isoOrNull(documentDate);
  const byDate = new Map<string, number>();
  for (const r of readings) {
    if (r.value_num == null) continue;
    if (!isWaistCircReading(r.name, r.canonical, r.loinc ?? null)) continue;
    const date = isoOrNull(r.date) ?? fallbackDate;
    if (!date) continue;
    const cm = waistCircToCm(r.value_num, r.unit);
    if (cm == null) continue;
    if (!byDate.has(date)) byDate.set(date, cm); // first plausible value wins
  }
  return [...byDate.entries()]
    .map(([date, waist_circumference_cm]) => ({
      date,
      waist_circumference_cm,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// AI-extraction adapter over waistCircsFromReadings (dates from collected_date). The
// AI extractor carries no LOINC, so recognition here is by name/canonical only.
export function waistCircsFromExtraction(
  results: ExtractedResult[],
  documentDate: string | null
): DocWaistCirc[] {
  return waistCircsFromReadings(
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

/** The `metric_samples` metric key waist-circumference readings live under. */
export const WAIST_CIRC_METRIC = "waist_circumference_cm";
