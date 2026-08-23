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
// Four dated goals plus one arranging errand, all in the Later band (#2579-A). They
// give the profile the shape the Upcoming charter describes — a run of goal deadlines
// burying the one row this page is the primary home of — so the goal fold and the
// Later band's calendar due-text can both be asserted on real rows.
export const UPCOMING_AGG_GOAL_NEAREST = "Aggregate goal — swim a mile (e2e)";
export const UPCOMING_AGG_GOALS: readonly (readonly [string, number])[] = [
  // [title, whole days past this profile's today]. Deliberately NOT in date order:
  // the summary's "nearest" claim must be a minimum over the fold, never whichever
  // row happens to come first.
  ["Aggregate goal — ride a century (e2e)", 200],
  [UPCOMING_AGG_GOAL_NEAREST, 40],
  ["Aggregate goal — deadlift bodyweight (e2e)", 120],
  ["Aggregate goal — hold a handstand (e2e)", 300],
];
// The errand beside them: a scheduled appointment whose FULL-HEIGHT row must survive
// the fold — this page is its primary home, so it never folds. Its This-week TWIN is
// the same domain on the same page a few days out, so #2579-B's band boundary can be
// asserted on two rows that differ in nothing else.
export const UPCOMING_AGG_APPOINTMENT = "Aggregate colonoscopy (e2e)";
export const UPCOMING_AGG_APPOINTMENT_DAYS = 60;
export const UPCOMING_AGG_APPOINTMENT_SOON =
  "Aggregate dermatology check (e2e)";
export const UPCOMING_AGG_APPOINTMENT_SOON_DAYS = 3;

// ── Offline snapshots (#2908 / #3040) ────────────────────────────────────────
// A member granted ONE dedicated adult profile for offline-snapshots.spec.ts —
// the #3017 own-profile/own-login shape. The shared admin login and profile 1
// could not host this spec for two reasons, one per half of it:
//   • it exercises LOGOUT, which destroys the session row server-side, so it must
//     never authenticate with the shared worker storageState;
//   • its offline dose tap is REPLAYED on reconnect, and that replay writes a real
//     taken-dose row for whatever profile captured it. On profile 1 that leftover
//     write cost offline-write-gate's R3d a red (#3040) — a drain the old spec
//     asserted vacuously and never observed. On this profile the replay lands on
//     rows nothing else reads, and the spec undoes it through the product's own
//     un-take, observed rather than assumed.
// One daily scheduled medication, so the profile has a med-list snapshot row, a
// dose-schedule snapshot row, and exactly one Today row to tap offline.
export const E2E_LOGIN_OFFLINE_SNAPSHOTS = "e2e_offline_snapshots";
export const OFFLINE_SNAPSHOTS_PROFILE = "Offline Snapshots (e2e)";
export const OFFLINE_SNAPSHOTS_MED = "Offline Snapshot Med (e2e)";

// #3478 — the dose ledger at phone width. A member granted a dedicated ADULT
// profile whose medication catalog contains ONE portal-imported name of the length
// the owner's phone review actually carried, plus one ordinary active medication
// with a live dose so the ledger's "Log past dose" launcher renders. The profile
// has NO confirmed doses, so its ledger is EMPTY — which is the state item 3's
// element order and kind-named copy are about, and the state a shared profile could
// never guarantee. Dedicated on purpose (#868): a 55-character medication name on a
// shared profile would widen controls under every neighbouring spec's assertions.
// Read-only in its spec, so it stays repeat-safe. Synthetic, no PHI.
export const E2E_LOGIN_DOSE_LEDGER_PHONE = "e2e_dose_ledger_phone";
export const DOSE_LEDGER_PHONE_PROFILE = "Dose Ledger Phone (e2e)";
// The imported name itself. Its LENGTH is the fixture — the spec asserts that this
// option's natural width still exceeds the phone viewport before it believes any
// verdict about the control, so a shortened name fails loudly here instead of
// passing over a page that could not have been wrong.
export const DOSE_LEDGER_PHONE_IMPORTED_MED =
  "Calcium Carb-Cholecalciferol (CALCIUM 500 + D OR) (e2e)";
// An ordinary active medication with a live dose row: without one the ledger renders
// no launcher at all, and item 3's ordering assertion would have nothing to order.
export const DOSE_LEDGER_PHONE_ACTIVE_MED = "Ledger Phone Med (e2e)";
