// Registered datasets and their primary identity strategies. The framework tests
// validate each entry and check membership against committed data sources.
// Root-level JSON exceptions are classified in docs/internals/datasets.md.

import {
  allergenCrossReactivityDataset,
  allergenFamilyStrategy,
} from "./allergen-cross-reactivity";
import { biomarkerDescriptionsDataset } from "./biomarker-descriptions";
import {
  biomarkerSupplementMapDataset,
  supplementMapKeyStrategy,
} from "./biomarker-supplement-map";
import { canonicalResultDefinitionsDataset } from "./canonical-result-definitions";
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
  fitnessHoldNormsDataset,
  fitnessHoldNormNameStrategy,
} from "./fitness-hold-norms";
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
import { liftsDataset, liftNameStrategy } from "./lifts";
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
import {
  weatherMedSafetyDataset,
  weatherMedKeyStrategy,
} from "./weather-med-safety";
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
  // Entry fields vary by dataset; the registry only needs validated object rows.
  dataset: LoadedDataset<object, unknown>;
  strategy: MatchStrategy;
}

export const DATASETS: RegisteredDataset[] = [
  {
    dataset: allergenCrossReactivityDataset,
    strategy: allergenFamilyStrategy,
  },
  {
    dataset: biomarkerDescriptionsDataset,
    strategy: nameStrategy,
  },
  {
    dataset: canonicalResultDefinitionsDataset,
    strategy: nameStrategy,
  },
  {
    dataset: bpPercentilesDataset,
    strategy: bpPercentileKeyStrategy,
  },
  {
    dataset: conditionTrainingConsiderationsDataset,
    strategy: conditionConsiderationKeyStrategy,
  },
  {
    dataset: contrastDataset,
    strategy: contrastClassStrategy,
  },
  {
    dataset: dentalSafetyDataset,
    strategy: dentalKeyStrategy,
  },
  {
    dataset: driDataset,
    strategy: driNutrientStrategy,
  },
  {
    dataset: drugAllergyDataset,
    strategy: drugAllergyKeyStrategy,
  },
  {
    dataset: drugInteractionsDataset,
    strategy: drugInteractionPairStrategy,
  },
  {
    dataset: fitnessNormsDataset,
    strategy: fitnessNormNameStrategy,
  },
  {
    dataset: fitnessHoldNormsDataset,
    strategy: fitnessHoldNormNameStrategy,
  },
  {
    dataset: foodDrugInteractionsDataset,
    strategy: foodDrugKeyStrategy,
  },
  {
    dataset: foodGroupsDataset,
    strategy: slugStrategy,
  },
  {
    dataset: growthChartsDataset,
    strategy: growthChartNameStrategy,
  },
  {
    dataset: icd10Dataset,
    strategy: icd10CodeStrategy,
  },
  {
    dataset: illnessThresholdsDataset,
    strategy: illnessThresholdSlugStrategy,
  },
  {
    dataset: liftsDataset,
    strategy: liftNameStrategy,
  },
  {
    dataset: medicationDescriptionsDataset,
    strategy: medDescriptionsStrategy,
  },
  {
    dataset: medMonitoringDataset,
    strategy: medMonitoringKeyStrategy,
  },
  {
    dataset: metsDataset,
    strategy: nameStrategy,
  },
  {
    dataset: mobilityMovesDataset,
    strategy: slugStrategy,
  },
  {
    dataset: nutrientFoodMapDataset,
    strategy: nutrientKeyStrategy,
  },
  {
    dataset: biomarkerSupplementMapDataset,
    strategy: supplementMapKeyStrategy,
  },
  {
    dataset: ototoxicDataset,
    strategy: ototoxicKeyStrategy,
  },
  {
    dataset: pgxDataset,
    strategy: pgxGuidanceStrategy,
  },
  {
    dataset: weatherMedSafetyDataset,
    strategy: weatherMedKeyStrategy,
  },
  {
    dataset: prnDefaultsDataset,
    strategy: prnDefaultSlugStrategy,
  },
  {
    dataset: radiationDoseDataset,
    strategy: radiationDoseKeyStrategy,
  },
  {
    dataset: screeningsDataset,
    strategy: screeningKeyStrategy,
  },
  {
    dataset: strengthStandardsDataset,
    strategy: strengthStandardNameStrategy,
  },
  {
    dataset: tempRedFlagsDataset,
    strategy: tempRedFlagKeyStrategy,
  },
];
