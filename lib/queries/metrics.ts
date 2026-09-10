// Barrel for the metrics read layer, split into cohesive submodules (issue #5171 —
// the #316 / #126 treatment): body-metrics rows and the latest/dated body reads
// (`body`), the metric_samples daily totals and latest readings (`samples`), the
// sleep-session windows, stage totals and manual-sleep edit gates
// (`sleep-sessions`), the hr_minutes profile-local day readers (`hr`) and the
// per-source comparison series (`by-source`), over the source-resolution helpers,
// the partial-today mark and the hr_minutes day-window aggregates in `common`.
// Re-exported here so `@/lib/queries` import paths and export names are unchanged.
// Every read across the submodules is profile-scoped.

export * from "./metrics/body";
export * from "./metrics/samples";
export * from "./metrics/sleep-sessions";
export * from "./metrics/hr";
export * from "./metrics/by-source";
