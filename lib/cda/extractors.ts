// CDA section-extractor barrel. The implementation is split by section type
// under lib/cda/extractors/ (#597) — immunizations, observations, medications,
// conditions, allergies, encounters, procedures, family history, care plan/goals,
// social history, care teams — plus the default registry. Re-exported here so
// every import path and export name is unchanged.
export * from "./extractors/immunizations";
export * from "./extractors/observations";
export * from "./extractors/medications";
export * from "./extractors/conditions";
export * from "./extractors/allergies";
export * from "./extractors/encounters";
export * from "./extractors/procedures";
export * from "./extractors/family-history";
export * from "./extractors/care-plan";
export * from "./extractors/social-history";
export * from "./extractors/care-teams";
export * from "./extractors/registry";
