// The Trends series pickers' option list (#1675). Pure: `listCompareOptions` supplies
// the metric rows and the ALREADY-RANKED biomarker rows (lib/queries/biomarker-options
// over the lib/biomarker-rank tenant), and this module owns the two remaining picker
// questions — which dropdown header each row sits under, and what a row is CALLED once
// two rows would otherwise read identically.
//
// Two surfaces consume it (SaveTrendPicker's ★ add-entry and CompareControls' A/B
// pickers) and they must agree, because both write the same series-key vocabulary and
// a user moving between them should not have to relearn the order (#221).

import {
  BIOMARKER_GROUP_LABELS,
  type BiomarkerPickerGroup,
} from "./biomarker-rank";

// Metrics keep the header they have had since the picker was a `<select>` with two
// optgroups. Renaming it would be a second change riding a reordering one.
export const SERIES_PICKER_METRICS_GROUP = "Metrics";

// Header order in the empty-query relevance view. A retest-due or flagged analyte
// leads — that is the whole point of #1675 — but the standard metrics stay ahead of
// the ordinary biomarker body, because they are the picker's known head (they are the
// only way back after unstarring a metric tile) and burying them under ~200 analytes
// would trade one lost-in-the-list problem for another.
export const SERIES_PICKER_GROUP_ORDER: readonly string[] = [
  BIOMARKER_GROUP_LABELS["due-relevant"],
  SERIES_PICKER_METRICS_GROUP,
  BIOMARKER_GROUP_LABELS["your-markers"],
  BIOMARKER_GROUP_LABELS["all-biomarkers"],
];

export interface SeriesPickerInput {
  key: string;
  label: string;
  kind: "metric" | "biomarker";
  // Absent for metrics, and for a biomarker list that was never ranked.
  group?: BiomarkerPickerGroup;
}

export interface SeriesPickerOption {
  // The series key the form posts / the URL param carries.
  key: string;
  // What the row shows and what the fuzzy search matches. Unique across the list.
  label: string;
  // The dropdown header this row sits under.
  group: string;
}

function groupLabel(row: SeriesPickerInput): string {
  if (row.kind === "metric") return SERIES_PICKER_METRICS_GROUP;
  return BIOMARKER_GROUP_LABELS[row.group ?? "all-biomarkers"];
}

// Build the picker rows. Input order is preserved WITHIN each group, so the ranked
// biomarker order the query layer computed survives; only the group split reorders.
//
// Labels are disambiguated (#531): a combobox picks by label, so two rows that read
// the same are two rows the user cannot choose between. The kind is the attribute that
// actually distinguishes a "Weight" metric from a "Weight" analyte; a collision that
// survives even that falls back to the key, which is unique by construction.
export function seriesPickerOptions(
  rows: readonly SeriesPickerInput[]
): SeriesPickerOption[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.label.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const used = new Set<string>();
  const built = rows.map((row) => {
    let label = row.label;
    if ((counts.get(row.label.toLowerCase()) ?? 0) > 1) {
      label = `${row.label} (${row.kind})`;
    }
    if (used.has(label.toLowerCase())) label = `${row.label} (${row.key})`;
    used.add(label.toLowerCase());
    return { key: row.key, label, group: groupLabel(row) };
  });

  const rank = new Map(SERIES_PICKER_GROUP_ORDER.map((g, i) => [g, i]));
  return built
    .map((option, index) => ({ option, index }))
    .sort(
      (a, b) =>
        (rank.get(a.option.group) ?? SERIES_PICKER_GROUP_ORDER.length) -
          (rank.get(b.option.group) ?? SERIES_PICKER_GROUP_ORDER.length) ||
        a.index - b.index
    )
    .map(({ option }) => option);
}
