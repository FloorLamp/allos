// Cross-store compatibility seam for logical body outcomes. Current imports keep
// these measurements in body_metrics, while older databases may still contain
// equivalent medical_records rows. The reconciled body_metrics series is
// authoritative; a valid legacy reading fills only a date that series lacks.

import { bodyMetricsFromReadings } from "../body-metric-extract";
import { bodyMetricKindForBiomarker } from "../outcome-identity";
import type { BodyMetricKind, ClinicalObservation } from "../types";
import { getBiomarkerSeries, getUsedCanonicalNames } from "./medical";
import { getBodyMetricDailySeries } from "./metrics";

const ALL_ROWS = -1;

export function getLogicalBodyMetricDailySeries(
  profileId: number,
  metric: BodyMetricKind,
  limit = 365
): { date: string; value: number }[] {
  const authoritative = getBodyMetricDailySeries(profileId, metric, ALL_ROWS);
  const byDate = new Map(
    authoritative.map((point) => [point.date, point.value])
  );

  const legacyById = new Map<number, ClinicalObservation>();
  for (const canonical of getUsedCanonicalNames(profileId)) {
    if (bodyMetricKindForBiomarker(canonical) !== metric) continue;
    for (const row of getBiomarkerSeries(profileId, canonical)) {
      legacyById.set(row.id, row);
    }
  }

  // bodyMetricsFromReadings keeps the first valid value on a date. Newer row ids
  // win among legacy duplicates, while body_metrics still wins over every legacy
  // row through the has() check below.
  const legacyRows = [...legacyById.values()].sort(
    (a, b) => b.date.localeCompare(a.date) || b.id - a.id
  );
  const projected = bodyMetricsFromReadings(
    legacyRows.map((row) => ({
      name: row.name,
      canonical: row.canonical_name,
      value_num: row.value_num,
      unit: row.unit,
      date: row.date,
    })),
    null
  );
  for (const row of projected) {
    if (byDate.has(row.date)) continue;
    const value =
      metric === "weight"
        ? row.weight_kg
        : metric === "body_fat"
          ? row.body_fat_pct
          : row.resting_hr;
    if (value != null) byDate.set(row.date, value);
  }

  const merged = [...byDate.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (limit < 0) return merged;
  if (limit === 0) return [];
  return merged.slice(-limit);
}
