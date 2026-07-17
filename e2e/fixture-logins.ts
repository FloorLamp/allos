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

// Dedicated ADULT profiles for the activity-form fill-paths spec (#923), each owning
// its own fixture so a save/dismiss can't disturb a neighbor (the #868 hygiene rule).
//   • FORM_DELOAD: an ACTIVE PPL routine in its deload week + logged Barbell Bench
//     Press history, so the strength editor's next-set suggestion is deload-shaved.
//   • FORM_PLATEAU: NO routine + a flat-for-6-weeks Skullcrusher, so a plateaued lift
//     shows the inline plateau hint (never shaved — the profile has no cycle).
export const E2E_LOGIN_FORM_DELOAD = "e2e_form_deload";
export const FORM_DELOAD_PROFILE = "Form Deload (e2e)";
export const E2E_LOGIN_FORM_PLATEAU = "e2e_form_plateau";
export const FORM_PLATEAU_PROFILE = "Form Plateau (e2e)";

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

// A brand-new, write-granted profile with explicit version-1 onboarding state and
// no health data. The onboarding spec owns every mutation on it.
export const E2E_LOGIN_ONBOARDING = "e2e_onboarding";
export const ONBOARDING_PROFILE = "Onboarding Person (e2e)";

// A second empty onboarding profile dedicated to the caregiver path. Keeping it
// separate lets the self/metrics and caregiver browser tests run in parallel
// without racing over onboarding state or dashboard layout.
export const E2E_LOGIN_ONBOARDING_CAREGIVER = "e2e_onboarding_caregiver";
export const ONBOARDING_CAREGIVER_PROFILE = "Caregiver Onboarding Person (e2e)";

// A populated profile with no new-profile onboarding marker. Its member receives
// the distinct, dismissible existing-profile orientation on the Dashboard.
export const E2E_LOGIN_ORIENTATION = "e2e_orientation";
export const ORIENTATION_PROFILE = "Existing Profile (e2e)";

// ── Illness hero fixtures (#858) ──────────────────────────────────────────────
// The illness hero moved the sick-day cockpit OFF the customizable grid (the former
// symptom-log widget) and above it, and gained cross-profile logging + collapse
// persistence. These dedicated logins isolate the mutations (collapse state, a
// cross-profile dose/temp) from the shared admin session so the illness-hero spec is
// repeat-safe under --repeat-each=3.

// A member whose SOLE (therefore active) profile is currently sick — its own FULL
// cockpit renders at hero position. Used for the active-cockpit / mobile-first /
// collapse-persistence tests, which mutate ONLY this profile (never profile 1, whose
// seeded episode the other illness specs depend on staying live + expanded).
export const E2E_LOGIN_SICK_SELF = "e2e_sick_self";
export const SICK_SELF_PROFILE = "Sick Self (e2e)";

// A SECOND sick-solo login dedicated to the collapse-PERSISTENCE test, which mutates the
// stored hero collapse state — kept apart from SICK_SELF (whose read-only active-cockpit /
// mobile-first tests assert the default EXPANDED state) so the two never contend.
export const E2E_LOGIN_SICK_COLLAPSE = "e2e_sick_collapse";
export const SICK_COLLAPSE_PROFILE = "Sick Collapse (e2e)";

// Situation-aware coaching (#837 / #662 item 1): a dedicated sick profile WITH training
// history (so coaching has gap nags to HOLD, not the empty state) and one situational
// supplement tied to the active Illness situation (so the situations-bar activation
// acknowledgment has a count). Read-only in its specs — the dashboard coaching widget's
// HELD note + the "1 situational item now active" line — so it's repeat-safe and never
// touches the other sick fixtures' expected cockpit state.
export const E2E_LOGIN_SITCOACH = "e2e_sitcoach";
export const SITCOACH_PROFILE = "Situation Coaching (e2e)";

// A caregiver granted their OWN well base profile plus two currently-sick children
// (Kid A owns a PRN med for the dose path). Acting as the well base profile, both kids
// render as compact accordion cockpits — the multi-sick / cross-profile-temp case.
export const E2E_LOGIN_CARE = "e2e_care";
export const CARE_PARENT_PROFILE = "Care Parent (e2e)";
export const SICK_KID_A_PROFILE = "Sick Kid A (e2e)";
export const SICK_KID_B_PROFILE = "Sick Kid B (e2e)";

// A SECOND caregiver granted their own well base profile plus Sick Kid A (shared with
// CARE) — the co-caregiver case: a dose CARE logs for Kid A shows on this login's hero.
export const E2E_LOGIN_COCARE = "e2e_cocare";
export const COCARE_PARENT_PROFILE = "Co Parent (e2e)";

// A member whose SOLE (active) profile carries a positive infection lab result
// ("HIV Antibody: Reactive") that is NOT on its problem list, so the condition-
// suggestion review item (#685) surfaces on Upcoming with an "Add to conditions"
// confirm. Dedicated + isolated on purpose — the confirm/dismiss flow MUTATES the
// problem list, and the spec self-heals (removes the condition at the start) so it's
// repeat-safe without touching any shared-seed profile.
export const E2E_LOGIN_CONDREV = "e2e_condrev";
export const CONDITION_REVIEW_PROFILE = "Condition Review (e2e)";

// A dedicated ADULT profile carrying a family history of heart disease AND a fresh
// out-of-range LDL (issue #656 item 4), so the biomarker-flag item on /upcoming
// gains its risk-layer "why-for-this-profile" line ("Family history of heart
// disease"). Read-only; isolated on purpose — a risk-elevated flagged lipid on a
// SHARED profile would change its hero/Upcoming flag set and race neighbor specs.
export const E2E_LOGIN_REASON = "e2e_reason";
export const REASON_MODEL_PROFILE = "Reason Model (e2e)";
