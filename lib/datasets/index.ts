// Curated-dataset framework — public API barrel (issue #860 Track B).
//
// The small, documented surface a dataset migration adopts. See
// docs/internals/datasets.md for the framework spec and the migration recipe.
//
//   types    — DatasetEnvelope / Citation / MatchStrategy / DatasetMatcher, the
//              DATASET_SCHEMA marker, and the DatasetError class.
//   loader   — loadDataset(): validate a raw envelope into a LoadedDataset.
//   matcher  — createMatcher() + the shipped strategies (name / slug / field) and
//              the rxcui future-seam stub.
//   harness  — reusable assertions (citationPresent / identityResolves /
//              refusalGate / runHarness) shared by per-dataset tests and the linter.
//   registry — DATASETS, the list of framework-migrated datasets.

export * from "./types";
export * from "./loader";
export * from "./matcher";
export * from "./harness";
export * from "./registry";
