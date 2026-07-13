import type { NormBodyMetric } from "./normalize";

// Collapse a batch of normalized body-metric rows to AT MOST ONE row per date
// BEFORE the (profile_id, date, source) upsert (#605). The upsert merges each
// incoming row against the stored row one at a time ("a non-null incoming value
// wins"), which assumes at most one incoming row per date per batch. Only the Health
// Connect parser guarantees that (it pre-aggregates per day); Withings pushes one row
// per measure group and Oura one per long-sleep, both WITHOUT a per-date collapse or
// chronological sort — so which same-day reading "won" depended on the order the
// provider API happened to return them, and the 3-day re-scan flip-flopped the stored
// value every sync ("N changed" churn for zero new data).
//
// The fix folds at the chokepoint so every current and future provider is covered
// (one-question-one-computation): for each date, sort that date's readings by their
// `measured_at` instant ASCENDING (a stable sort keeps input order for rows without
// one — e.g. the pre-aggregated HC rows, which are already unique per date) and reduce
// with "the latest non-null value wins per field". That mirrors the HC parser's own
// byDate aggregation and makes the stored triple independent of the batch order.
//
// `partial_day` is a per-date property (the HC partial-window guard, #606), so it is
// carried through from any row in the group.
export function collapseBodyMetricsByDate(
  rows: NormBodyMetric[]
): NormBodyMetric[] {
  const byDate = new Map<string, NormBodyMetric[]>();
  const order: string[] = [];
  for (const r of rows) {
    let group = byDate.get(r.date);
    if (!group) {
      group = [];
      byDate.set(r.date, group);
      order.push(r.date);
    }
    group.push(r);
  }
  return order.map((date) => {
    const group = byDate.get(date)!;
    // Ascending by measured_at; V8's Array.sort is stable, so ties and rows without an
    // instant keep their arrival order. The reduce below then lets the last (latest)
    // non-null value win per field.
    const sorted = [...group].sort((a, b) => {
      const am = a.measured_at ?? "";
      const bm = b.measured_at ?? "";
      return am < bm ? -1 : am > bm ? 1 : 0;
    });
    const out: NormBodyMetric = { date };
    for (const r of sorted) {
      if (r.weight_kg != null) out.weight_kg = r.weight_kg;
      if (r.body_fat_pct != null) out.body_fat_pct = r.body_fat_pct;
      if (r.resting_hr != null) out.resting_hr = r.resting_hr;
      if (r.partial_day) out.partial_day = true;
    }
    return out;
  });
}
