// Barrel for the nutrition read/gather layer, split into cohesive submodules
// (issue #5171 — the #316 / #126 treatment): the food-group serving ledger and the
// ranking every logging surface orders by (`ledger`), what this profile logs nearly
// every time plus the live recency checks over that ledger (`regularity`), and the
// protein/fiber adequacy gathers with the suggestion reads they feed (`adequacy`).
// Re-exported here so `@/lib/queries` import paths and export names are unchanged.
// Every read across the submodules is profile-scoped.

export * from "./nutrition/ledger";
export * from "./nutrition/regularity";
export * from "./nutrition/adequacy";
