// Deck's Health record pages (docs/device-api.md): one marker's whole story and one
// reading's series, each one read. The same gathers the clinical-result view and
// the Latest-vitals card use, projected to plain JSON: no Allos routes, no medical
// judgement beyond the flag and range the result already carries.

import {
  documentLabel,
  getBiomarkerSeriesWithDerived,
  getBiomarkerSeriesWithDerivedFor,
  getCanonicalResultDefinition,
  getClinicalObservations,
  getMedicalDocumentsByIds,
} from "@/lib/queries";
import { getLatestBodyMetricDailyPoints } from "@/lib/queries/metrics";
import { getBiomarkerSeries } from "@/lib/queries/medical/biomarkers";
import { getPanelSiblings } from "@/lib/queries/panel-siblings";
import { panelLabel } from "@/lib/biomarker-panels";
import { biomarkerFamily } from "@/lib/canonical-name";
import {
  optimalBand,
  parseReferenceRange,
  referenceRange,
} from "@/lib/reference-range";
import {
  getProfileAgeOn,
  getProfileReproductiveStatus,
  getProfileSex,
} from "@/lib/settings";
import type { BodyMetricKind, ClinicalObservation } from "@/lib/types";

const nameOf = (r: ClinicalObservation) => r.canonical_name?.trim() || r.name;

export interface MarkerPoint {
  date: string;
  value: number | null;
  text: string | null;
  unit: string | null;
  flag: string | null;
  document: { key: string; title: string } | null;
}

export interface MarkerDetail {
  name: string;
  latest: MarkerPoint;
  range: {
    low: number | null;
    high: number | null;
    text: string | null;
    source: "lab" | "standard";
  } | null;
  // The band the `non-optimal-*` flags judge against, in the definition's unit;
  // only the bound its direction reads (higher_better: low, lower_better: high).
  optimal: {
    low: number | null;
    high: number | null;
    unit: string | null;
  } | null;
  panel: string | null;
  provider: string | null;
  points: MarkerPoint[];
  documents: { key: string; title: string; date: string | null }[];
  related: {
    name: string;
    value: string | null;
    unit: string | null;
    flag: string | null;
    date: string;
  }[];
}

/**
 * One marker (a find row's `clinical-result:<name>`, matched case-insensitively on
 * its canonical name): every reading oldest first, its newest reading's range (the
 * lab's own reported range, else the standard one for the profile), its optimal
 * band for the profile (null when the definition has none), its source
 * documents and the panel's other current readings. Null when the profile has none.
 */
export function markerDetail(
  profileId: number,
  name: string
): MarkerDetail | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const current = getClinicalObservations(profileId, { current: true });
  const own = current.find((r) => nameOf(r).toLowerCase() === wanted);
  if (!own) return null;
  const canonical = nameOf(own);
  const series = getBiomarkerSeriesWithDerived(profileId, canonical);
  if (series.length === 0) return null;
  const docIds = [
    ...new Set(
      series.map((r) => r.document_id).filter((x): x is number => x != null)
    ),
  ];
  const docs = getMedicalDocumentsByIds(profileId, docIds);
  const docRef = new Map(
    docs.map((d) => [
      d.id,
      { key: `document:${d.id}`, title: documentLabel(d) },
    ])
  );
  const point = (r: ClinicalObservation): MarkerPoint => ({
    date: r.date,
    value: r.value_num,
    text: r.value,
    unit: r.unit,
    flag: r.flag,
    document:
      r.document_id != null ? (docRef.get(r.document_id) ?? null) : null,
  });
  const latest = series[series.length - 1];
  const definition = getCanonicalResultDefinition(canonical);
  const sex = getProfileSex(profileId);
  const age = getProfileAgeOn(profileId, latest.date);
  const reported = parseReferenceRange(latest.reference_range);
  let range: MarkerDetail["range"] = null;
  if (latest.reference_range?.trim())
    range = {
      low: reported?.low ?? null,
      high: reported?.high ?? null,
      text: latest.reference_range.trim(),
      source: "lab",
    };
  else {
    const standard = referenceRange(
      definition,
      sex,
      age,
      getProfileReproductiveStatus(profileId)
    );
    if (standard.low != null || standard.high != null)
      range = {
        low: standard.low,
        high: standard.high,
        text: null,
        source: "standard",
      };
  }
  const band = optimalBand(definition, sex, age);
  const optimalLow = definition?.direction === "lower_better" ? null : band.low;
  const optimalHigh =
    definition?.direction === "higher_better" ? null : band.high;
  const optimal =
    optimalLow != null || optimalHigh != null
      ? { low: optimalLow, high: optimalHigh, unit: definition?.unit ?? null }
      : null;
  const siblings = getPanelSiblings(profileId, canonical);
  const siblingNames = new Set(
    (siblings?.names ?? []).map((n) => n.toLowerCase())
  );
  const ownFamily = biomarkerFamily(canonical).toLowerCase();
  const related = siblings
    ? current
        .filter(
          (r) =>
            siblingNames.has(nameOf(r).toLowerCase()) &&
            biomarkerFamily(nameOf(r)).toLowerCase() !== ownFamily
        )
        .map((r) => ({
          name: nameOf(r),
          value: r.value,
          unit: r.unit,
          flag: r.flag,
          date: r.date,
        }))
        .filter(
          (r, i, all) =>
            all.findIndex(
              (o) => o.name.toLowerCase() === r.name.toLowerCase()
            ) === i
        )
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  return {
    name: canonical,
    latest: point(latest),
    range,
    optimal,
    panel: siblings ? panelLabel(siblings.panelId) : (latest.panel ?? null),
    provider: latest.provider_name ?? null,
    points: series.map(point),
    documents: docs
      .map((d) => ({
        key: `document:${d.id}`,
        title: documentLabel(d),
        date: d.document_date,
      }))
      .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? ""))),
    related,
  };
}

