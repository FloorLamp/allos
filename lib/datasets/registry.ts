// Curated-dataset framework — the registry (issue #860 Track B).
//
// The single list of datasets that have been MIGRATED onto the framework. The linter
// (lib/__tests__/datasets-framework.test.ts) walks this registry and enforces the
// contract (citation present, identity resolves, refusal gate holds) on every entry,
// and cross-checks it against the JSON files under lib/datasets/data/. Migrating a
// dataset = add its loaded dataset + primary strategy here (a thin adoption).
//
// SCOPE: this registry lists ONLY framework datasets. The ~21 not-yet-migrated
// datasets under lib/*.json keep their bespoke shape and are intentionally NOT here
// (and NOT under lib/datasets/data/), so the linter doesn't retroactively fail them.
// Each migrates in its own small PR.

import {
  allergenCrossReactivityDataset,
  allergenFamilyStrategy,
} from "./allergen-cross-reactivity";
import { biomarkerDescriptionsDataset } from "./biomarker-descriptions";
import { canonicalBiomarkersDataset } from "./canonical-biomarkers";
import {
  bpPercentilesDataset,
  bpPercentileKeyStrategy,
} from "./bp-percentiles";
import {
  conditionTrainingConsiderationsDataset,
  conditionConsiderationKeyStrategy,
} from "./condition-training-considerations";
import { contrastDataset, contrastClassStrategy } from "./contrast-safety";
import { dentalSafetyDataset, dentalKeyStrategy } from "./dental-safety";
import { driDataset, driNutrientStrategy } from "./dri";
import { drugAllergyDataset, drugAllergyKeyStrategy } from "./drug-allergy";
import {
  drugInteractionsDataset,
  drugInteractionPairStrategy,
} from "./drug-interactions";
import { fitnessNormsDataset, fitnessNormNameStrategy } from "./fitness-norms";
import {
  foodDrugInteractionsDataset,
  foodDrugKeyStrategy,
} from "./food-drug-interactions";
import { foodGroupsDataset } from "./food-groups";
import { growthChartsDataset, growthChartNameStrategy } from "./growth-charts";
import { icd10Dataset, icd10CodeStrategy } from "./icd10-common";
import {
  illnessThresholdsDataset,
  illnessThresholdSlugStrategy,
} from "./illness-thresholds";
import {
  medicationDescriptionsDataset,
  medDescriptionsStrategy,
} from "./medication-descriptions";
import {
  medMonitoringDataset,
  medMonitoringKeyStrategy,
} from "./medication-monitoring";
import { metsDataset } from "./mets";
import { mobilityMovesDataset } from "./mobility-moves";
import {
  nutrientFoodMapDataset,
  nutrientKeyStrategy,
} from "./nutrient-food-map";
import { ototoxicDataset, ototoxicKeyStrategy } from "./ototoxic";
import { pgxDataset, pgxGuidanceStrategy } from "./pgx";
import { prnDefaultsDataset, prnDefaultSlugStrategy } from "./prn-defaults";
import {
  radiationDoseDataset,
  radiationDoseKeyStrategy,
} from "./radiation-dose";
import { screeningsDataset, screeningKeyStrategy } from "./screenings";
import {
  strengthStandardsDataset,
  strengthStandardNameStrategy,
} from "./strength-standards";
import {
  tempRedFlagsDataset,
  tempRedFlagKeyStrategy,
} from "./temperature-red-flags";
import { nameStrategy, slugStrategy } from "./matcher";
import type { LoadedDataset, MatchStrategy } from "./types";

// A registry row: the loaded dataset plus the primary strategy its consumers use to
// resolve identity (so the harness can assert identity-resolves / refusal-gate with
// the same strategy the app relies on).
export interface RegisteredDataset {
  // Loaded (validated) dataset. Typed loosely here so heterogeneous datasets share
  // one list; per-dataset modules keep their precise types.
  dataset: LoadedDataset<Record<string, unknown>, unknown>;
  strategy: MatchStrategy;
}

export const DATASETS: RegisteredDataset[] = [
  {
    dataset: allergenCrossReactivityDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: allergenFamilyStrategy,
  },
  {
    dataset: biomarkerDescriptionsDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: nameStrategy,
  },
  {
    dataset: canonicalBiomarkersDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: nameStrategy,
  },
  {
    dataset: bpPercentilesDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: bpPercentileKeyStrategy,
  },
  {
    dataset: conditionTrainingConsiderationsDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: conditionConsiderationKeyStrategy,
  },
  {
    dataset: contrastDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: contrastClassStrategy,
  },
  {
    dataset: dentalSafetyDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: dentalKeyStrategy,
  },
  {
    dataset: driDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: driNutrientStrategy,
  },
  {
    dataset: drugAllergyDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: drugAllergyKeyStrategy,
  },
  {
    dataset: drugInteractionsDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: drugInteractionPairStrategy,
  },
  {
    dataset: fitnessNormsDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: fitnessNormNameStrategy,
  },
  {
    dataset: foodDrugInteractionsDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: foodDrugKeyStrategy,
  },
  {
    dataset: foodGroupsDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: slugStrategy,
  },
  {
    dataset: growthChartsDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: growthChartNameStrategy,
  },
  {
    dataset: icd10Dataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: icd10CodeStrategy,
  },
  {
    dataset: illnessThresholdsDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: illnessThresholdSlugStrategy,
  },
  {
    dataset: medicationDescriptionsDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: medDescriptionsStrategy,
  },
  {
    dataset: medMonitoringDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: medMonitoringKeyStrategy,
  },
  {
    dataset: metsDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: nameStrategy,
  },
  {
    dataset: mobilityMovesDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: slugStrategy,
  },
  {
    dataset: nutrientFoodMapDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: nutrientKeyStrategy,
  },
  {
    dataset: ototoxicDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: ototoxicKeyStrategy,
  },
  {
    dataset: pgxDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: pgxGuidanceStrategy,
  },
  {
    dataset: prnDefaultsDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: prnDefaultSlugStrategy,
  },
  {
    dataset: radiationDoseDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: radiationDoseKeyStrategy,
  },
  {
    dataset: screeningsDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: screeningKeyStrategy,
  },
  {
    dataset: strengthStandardsDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: strengthStandardNameStrategy,
  },
  {
    dataset: tempRedFlagsDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: tempRedFlagKeyStrategy,
  },
];
