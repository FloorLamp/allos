// Shared credential + fixture-profile names for the e2e member logins seeded by
// e2e/seed-events.ts (issue #391). Kept in a PLAIN module (no @playwright/test
// import) so BOTH the seeder (a tsx script) and the specs can import the same
// constants without pulling Playwright into the seed process. The seeder creates
// each login directly in the DB (username + scrypt hash + a single grant) so a
// spec can sign in as an isolated, non-admin session in its OWN cookie context —
// which lets a test drive a NON-profile-1 active profile (a child, a fixture
// integration profile) WITHOUT mutating the shared admin storageState's
// server-side active profile (the flake class the shared-session switchProfile
// helpers risk under parallel workers).

export const E2E_MEMBER_PASSWORD = "e2e-member-pass-1234";

// A member granted ONLY the seeded "Riley (child)" profile, so Riley is its sole
// (and therefore active) profile on login. Read-only uses across specs:
//   - equipment-manager: the age-gate redirect off /settings/equipment,
//   - integrations-strava: the disconnected (no-connection) setup form,
//   - immunizations: proving reads are profile-scoped (Riley's own empty list),
//   - ai-logs-access: a member is bounced off the admin-only AI logs page.
// Every one of those is a READ, so concurrent sessions of this login never
// contend on shared data.
export const E2E_LOGIN_CHILD = "e2e_child";

// A member granted a dedicated profile whose Strava connection is seeded in the
// terminal `needs_reauth` state, so /integrations/strava renders the reconnect CTA.
export const E2E_LOGIN_STRAVA = "e2e_strava";
export const STRAVA_REAUTH_PROFILE = "Strava Reauth (e2e)";

// A member granted a dedicated, connection-less profile used to exercise the
// Health Connect generate → rotate token flow. It MUTATES only its own profile's
// connection (never profile 1's, whose unconnected state the review-inbox spec
// relies on).
export const E2E_LOGIN_HC = "e2e_hc";
export const HEALTH_CONNECT_PROFILE = "Health Connect (e2e)";

// A member granted a dedicated profile carrying ONE same-source duplicate — two
// manual weigh-ins on one day (both "Manual entry") — so the Data → Review resolver
// renders a candidate pair whose source labels collide and the A/B disambiguation
// (#531) fallback is exercised in isolation, never touching profile 1's review
// inbox (whose exact duplicate count import-dedup.spec relies on).
export const E2E_LOGIN_DUP = "e2e_dup";
export const DUP_REVIEW_PROFILE = "Dup Review (e2e)";

// A member granted a dedicated profile carrying the two-document body-fat
// comparison fixture (#533): two DEXA documents plus a body-fat reading sourced
// from each (+ one manual reading). Dedicated ON PURPOSE — planting the documents
// on profile 1 made its body_fat multi-source (a surprise "Body fat" compare
// heading broke kids-growth's strict locator) and inflated its re-extract-all
// cost preview (review-inbox's "1 scan/PDF" copy pluralized). A fixture that flips
// a SHARED surface between single- and multi-source states gets its own profile.
export const E2E_LOGIN_COMPARE = "e2e_compare";
export const SOURCE_COMPARE_PROFILE = "Source Compare (e2e)";

// A member granted a dedicated ADULT profile that owns NO equipment (issue #592),
// so the activity form's equipment picker hits its empty state and renders the
// "Add equipment" bootstrap door to /equipment. Dedicated on purpose — profile 1
// (and every other fixture profile that a spec logs a non-strength activity on)
// owns gear, so the door only appears where the inventory is provably empty. No
// birthdate → adult → never training-restricted, so /training renders the full log.
export const E2E_LOGIN_NOGEAR = "e2e_nogear";
export const NO_GEAR_PROFILE = "No Gear (e2e)";

// A member granted a dedicated ADULT profile with an ACTIVE Push/Pull/Legs routine
// (#740) and NO recovery data, so the Training overview resolves today's routine
// session and renders the "Today's session" card WITHOUT a rest override (profile 1
// is deliberately forced to rest for the coaching-episode spec, which would hide the
// card). Dedicated on purpose — the routine-recommendation spec asserts the resolved
// slate and the "Log this session" prefill in isolation.
export const E2E_LOGIN_ROUTINE = "e2e_routine";
export const ROUTINE_PROFILE = "Routine (e2e)";

// A member granted a dedicated ADULT profile for the routine-BUILDER specs (#739),
// SEPARATE from ROUTINE_PROFILE above on purpose: the routine-recommendation spec
// depends on that profile's routine staying ACTIVE (the Today's-session card), while
// the builder spec activates/deactivates routines — sharing a profile would let one
// spec break the other. Also never profile 1: activating a routine DELETES the
// profile's training-scope frequency_targets and replaces them with the routine's
// derived ones (profile 1's seeded PPL targets other specs depend on). It's seeded
// with a couple of training-scope frequency targets so the activate-confirm dialog
// (which only appears when there ARE targets to replace) is exercised, and NO
// routines. No birthdate → adult → never training-restricted, so /training renders
// the full hub with the Routines tab.
export const E2E_LOGIN_ROUTINE_BUILDER = "e2e_routine_builder";
export const ROUTINE_BUILDER_PROFILE = "Routine Builder (e2e)";

// A dedicated ADULT profile with an ACTIVE routine whose mesocycle places TODAY in
// its DELOAD week (#741), SEPARATE from ROUTINE_PROFILE so the recommendation spec's
// non-deload expectations stay intact. Its Today's-session card shows the deload
// badge + deload-adjusted slate.
export const E2E_LOGIN_ROUTINE_DELOAD = "e2e_routine_deload";
export const ROUTINE_DELOAD_PROFILE = "Routine Deload (e2e)";

// A dedicated ADULT profile with NOTHING logged — no activities at all (#809), the
// brand-new/post-onboarding state. Dedicated on purpose: the shared seeded profiles
// (and every other fixture profile above, incl. No Gear which seeds one activity
// precisely so its Log tab renders the Journal) always have activities, which is
// exactly why the first-run Training → Log regression — the empty state short-
// circuiting the Journal and hiding "New activity" — was never caught. This profile
// stays activity-free so the training-first-run spec can assert the first-run empty
// variant renders the action row (Start workout + New activity, NO Repeat last). No
// birthdate → adult → never training-restricted, so /training renders the full hub
// (JournalView), not the minor's RestrictedActivityView.
export const E2E_LOGIN_EMPTY_TRAINING = "e2e_empty_training";
export const EMPTY_TRAINING_PROFILE = "Empty Training (e2e)";
