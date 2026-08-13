// The three MEASURES one `body_metrics` row carries (issue #2556).
//
// `body_metrics` is the WIDE store: one row per (profile, day), up to three readings
// on it. The Trends → Body history table renders exactly those three columns, and
// until now the only thing it offered per row was a whole-row delete — so a mistyped
// weight could be removed but never corrected, and correcting it removed the day's
// body fat and resting HR with it.
//
// The fix is NOT a new write path. `updateReadingAt`/`deleteReadingAt`
// (lib/reading-writes.ts) already own the ONE editability contract, keyed by
// `ReadingTarget`, and `app/(app)/trends/reading-actions.ts` already gates them with
// the unit conversion at the boundary. What the table lacked was the ability to NAME
// one of its cells to that contract. This module is that naming, and nothing else:
// a row plus the login's weight unit in, one target token per PRESENT measure out.
//
// TWO FIELDS, TWO QUESTIONS, exactly as the action documents. `column` (via the
// target token) is the ROW — which of the three cells is written. `slug` is the PAGE
// — which display unit the action converts back from and which routes it revalidates.
// A `body_metrics` measure is the one place they are declared together, so the map
// below is pinned against `METRIC_READING_STORE` by
// lib/__db_tests__/body-metric-measures.test.ts rather than being a fourth registry
// free to drift.
//
// PURE: no DB, no React. `readingTargetToken` and `TREND_METRIC_META` are both
// import-light, so a client component can build a menu from this directly.

import { readingTargetToken } from "./reading-placement";
import type { BodyMetricColumn } from "./reading-identity-map";
import { TREND_METRIC_META, type TrendMetricSlug } from "./trend-metrics";
import { dispWeight, round } from "./units";
import type { WeightUnit } from "./settings";

/**
 * The metric SURFACE each `body_metrics` column belongs to — the `kind` the reading
 * actions take. Exhaustive over `BodyMetricColumn` by type, so a fourth measure
 * column cannot be added without answering this.
 */
export const BODY_METRIC_MEASURE_SLUG: Record<
  BodyMetricColumn,
  TrendMetricSlug
> = {
  weight_kg: "weight",
  body_fat_pct: "body-fat",
  resting_hr: "resting-hr",
};

/** The order the history table renders its measure columns in. */
export const BODY_METRIC_COLUMNS: readonly BodyMetricColumn[] = [
  "weight_kg",
  "body_fat_pct",
  "resting_hr",
];

/** One editable cell of a body-metrics history row. */
export interface BodyMetricMeasure {
  column: BodyMetricColumn;
  /** The metric page whose unit and routes the write is judged against. */
  slug: TrendMetricSlug;
  /** "Weight" / "Body Fat" / "Resting Heart Rate". */
  label: string;
  /** The wire target `body_metrics:<id>:<column>` the action parses. */
  target: string;
  /** The value in the login's DISPLAY unit — what the edit field opens with. */
  value: number;
  /** The display-unit suffix, already spaced ("" / "%" / " bpm" / " kg"). */
  unit: string;
  /** Decimal places this measure is entered at. */
  decimals: number;
}

/** The stored value one column holds on a row, or null when that cell is empty. */
export interface BodyMetricRow {
  id: number;
  weight_kg: number | null;
  body_fat_pct: number | null;
  resting_hr: number | null;
}

function storedValue(row: BodyMetricRow, column: BodyMetricColumn) {
  switch (column) {
    case "weight_kg":
      return row.weight_kg;
    case "body_fat_pct":
      return row.body_fat_pct;
    case "resting_hr":
      return row.resting_hr;
  }
}

/**
 * The measures a row actually HAS, in column order.
 *
 * Renders from state, per the stateful-affordance rule: an absent cell yields no
 * measure, so the row's menu can only ever offer to correct a reading that exists.
 * Weight converts to the login's unit here — the same `dispWeight` the table's own
 * cell and the metric detail page's edit field use, so the number in the dialog is
 * the number on the row, and the action converts it back with `toKg`.
 */
export function bodyMetricMeasures(
  row: BodyMetricRow,
  weightUnit: WeightUnit
): BodyMetricMeasure[] {
  return BODY_METRIC_COLUMNS.flatMap((column) => {
    const stored = storedValue(row, column);
    if (stored == null) return [];
    const slug = BODY_METRIC_MEASURE_SLUG[column];
    const meta = TREND_METRIC_META[slug];
    return [
      {
        column,
        slug,
        label: meta.title,
        target: readingTargetToken({
          store: "body_metrics",
          id: row.id,
          column,
        }),
        value: meta.weightUnit
          ? dispWeight(stored, weightUnit, meta.decimals)
          : round(stored, meta.decimals),
        unit: meta.weightUnit ? ` ${weightUnit}` : meta.unit,
        decimals: meta.decimals,
      },
    ];
  });
}