export const READING_KINDS = [
  "weight",
  "body_fat",
  "resting_hr",
  "blood_pressure",
] as const;
export type ReadingKind = (typeof READING_KINDS)[number];
const UNITS: Record<ReadingKind, string> = {
  weight: "kg",
  body_fat: "%",
  resting_hr: "bpm",
  blood_pressure: "mmHg",
};

export type ReadingPoint =
  | { date: string; value: number }
  | { date: string; systolic: number; diastolic: number };

/**
 * One reading's series, oldest first, over its `days` most recent days with data:
 * body metrics as the per-day source resolution the Latest-vitals card reads, blood
 * pressure as the day's systolic and diastolic pair (both on the same day).
 */
export function readingSeries(
  profileId: number,
  kind: ReadingKind,
  days: number
): { kind: ReadingKind; unit: string; points: ReadingPoint[] } {
  if (kind !== "blood_pressure") {
    const points = getLatestBodyMetricDailyPoints(
      profileId,
      kind as BodyMetricKind,
      days
    )
      .map((p) => ({ date: p.date, value: p.value }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return { kind, unit: UNITS[kind], points };
  }
  const byDay = (canonical: string) => {
    const out = new Map<string, number>();
    for (const r of getBiomarkerSeries(profileId, canonical))
      if (r.value_num != null) out.set(r.date, Math.round(r.value_num));
    return out;
  };
  const systolic = byDay("Blood Pressure Systolic");
  const diastolic = byDay("Blood Pressure Diastolic");
  const points = [...systolic.keys()]
    .filter((d) => diastolic.has(d))
    .sort()
    .slice(-days)
    .map((date) => ({
      date,
      systolic: systolic.get(date)!,
      diastolic: diastolic.get(date)!,
    }));
  return { kind, unit: UNITS[kind], points };
}

// How far back a Today tile's trend reaches: its series' last days with data
// (readings) or readings (labs).
export const TREND_DAYS = 30;
export const LAB_TREND_POINTS = 8;

/** Each marker's last LAB_TREND_POINTS numeric readings, oldest first, in one read. */
export function labTrends(
  profileId: number,
  names: readonly string[]
): Map<string, { date: string; value: number; unit: string | null }[]> {
  const series = getBiomarkerSeriesWithDerivedFor(profileId, names);
  return new Map(
    names.map((name) => [
      name,
      (series.get(name) ?? [])
        .filter((r) => r.value_num != null)
        .slice(-LAB_TREND_POINTS)
        .map((r) => ({ date: r.date, value: r.value_num!, unit: r.unit })),
    ])
  );
}
