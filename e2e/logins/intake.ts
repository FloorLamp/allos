// Shared credential + fixture-profile names for the e2e intake fixtures. Composed
// into e2e/fixture-logins.ts (which every spec and seeder still imports from) —
// see that file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

// A member granted a dedicated ADULT profile for the #1027 cross-item PRN counter
// spec: OTC ibuprofen (confirmed 6h interval / max 4, PRN) plus a second
// "Ibuprofen 800 mg" item whose administration one hour before the frozen e2e clock
// holds the OTC item's redose window ("Next dose in ~5h … across 2 items") and
// raises the coaching duplication note. Read-only in its spec (dismissals reset per
// test), so it stays repeat-safe and never perturbs shared-seed PRN fixtures.
export const E2E_LOGIN_PRN_FAMILY = "e2e_prn_family";
export const PRN_FAMILY_PROFILE = "Prn Family (e2e)";

// A member granted a dedicated ADULT profile for the #1032 safety-coverage spec:
// two name-only active medications (loratadine — off the curated interaction set;
// sertraline — a name-matched SSRI concept) with NO warnings, so the Medications /
// Supplements safety strips render the "checked N of M, no flags" scope line
// instead of the old silent blank, and the name-only rows wear the quiet
// limited-screening chip. Read-only in its spec, so it stays repeat-safe.
export const E2E_LOGIN_COVERAGE = "e2e_coverage";
export const SAFETY_COVERAGE_PROFILE = "Safety Coverage (e2e)";

// #1374 — shared supply pools (the household medicine cabinet). A DEDICATED caregiver
// login granted TWO dedicated profiles (write), each with its own daily medication
// linked to ONE seeded shared bottle, plus a second bottle seeded LOW so the cabinet's
// low state and the single pooled Upcoming finding render without waiting on a tick.
// Spec-owned end to end (shared-supply-pool.spec.ts): nothing else reads these
// profiles, these items, or these bottles, so the spec may exact-count its own rows and
// confirm doses from both members without perturbing a neighbour. Synthetic, no PHI.
export const E2E_LOGIN_SUPPLY = "e2e_supply";
export const SUPPLY_PARENT_PROFILE = "Supply Parent (e2e)";
export const SUPPLY_CHILD_PROFILE = "Supply Child (e2e)";
// The shared bottle both members draw from — comfortably stocked, so the spec can watch
// its count fall as each member confirms a dose.
export const SUPPLY_SHARED_BOTTLE = "Shared Ibuprofen (e2e)";
export const SUPPLY_PARENT_MED = "Supply Parent Ibuprofen (e2e)";
export const SUPPLY_CHILD_MED = "Supply Child Ibuprofen (e2e)";
// A second, deliberately LOW bottle both members also draw from — one bottle, so the
// household must see exactly ONE low-stock finding, not one per linked member.
export const SUPPLY_LOW_BOTTLE = "Low Shared Cetirizine (e2e)";
export const SUPPLY_PARENT_LOW_MED = "Supply Parent Cetirizine (e2e)";
export const SUPPLY_CHILD_LOW_MED = "Supply Child Cetirizine (e2e)";
// A third bottle the EDIT case owns outright (one linked med on the parent), so
// rewriting its count can never perturb the decrement case's arithmetic.
export const SUPPLY_EDIT_BOTTLE = "Editable Shared Loratadine (e2e)";
export const SUPPLY_PARENT_EDIT_MED = "Supply Parent Loratadine (e2e)";

// #1504 — the Upcoming page's display aggregation. A DEDICATED member login granted a
// dedicated adult profile whose Today band is deliberately shaped like the audit's:
// six scheduled doses (one already taken, so the fold can state a real fraction),
// several interacting medications so the interaction rollup has something to roll up,
// and one PRN medication logged OVER its confirmed daily max — the pinned safety row
// that must render individually, ABOVE the fold, at all times. Spec-owned end to end
// (upcoming-aggregate.spec.ts + its mobile twin): nothing else reads this profile, so
// the spec may exact-count its own rows, confirm a dose and dismiss a finding without
// perturbing a neighbour. Synthetic, no PHI.
export const E2E_LOGIN_UPCOMING_AGG = "e2e_upcoming_agg";
export const UPCOMING_AGG_PROFILE = "Upcoming Aggregate (e2e)";
// The four interacting medications (warfarin + aspirin + an NSAID + an SSRI), each a
// daily `must` dose, so the profile carries both a dose run and ≥3 interaction pairs.
export const UPCOMING_AGG_WARFARIN = "Aggregate Warfarin (e2e)";
export const UPCOMING_AGG_ASPIRIN = "Aggregate Aspirin (e2e)";
export const UPCOMING_AGG_NSAID = "Aggregate Ibuprofen (e2e)";
export const UPCOMING_AGG_SSRI = "Aggregate Sertraline (e2e)";
// A plain daily supplement, and the one dose logged taken today.
export const UPCOMING_AGG_SUPPLEMENT = "Aggregate Vitamin D (e2e)";
export const UPCOMING_AGG_TAKEN = "Aggregate Magnesium (e2e)";
// The PRN medication logged over its confirmed max — the prn-max safety row.
export const UPCOMING_AGG_PRN = "Aggregate Naproxen PRN (e2e)";
