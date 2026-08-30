// Shared credential + fixture-profile names for the destructive merge fixtures.
// Composed into e2e/fixture-logins.ts so the seeder and owning specs share the
// same identities without pulling Playwright into the seed process.

// Each merge consumes one of its two activities. A dedicated profile per spec
// makes that destruction private instead of leaving profile 1 changed for every
// later reader on the worker.
export const E2E_LOGIN_MERGE_CONFLICT = "e2e_merge_conflict";
export const MERGE_CONFLICT_PROFILE = "Conflict Merge (e2e)";
export const E2E_LOGIN_MERGE_SETS = "e2e_merge_sets";
export const MERGE_SETS_PROFILE = "Set Merge (e2e)";
