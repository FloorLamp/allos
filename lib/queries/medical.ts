// Barrel for the medical read layer, split into cohesive submodules (issue #5171 —
// the #316 / #126 treatment): clinical records, observations and documents
// (`records`), the hoisted current-reading statements behind the flagged and
// qualitative surfaces (`current`), and the canonical vocabulary, biomarker series
// and saved-result store (`biomarkers`), over the shared SQL identity keys and
// representative CTEs in `common`. Re-exported here so `@/lib/queries` import paths
// and export names are unchanged. Every read across the submodules is profile-scoped.

export * from "./medical/records";
export * from "./medical/current";
export * from "./medical/biomarkers";
export {
  biomarkerFamilyKey,
  biomarkerNameKey,
  biomarkerPanelKey,
} from "./medical/common";
export { getCanonicalResultDefinition } from "./medical/canonical";
export {
  ENCOUNTER_REPRESENTATIVE_IDS,
  getEncounter,
  getEncounters,
  visitContextForEncounter,
} from "./medical/encounters";
export {
  IMMUNIZATION_CONTRIBUTED_NOTES,
  IMMUNIZATION_CONTRIBUTED_NOTES_CTE,
  IMMUNIZATION_REPRESENTATIVE_IDS,
  getImmunityTiters,
  getImmunizationOverride,
  getImmunizationOverrides,
  getImmunizations,
  type ImmunityTiter,
  type ImmunizationOverrideRow,
} from "./medical/immunizations";
export { previewReconcileFlags, reconcileFlags } from "./medical/flags";
export {
  getObservationRevisions,
  getRevisionsByObservation,
  insertObservationRevision,
  type RevisionSnapshot,
} from "./medical/revisions";
export {
  detectRecordUnitMislabel,
  getUnitMislabelReviews,
  unitMislabelSignalKey,
  type UnitMislabelReview,
} from "./medical/unit-mislabel";
