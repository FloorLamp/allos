import {
  getCanonicalResultDefinition,
  getClinicalObservations,
  getRankedBiomarkerOptions,
} from "@/lib/queries";
import { biomarkerPlots } from "@/lib/queries/biomarker-plot";
import { biomarkerFamily } from "@/lib/canonical-name";
import {
  getProfileSex,
  getProfileAgeOn,
  getProfileReproductiveStatus,
} from "@/lib/settings";
import { referenceRange } from "@/lib/reference-range";
import { isBiomarkerGoalTargetable } from "@/lib/biomarker-goal";
import { seriesPickerOptions } from "@/lib/series-picker-options";
import { BIOMARKER_GROUP_LABELS } from "@/lib/biomarker-rank";
import { storedLabUnit } from "@/lib/display-unit";

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
  // WHERE A GOAL ON THIS ANALYTE WOULD START FROM (#3220): the latest point of the
  // analyte's OWN plot, in `latestUnit` — the very value `createGoal` will store as
  // `baseline_value` and the value the goal card will read progress against. Null
  // when the profile has no reading yet, which is the common case for most of the
  // vocabulary and which the goal row states by saying nothing.
  //
  // NOT the analyte's canonical `unit` above, and the difference is not cosmetic: a
  // plot falls back to the latest reading's own unit when the analyte has no
  // canonical one, so a chip that borrowed `unit` could state a number beside a unit
  // it was never measured in.
  latest: number | null;
  latestUnit: string | null;
}

export function getGoalBiomarkerOptions(
  profileId: number,
  today: string
): GoalBiomarkerOption[] {
  // MEMBERSHIP: everything the pickers offer EXCEPT the three analytes that are
  // really body metrics. Weight, body fat and resting HR already have a goal path
  // (`goals.body_metric`, unchanged by #1853) that reads the one-source-per-day body
  // series and stores canonical kg; offering them here as well would give one
  // question two answers and two storage shapes. The predicate is
  // `isBiomarkerGoalTargetable`, shared with the write action so the picker and the
  // form post agree about what a valid target is.
  const sex = getProfileSex(profileId);
  const age = getProfileAgeOn(profileId, today);
  const status = getProfileReproductiveStatus(profileId);

  const ranked = getRankedBiomarkerOptions(profileId, today).filter((option) =>
    isBiomarkerGoalTargetable(option.name)
  );
  const rows = seriesPickerOptions(
    ranked.map((option) => ({
      key: option.name,
      label: option.name,
      kind: "biomarker" as const,
      group: option.group,
    }))
  );
  // THE STARTING POINT, batched and BOUNDED (#3220). `biomarkerPlots` takes the whole
  // batch in one series query (#1961), but shaping is still per analyte and this list
  // is the entire targetable vocabulary — so the batch is narrowed to the analytes
  // this profile has actually measured. Everything else has no reading by definition
  // and its plot would be null.
  //
  // Narrowed by #482 FAMILY rather than by exact name, because that is the identity a
  // plot gathers on: a profile whose rows say "HbA1c" has measured the option spelled
  // "Hemoglobin A1c", and an exact-name filter would report it as never measured.
  const measuredFamilies = new Set(
    getClinicalObservations(profileId, { current: true }).map((row) =>
      biomarkerFamily(row.canonical_name?.trim() || row.name).toLowerCase()
    )
  );
  const plots = biomarkerPlots(
    profileId,
    rows
      .map((row) => row.key)
      .filter((name) =>
        measuredFamilies.has(biomarkerFamily(name).toLowerCase())
      )
  );
  return rows.map((row) => {
    const cb = getCanonicalResultDefinition(row.key);
    const ref = cb ? referenceRange(cb, sex, age, status) : null;
    const plot = plots.get(row.key) ?? null;
    const latest = plot?.points.at(-1) ?? null;
    return {
      name: row.key,
      label: row.label,
      group: row.group,
      unit: storedLabUnit(cb?.unit) ?? null,
      low: ref?.low ?? null,
      high: ref?.high ?? null,
      latest: latest?.value ?? null,
      latestUnit: latest ? (storedLabUnit(plot?.unit) ?? null) : null,
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
