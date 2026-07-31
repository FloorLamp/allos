// Shared credential + fixture-profile names for the e2e household fixtures. Composed
// into e2e/fixture-logins.ts (which every spec and seeder still imports from) —
// see that file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

// A member granted TWO dedicated profiles for the profile-switch toaster spec
// (#296), so its ACTIVE-PROFILE switching runs in its OWN cookie context and can
// never strand the shared admin storageState on a fixture profile — the shard-3
// cascade on PR #1110 (a mid-switch failure left the shared session on the wrong
// profile, and 17 later specs in the same worker saw the empty profile's data as
// data-gated app-shell failures). Each profile carries its OWN pre-existing
// TERMINAL document/import-job history (a done doc, a failed doc, a ready import
// job) so switching between them exercises the silent-reseed on BOTH — the fix's
// "switch there, no ghost toasts; switch back, still none" invariant — without
// touching profile 1 or profile 2 (whose toaster histories the shared-session era
// depended on). TOAST_A sorts to the LOWER profile id (seeded first), so it is the
// login's default active profile on sign-in. Read-only grant: the spec only reads
// and switches, never writes profile-owned data.
export const E2E_LOGIN_TOASTS = "e2e_toasts";
export const TOAST_SWITCH_A_PROFILE = "Toaster A (e2e)";
export const TOAST_SWITCH_B_PROFILE = "Toaster B (e2e)";

// #1096 — multi-profile viewing (the banner view-set + multi-view Upcoming). A
// dedicated member granted TWO dedicated profiles, both WRITE, each carrying its own
// due-today supplement dose. Isolated on purpose: the spec toggles a second profile
// into the view-set and confirms a cross-profile dose (a persistent write), so
// sharing profile 1 / the household profile would race the household-rollup specs
// (which pin those profiles' exact dose state). The OWNER profile is created first
// so it holds the lower id and is therefore the caregiver's ACTING profile on login
// (createSession picks accessibleProfiles[0]). Synthetic, no PHI.
export const E2E_LOGIN_MULTI = "e2e_multi";
export const MULTI_OWNER_PROFILE = "Multi Owner (e2e)";
export const MULTI_SHARED_PROFILE = "Multi Shared (e2e)";
export const MULTI_OWNER_DOSE = "Multi Owner Vitamin";
export const MULTI_SHARED_DOSE = "Multi Shared Vitamin";
// Tier-1 multi-view record-list fixtures (issue #1328): one condition, allergy, and
// health goal per multi profile, so the /records + /results record lists render a row
// per profile — the acting (owner) row with NO chip, the shared row WITH a subject chip.
export const MULTI_OWNER_CONDITION = "Multi Owner Asthma (e2e)";
export const MULTI_SHARED_CONDITION = "Multi Shared Eczema (e2e)";
export const MULTI_OWNER_ALLERGY = "Multi Owner Latex (e2e)";
export const MULTI_SHARED_ALLERGY = "Multi Shared Pollen (e2e)";
export const MULTI_OWNER_GOAL = "Multi Owner BP target (e2e)";
export const MULTI_SHARED_GOAL = "Multi Shared A1c target (e2e)";
// Multi-view Training Journal fixtures (issue #1330): manual activities so the Log
// feed renders a MERGED card feed across the two profiles. The owner (acting) has TWO
// same-day cardio activities (a same-PROFILE merge candidate for each other); the
// shared member has ONE activity on the SAME day — a cross-profile row that renders a
// subject chip and must NEVER appear as an owner card's merge sibling. All on one day
// so the newest-window merge covers them. Synthetic, no PHI.
export const MULTI_ACTIVITY_DATE = "2026-06-15";
export const MULTI_OWNER_ACTIVITY_A = "MV Owner Ride Alpha";
export const MULTI_OWNER_ACTIVITY_B = "MV Owner Ride Bravo";
export const MULTI_SHARED_ACTIVITY = "MV Shared Swim";
// Tier-1b bespoke-list multi-view fixtures (issue #1359): one past visit (encounter)
// and one recorded immunization dose per multi profile, so the Visits "Past" list and
// the Immunizations "All recorded doses" list each render a row per profile — the
// acting (owner) row with NO chip, the shared row WITH a subject chip.
export const MULTI_OWNER_VISIT = "Multi Owner Physical (e2e)";
export const MULTI_SHARED_VISIT = "Multi Shared Checkup (e2e)";
export const MULTI_OWNER_VACCINE = "influenza";
export const MULTI_SHARED_VACCINE = "tdap";

