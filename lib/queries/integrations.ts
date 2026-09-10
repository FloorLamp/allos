// Barrel for the integrations read layer, split into cohesive submodules (issue
// #5171 — the #316 / #126 treatment): the sync-event ledger reads and the per-source
// state record (`sync-events`), duplicate/conflict detection with durable decisions,
// the review badge and the escalated-integration issues (`decisions`), and the
// per-row sync provenance drill-in (`provenance`), over the shared standing
// resolution in `common`. Re-exported here so `@/lib/queries` import paths and
// export names are unchanged. Every read across the submodules is profile-scoped.

export * from "./integrations/sync-events";
export * from "./integrations/decisions";
export * from "./integrations/provenance";
export {
  getIntegrationSyncEvents,
  getLastSuccessfulSyncAt,
} from "./integrations/common";
