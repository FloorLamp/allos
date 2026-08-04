// Re-export barrel for the read/derive layer. The implementation is split into
// domain modules under lib/queries/*; this file preserves the historical
// `@/lib/queries` import surface so callers don't care where a query now lives.
// Every export below keeps its original name and signature.
//
// The profile-scoping guard (lib/__tests__/profile-scoping.test.ts) walks all of
// lib/, so the split submodules are still scanned — its per-file allowlist points
// at the new lib/queries/*.ts paths where the moved statements now live.
export * from "./queries/metrics";
export * from "./queries/logical-outcomes";
export * from "./queries/substance";
export * from "./queries/sleep";
export * from "./queries/frequency-targets";
export * from "./queries/training";
export * from "./queries/wellness";
export * from "./queries/mobility";
export * from "./queries/endurance";
export * from "./queries/presence";
export * from "./queries/session-recap";
export * from "./queries/zones";
export * from "./queries/coaching";
export * from "./queries/reported-burden";
export * from "./queries/nutrition";
export * from "./queries/symptoms";
export * from "./queries/mood";
export * from "./queries/mood-anxiety";
export * from "./queries/medical";
export * from "./queries/biomarker-options";
export * from "./queries/saved";
export * from "./queries/visit-links";
export * from "./queries/med-links";
export * from "./queries/derived";
export * from "./queries/appointments";
export * from "./queries/intake";
export * from "./queries/intake-options";
export * from "./queries/immunization-options";
export * from "./queries/narratives";
export * from "./queries/clinical";
export * from "./queries/multi-view-lists";
export * from "./queries/coverage";
export * from "./queries/search";
export * from "./queries/imports";
export * from "./queries/upcoming";
export * from "./queries/attention";
export * from "./queries/integrations";
export * from "./queries/protocols";
export * from "./queries/situation-impact";
export * from "./queries/equipment";
export * from "./queries/longevity";
export * from "./queries/sun";
export * from "./queries/providers";
export * from "./queries/provider-options";
export * from "./queries/affiliations";
export * from "./queries/nav-relevance";
export * from "./queries/derived-situations";
export * from "./queries/data-quality";
export * from "./queries/surgery-bridge";
export * from "./queries/intraday";
export * from "./queries/trends-context";
// The unified reading series (#1997 phase 1) — one identity-keyed shape over
// body_metrics / metric_samples / medical_records.
export * from "./queries/readings";
// The one judgement lookup, resolved for a profile (#1996).
export * from "./queries/metric-judgment";
// The shared, GLOBAL providers registry — not profile-scoped, but
// re-exported here so pages read it through the familiar @/lib/queries surface.
export * from "./providers-db";
// Wellness write cores retain their historical barrel exports. Read names now come
// from queries/wellness above, so the domain has one public read surface (#1622).
export * from "./practice-log";
export * from "./practice-store";
