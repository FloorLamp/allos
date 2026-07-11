// Barrel for the Upcoming-page aggregation, split into cohesive submodules
// (issue #316 — mirrors the #126 training split): the item generators + collectors
// (`generators`), the preventive-care satisfaction/override stores + shared
// assessment (`preventive`), and the findings-suppression store + name-keyed
// lifecycle helpers (`suppressions`). Re-exported here so `@/lib/queries` import
// paths and export names are unchanged. Every read/write across the submodules is
// profile-scoped (enforced by lib/__tests__/profile-scoping.test.ts, with the
// dynamic no-bleed guard in lib/__db_tests__/upcoming.scoping.test.ts).

export * from "./upcoming/generators";
export * from "./upcoming/preventive";
export * from "./upcoming/suppressions";
