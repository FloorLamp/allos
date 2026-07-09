import type { ExtractedResult } from "./medical-extract";
import { normalizeCanonicalKey } from "./canonical-name";
import { round } from "./units";

// Height has a single home in metric_samples (metric = 'height_cm'), NOT
// body_metrics — that's where the growth charts' stature/height-for-age + BMI
// curves and the height readout read from (getMetricDailyTotals(_, "height_cm"),
// getLatestMetricValue). So an imported "Body Height" vital needs its own
// recognizer + projection, parallel to the weight arm in ./body-metric-extract
// (which routes to body_metrics). Kept pure + unit-tested; the persist writer
// (lib/import-persist) is the only DB caller. (#167)

// Metric recognition matches on the same order-independent token key the
// canonical-name machinery uses, so spelling/punctuation variants match without
// hand-listing each one.
const keySet = (names: string[]) =>
  new Set(names.map((n) => normalizeCanonicalKey(n)));

// A person's stature/length only — a DEXA regional/segment length ("Arm Length")
// has a different token set, so it can't be mistaken for body height.
const HEIGHT_NAMES = keySet([
  "Height",
  "Body Height",
  "Stature",
  "Standing Height",
  "Body Length",
]);

// LOINC codes that denote a person's height/length, used when the import carries
// a LOINC (the deterministic CCD/FHIR path threads it onto each reading). Only
// whole-body height/length codes — regional/segment lengths are excluded.
export const HEIGHT_LOINCS = new Set([
  "8302-2", // Body height
  "3137-7", // Body height, Measured
  "8306-3", // Body height, Lying (i.e. body length)
  "8308-9", // Body height, Standing
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

// Convert a reported height to canonical cm. Only explicitly recognized units are
// accepted (cm, in, m): a missing/unknown unit is genuinely ambiguous — a
// unit-less "70" is inches in a US portal but 70 cm elsewhere, and the 30–260 cm
// plausibility band can't tell — so an ambiguous reading is skipped rather than
// guessed. The band still drops mis-unitted garbage (a height in mm, or a value
// that slipped through the recognizer).
export function heightToCm(value: number, unit: string | null): number | null {
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
  return cm >= 30 && cm <= 260 ? round(cm, 1) : null;
}

// True when a reading is a body-height measurement — by LOINC (preferred, when
// the import carries one) or by the order-independent name/canonical token key.
export function isHeightReading(
  name: string | null | undefined,
  canonical: string | null | undefined,
  loinc?: string | null
): boolean {
  if (loinc && HEIGHT_LOINCS.has(loinc)) return true;
  const keys = [
    normalizeCanonicalKey(canonical ?? ""),
    normalizeCanonicalKey(name ?? ""),
  ];
  return keys.some((k) => k !== "" && HEIGHT_NAMES.has(k));
}

// A generic reading any import path can hand to the height projection. `loinc` is
// optional — the deterministic CCD/FHIR path threads it; the AI path leaves it
// null and relies on name/canonical.
export interface HeightReading {
  name: string | null;
  canonical: string | null;
  value_num: number | null;
  unit: string | null;
  date: string | null;
  loinc?: string | null;
}

// One height sample derived from a document (per date).
export interface DocHeight {
  date: string;
  height_cm: number;
}

// Fold readings into at most one height sample per date (first plausible value
// wins on duplicates). Dates come from each reading, falling back to the document
// date; both must be ISO, and a reading with no real date is skipped — inventing a
// date would make an old scan's height the newest reading everywhere. A reading
// whose value is rejected by heightToCm's guards produces no sample (it stays a
// generic record — see withoutCapturedHeights).
export function heightsFromReadings(
  readings: HeightReading[],
  documentDate: string | null
): DocHeight[] {
  const fallbackDate = isoOrNull(documentDate);
  const byDate = new Map<string, number>();
  for (const r of readings) {
    if (r.value_num == null) continue;
    if (!isHeightReading(r.name, r.canonical, r.loinc ?? null)) continue;
    const date = isoOrNull(r.date) ?? fallbackDate;
    if (!date) continue;
    const cm = heightToCm(r.value_num, r.unit);
    if (cm == null) continue;
    if (!byDate.has(date)) byDate.set(date, cm); // first plausible value wins
  }
  return [...byDate.entries()]
    .map(([date, height_cm]) => ({ date, height_cm }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// AI-extraction adapter over heightsFromReadings (dates from collected_date). The
// AI extractor carries no LOINC, so recognition here is by name/canonical only.
export function heightsFromExtraction(
  results: ExtractedResult[],
  documentDate: string | null
): DocHeight[] {
  return heightsFromReadings(
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
