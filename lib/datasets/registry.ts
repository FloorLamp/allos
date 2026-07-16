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

import { driDataset, driNutrientStrategy } from "./dri";
import { foodGroupsDataset } from "./food-groups";
import { icd10Dataset, icd10CodeStrategy } from "./icd10-common";
import { metsDataset } from "./mets";
import {
  nutrientFoodMapDataset,
  nutrientKeyStrategy,
} from "./nutrient-food-map";
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
    dataset: driDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: driNutrientStrategy,
  },
  {
    dataset: foodGroupsDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: slugStrategy,
  },
  {
    dataset: icd10Dataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: icd10CodeStrategy,
  },
  {
    dataset: metsDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: nameStrategy,
  },
  {
    dataset: nutrientFoodMapDataset as unknown as LoadedDataset<
      Record<string, unknown>,
      unknown
    >,
    strategy: nutrientKeyStrategy,
  },
];
