// Latest-reading-with-trend (issue #1221, dashboard daily-loop): the ONE pure helper
// behind the Latest-vitals dashboard card — the most recent reading of a series plus a
// direction arrow versus the reading before it. No DB/clock: the gather (getBiomarkerSeries
// for BP, getBodyMetricDailySeries for resting HR) hands the {date,value} series here, so
// the card is a thin formatter over this result (#221). Marker-agnostic and unit-agnostic —
// callers pass already-canonical numbers.

export type TrendDirection = "up" | "down" | "flat";

export interface LatestTrend {
  date: string;
  value: number;
  // The reading immediately before the latest one, or null when the series has a
  // single reading.
  previousValue: number | null;
  // Direction of the latest reading versus the previous one; null with a single reading,
  // and null when the two readings share a DATE (#2303 — see below).
  direction: TrendDirection | null;
}

// The latest reading and its direction versus the prior reading. Expects the series
// ascending by date (as the series queries return); tolerates any order by taking the
// last two by position. Returns null for an empty series.
export function latestTrend(
  points: readonly { date: string; value: number }[]
): LatestTrend | null {
  if (points.length === 0) return null;
  const latest = points[points.length - 1];
  const prev = points.length >= 2 ? points[points.length - 2] : null;
  // A SAME-DAY pair is not a direction (#2303). Three sequential cuff readings from one
  // clinic visit share a date — ordinary clinical practice — and the two-point tail then
  // takes two of them, so the arrow claimed "up versus previous blood pressure" between
  // reading #3 and reading #2 of a single measurement. What is withdrawn is the
  // DIRECTION only: `previousValue` still reports the other reading, because the data is
  // real; the unsupported claim is that anything moved between them.
  //
  // The rule lives here, in the shared helper, rather than in the BP branch — it is
  // marker-agnostic like the rest of this module, and it fixes FRESH data too (three cuff
  // readings taken this morning produced the same fake arrow). Only the biomarker path can
  // reach it today: getLatestBodyMetricDailyPoints already folds to one point per date.
  const sameDay = prev != null && prev.date === latest.date;
  const direction: TrendDirection | null =
    prev == null || sameDay
      ? null
      : latest.value > prev.value
        ? "up"
        : latest.value < prev.value
          ? "down"
          : "flat";
  return {
    date: latest.date,
    value: latest.value,
    previousValue: prev ? prev.value : null,
    direction,
  };
}