// Multi-view Timeline with a DIVERGENT-timezone day boundary (issue #1329). A dedicated
// member granted TWO adult profiles WRITE whose per-profile timezones sit ~25h apart
// (Etc/GMT-13 = UTC+13 vs Etc/GMT+12 = UTC−12), so the SAME frozen instant is a
// DIFFERENT local calendar date for each — the honest divergent-day header the spec
// asserts. Each profile carries ONE activity dated on ITS OWN today (computed in its
// zone at seed time), so the merged feed shows two separate "Today" day-groups, one per
// member. EAST is created first (lower id → the member's ACTING profile on login).
// Dedicated timezones on purpose: mutating a shared profile's tz would skew every
// dueness/today-seeded neighbor spec. Synthetic, no PHI.
export const E2E_LOGIN_TL_MULTI = "e2e_tl_multi";
export const TL_EAST_PROFILE = "Timeline East (e2e)";
export const TL_WEST_PROFILE = "Timeline West (e2e)";
export const TL_EAST_ACTIVITY = "TL East morning run";
export const TL_WEST_ACTIVITY = "TL West evening swim";
export const TL_EAST_TZ = "Etc/GMT-13"; // UTC+13
export const TL_WEST_TZ = "Etc/GMT+12"; // UTC−12

// Own-profile link + not-self write affordances (issue #1013). A dedicated member
// granted TWO adult profiles WRITE, with own_profile_id pointing at the FIRST — the
// login's declared "self". Each carries a due-today dose + one weigh-in, so the
// household cards render dose-confirm buttons and the dashboard weight widget renders.
// Acting as SELF → affordances stay plain; switching to the OTHER (not the login's
// own) → they NAME the subject ("Confirm — Own Other (e2e)", "Finish workout — …").
// Both profiles are adults (no birthdate → never training-restricted), so the live
// workout editor is available. Dedicated + isolated so this spec's weigh-in / workout
// writes never race the shared household specs; SELF is created first so it holds the
// lower id and is the caregiver's ACTING profile on login (createSession picks
// accessibleProfiles[0]). Synthetic, no PHI.
export const E2E_LOGIN_OWN = "e2e_own";
export const OWN_SELF_PROFILE = "Own Self (e2e)";
export const OWN_OTHER_PROFILE = "Own Other (e2e)";
export const OWN_SELF_DOSE = "Own Self Vitamin";
export const OWN_OTHER_DOSE = "Own Other Vitamin";

// #1373 Part 1 — multi-view Medications regimen boards. A caregiver granted its OWN
// base profile (WRITE, the lowest-id grant → the acting profile on sign-in) plus a
// second member profile READ-ONLY, each carrying one due-today scheduled medication.
// So the boards spec proves, in isolation: single-view is byte-identical (one board, no
// subject header, the write base's controls live), multi-view stacks a board per member
// behind the leading "Today across everyone" strip, and the read-only member's board is
// view-only (RO badge, no dose-confirm control). Read-mostly (the spec only reads +
// toggles the view-set), so concurrent workers never contend and it never perturbs the
// shared medication fixtures.
export const E2E_LOGIN_MVMEDS = "e2e_mvmeds";
export const MVMEDS_SELF_PROFILE = "Meds Board Self (e2e)";
export const MVMEDS_RO_PROFILE = "Meds Board RO (e2e)";
export const MVMEDS_SELF_MED = "Board Lisinopril";
export const MVMEDS_RO_MED = "Board Metformin";

