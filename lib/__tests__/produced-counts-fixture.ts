import type { DocumentProducedCounts } from "../import-log";

// Shared all-zero produced-counts fixture for the import-log / import-browser
// pure tests. Adding a field to DocumentProducedCounts fails compilation here,
// so both suites must acknowledge a new produced kind.
export const EMPTY_PRODUCED_COUNTS: DocumentProducedCounts = {
  recordsByCategory: [],
  immunizations: 0,
  allergies: 0,
  conditions: 0,
  encounters: 0,
  procedures: 0,
  familyHistory: 0,
  carePlanItems: 0,
  careGoals: 0,
  genomicVariants: 0,
  imagingStudies: 0,
  opticalPrescriptions: 0,
  appointments: 0,
  medications: 0,
  bodyMetrics: 0,
  heightSamples: 0,
  headCircSamples: 0,
  providers: 0,
};
