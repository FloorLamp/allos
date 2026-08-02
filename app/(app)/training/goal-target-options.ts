import {
  getCanonicalBiomarker,
  getRankedBiomarkerOptions,
} from "@/lib/queries";
import {
  getUserSex,
  getUserAgeOn,
  getUserReproductiveStatus,
} from "@/lib/settings";
import { referenceRange } from "@/lib/reference-range";
import { bodyMetricKindForBiomarker } from "@/lib/outcome-identity";
import { seriesPickerOptions } from "@/lib/series-picker-options";
import { BIOMARKER_GROUP_LABELS } from "@/lib/biomarker-rank";

// The analyte options the goal form's target picker offers (#1853).
//
// This is COMPOSITION, not a new ranker or a second picker-options module. It is the
// same two calls every other biomarker picker makes since #1675/#1910 —
// `getRankedBiomarkerOptions` for the relevance order and `seriesPickerOptions` for
// the group headers and label disambiguation — so a user who has learned the order on
// Trends Compare or the ★ picker meets the identical order here. The one thing that
// differs is MEMBERSHIP, below, and that is a product boundary rather than a ranking.

export interface GoalBiomarkerOption {
  // The canonical analyte name the form posts and the goal stores.
  name: string;
  // What the row shows and what the fuzzy search matches. Unique across the list.
  label: string;
  // The dropdown header this row sits under ("Due or flagged" → … → "All biomarkers").
  group: string;
  // The analyte's canonical unit, for the target input's suffix. The unit actually
  // STORED is resolved server-side at write time from the analyte's own plot
  // (biomarkerTargetUnit) — this is the label, not the contract.
  unit: string | null;
  // The effective reference range for this profile's sex/age, when the analyte has
  // one. Shown as a hint so the number a user types is informed by the thresholds
  // the app already holds, rather than typed blind next to them.
  low: number | null;
  high: number | null;
}

export function getGoalBiomarkerOptions(
  profileId: number,
  today: string
): GoalBiomarkerOption[] {
  // MEMBERSHIP: everything the pickers offer EXCEPT the three analytes that are
  // really body metrics. Weight, body fat and resting HR already have a goal path
  // (`goals.body_metric`, unchanged by #1853) that reads the one-source-per-day body
  // series and stores canonical kg; offering them here as well would give one
  // question two answers and two storage shapes. The boundary is drawn by
  // `bodyMetricKindForBiomarker`, the SAME function `listCompareOptions` already uses
  // to split the two vocabularies — not by a hand-written exclusion list.
  const sex = getUserSex(profileId);
  const age = getUserAgeOn(profileId, today);
  const status = getUserReproductiveStatus(profileId);

  const ranked = getRankedBiomarkerOptions(profileId, today).filter(
    (option) => bodyMetricKindForBiomarker(option.name) == null
  );
  const rows = seriesPickerOptions(
    ranked.map((option) => ({
      key: option.name,
      label: option.name,
      kind: "biomarker" as const,
      group: option.group,
    }))
  );
  return rows.map((row) => {
    const cb = getCanonicalBiomarker(row.key);
    const ref = cb ? referenceRange(cb, sex, age, status) : null;
    return {
      name: row.key,
      label: row.label,
      group: row.group,
      unit: cb?.unit ?? null,
      low: ref?.low ?? null,
      high: ref?.high ?? null,
    };
  });
}

// The group headers this picker can render, in order. Metrics never appear (this
// picker offers no metric rows), so the order is the biomarker-only projection of
// SERIES_PICKER_GROUP_ORDER — same names, same sequence.
export const GOAL_BIOMARKER_GROUP_ORDER: readonly string[] = [
  BIOMARKER_GROUP_LABELS["due-relevant"],
  BIOMARKER_GROUP_LABELS["your-markers"],
  BIOMARKER_GROUP_LABELS["all-biomarkers"],
];