// #1331 — multi-view Biomarkers (Results) table. A caregiver granted its OWN base
// profile (WRITE, the lowest-id grant → the acting profile on sign-in) plus a second
// member profile READ-ONLY. Both carry the SHARED "Vitamin D" analyte family with
// DIFFERENT values/dates, plus a uniquely-named analyte each, so the merged results
// table proves, in isolation: single-view is byte-identical (no Profile column, no
// chip, only the acting member's readings), multi-view merges per-member partitions
// (both members' Vitamin D rows survive — is_latest never crosses), the non-acting
// member's rows carry a subject chip, and the read-only member's rows show no
// edit/delete affordance. Read-only in the spec (only reads + toggles the view-set).
export const E2E_LOGIN_MVBIO = "e2e_mvbio";
export const MVBIO_SELF_PROFILE = "Bio Board Self (e2e)";
export const MVBIO_RO_PROFILE = "Bio Board RO (e2e)";
export const MVBIO_SHARED_ANALYTE = "Vitamin D";
export const MVBIO_SELF_ANALYTE = "Bioself Ferritin (e2e)";
export const MVBIO_RO_ANALYTE = "Biored Glucose (e2e)";

// #1412 — the Family grant-matrix collapse. A DEDICATED member login granted ONE
// dedicated profile (write), so the family-grants spec can drive its collapsed
// summary row, expand it, and flip its grant level through setGrants WITHOUT
// perturbing any other spec's grant set (view-only-access pins profile 1's members;
// this login is nobody else's dependency). own_profile_id is left null so the spec
// also proves the own-profile autosave from a known start. Synthetic, no PHI.
export const E2E_LOGIN_GRANTEDIT = "e2e_grantedit";
export const GRANT_EDIT_PROFILE = "Grant Edit (e2e)";

// #1434 — invite-flow hardening. Both are PROFILES WITHOUT LOGINS on purpose: the
// specs need something to grant, not another identity in every login's grant matrix.
//
// DUP_ACCESS_PROFILE is seeded TWICE, deliberately identical, because that is the
// bug: two same-named profiles used to render as indistinguishable checkbox rows in
// the Access matrix and the create-login access picker — exactly where granting the
// wrong person's record is the costliest mistake. The spec asserts the #534
// disambiguation ordinals show up in both places.
export const DUP_ACCESS_PROFILE = "Dup Access (e2e)";

// INVITE_TARGET_PROFILE is what the emailed-invite journey grants its new member at
// CREATE time, so the invitee lands on a real profile instead of the grantless dead
// end. Nobody else's dependency — the journey only reads it.
export const INVITE_TARGET_PROFILE = "Invite Target (e2e)";

// ── Telegram household dose round (issue #1459) ──────────────────────────────
// A spec-owned caregiver fixture for e2e/household-round.spec.ts. The login's
// own_profile_id points at the CAREGIVER profile (created first, so it holds the
// lowest id and is the acting profile on login — createSession picks
// accessibleProfiles[0]), which is what makes the round offerable at all: the
// checklist is "profiles the receiving profile's own login can WRITE".
//
// The two other profiles exercise the access rule in opposite directions in ONE
// render: WARD is granted WRITE (offered) and SHADOW is granted READ-ONLY (never
// offered — the round confirms doses, and a read grant may never write). Dedicated
// on purpose: the spec persists a household_round subscription, and doing that on a
// shared caregiver profile would add a cross-profile dose round to whatever other
// specs assert about that profile's notifications.
export const E2E_LOGIN_HH_ROUND = "e2e_hhround";
export const HH_ROUND_CAREGIVER_PROFILE = "HH Round Caregiver (e2e)";
export const HH_ROUND_WARD_PROFILE = "HH Round Ward (e2e)";
export const HH_ROUND_SHADOW_PROFILE = "HH Round Shadow (e2e)";
