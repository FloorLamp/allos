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
// Most uses are reads. The pediatric-medication persistence spec adds one medication
// on the isolated e2e DB; no other spec depends on Riley's medication list.
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

// A dedicated ADULT profile for the #1144 recovering-injury cross-surface parity spec:
//   • a RECOVERING "Chest" injury (so the Chest region is tempered), and
//   • logged Barbell Bench Press history (3 × 100 kg × 6), a Chest lift,
//   • NO routine (so today is NOT a deload week — the injury temper is the ONLY modifier).
// So the strength editor's next-set suggestion is injury-TEMPERED to 60 kg (100 × 0.6),
// matching the Analyze/detail panel's deep-link recommendation — the exact divergence
// #1115 left open on the injury axis. Dedicated on purpose (#868): a recovering injury on
// a SHARED profile would temper its coaching/overview surfaces and race neighbor specs.
// The spec's only write is a create-and-clean draft (fill a set, then delete it, mirroring
// the FORM_DELOAD spec), so the fixture is left untouched and it stays repeat-safe.
export const E2E_LOGIN_FORM_INJURY = "e2e_form_injury";
export const FORM_INJURY_PROFILE = "Form Injury (e2e)";

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

// A dedicated ADULT profile for the Sleep and Mood Log's historical editor.
// The browser spec owns and resets its mood + manual sleep rows, so editing can
// never race the shared admin sleep fixture or the child profile's empty-state gate.
export const E2E_LOGIN_SLEEP_EDIT = "e2e_sleep_edit";
export const SLEEP_EDIT_PROFILE = "Sleep Edit (e2e)";

// A dedicated READ-ONLY sleep-phase fixture with one 04:00→13:00 late-riser
// window and one 08:00→16:00 daytime-sleeper window (#1190). Seeded once before
// the suite; the browser spec never mutates or cleans it, so parallel/repeat runs
// cannot race another test's state.
export const E2E_LOGIN_SLEEP_PHASE = "e2e_sleep_phase";
export const SLEEP_PHASE_PROFILE = "Sleep Phase (e2e)";

// A dedicated, write-granted ADULT profile with NO instrument scores logged (#716):
// the mental-health-instruments spec OWNS every write here (it administers a PHQ-9 /
// GAD-7 in-app), so it never touches — or counts rows on — a shared-seed profile. Its
// own isolated session means concurrent workers can't contend on its scores.
export const E2E_LOGIN_MENTAL = "e2e_mental";
export const MENTAL_HEALTH_PROFILE = "Mental Health (e2e)";

// A dedicated, write-granted ADULT profile with NO substance data (#998): the
// substance-use spec OWNS every write here (an in-app AUDIT-C, an outside DAST-10
// total, one-tap drinks, the weekly-cap target), so it never touches — or counts
// rows on — a shared-seed profile, and its isolated session means concurrent
// workers can't contend. Seed-events hard-clears its substance rows on a reused
// server; the spec itself asserts RELATIVE counts so --repeat-each stays clean.
export const E2E_LOGIN_SUBSTANCE = "e2e_substance";
export const SUBSTANCE_PROFILE = "Substance Use (e2e)";

// A dedicated OLDER-ADULT profile (sex=female, ~60yo) with NO satisfying records, so
// EVERY preventive screening class stays due — used by preventive-deeplinks.spec.ts
// (#1083) to prove a due row deep-links to the concrete next action per class
// (lab → prefilled biomarker add form, vital → vitals quick-add, instrument →
// `?screen=` preselect, procedure → prefilled procedures add form). The spec only
// READS its Upcoming + follows links (no writes), and its isolated session means
// concurrent workers can't contend — it never counts a shared-seed row.
export const E2E_LOGIN_PREVENTIVE = "e2e_preventive";
export const PREVENTIVE_PROFILE = "Preventive Deeplinks (e2e)";

// A dedicated ADULT profile for the mental-health-visit sensitivity + crisis-
// resources specs (#997/#996). Seeded with its calendar feed set to FULL detail and
// a per-profile crisis-resources override; the spec OWNS every appointment it books
// (create-and-verify, filtered by unique title), so it never counts a shared-seed
// row and --repeat-each stays clean. Isolated session — no contention with the
// score-accumulating E2E_LOGIN_MENTAL profile.
export const E2E_LOGIN_CRISIS = "e2e_crisis";
export const CRISIS_PROFILE = "Crisis Support (e2e)";
// The per-profile crisis-resources OVERRIDE seeded for CRISIS_PROFILE — a synthetic
// entry so the passive surface + inline finding render the profile's own line.
export const CRISIS_OVERRIDE_LABEL = "Crisis Text Line (e2e)";
export const CRISIS_OVERRIDE_CONTACT = "Text 555-0142";

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

// The illness-care care finding (#805): a dedicated sick profile whose fever is logged
// on FOUR consecutive days (daysAgo 3→0), crossing the cited "more than 3 days" line so
// the finding surfaces on Upcoming. Dedicated ON PURPOSE — profile 1 carries the same
// 4-day-fever fixture, but the illness lifecycle specs (end/reopen episode, dismiss the
// finding) mutate profile 1's illness state, and under CI's --repeat-each co-location a
// sibling's end-episode/dismiss made the finding vanish for the reader. This profile is
// read-only in illness-care.spec, so the finding stays deterministic. seedSickEpisode's
// 1-day fever is NOT enough (the finding needs the 4-day run), so it's seeded directly.
export const E2E_LOGIN_ILLNESS_CARE = "e2e_illness_care";
export const ILLNESS_CARE_PROFILE = "Illness Care (e2e)";

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

// A dedicated ADULT profile carrying a LIVE, in-progress strength session (issue
// #921): an activity logged today with a start_time, NO end_time, and a fresh
// auto-save timestamp — so derived workout presence reads `active`. Drives the
// app-wide workout dock (hydration + reopen) and the household presence chip.
// Isolated on purpose — an always-"active" session on a SHARED profile would plant
// a surprise dock/chip that races neighbor specs.
export const E2E_LOGIN_PRESENCE = "e2e_presence";
export const PRESENCE_PROFILE = "Workout Presence (e2e)";

// A dedicated ADULT profile for the Settings IA / notification-matrix spec (#928).
// Isolated on purpose: the matrix spec MUTATES notification prefs (enables Home
// Assistant, toggles per-kind cells) and asserts the safety-kind all-channels-off
// warning — which requires a CONFIGURED channel. Doing that on profile 1 (or any
// shared fixture) would race the home-assistant-notify / quiet-hours / preventive
// specs that also touch profile-1 notification state under --repeat-each. No
// birthdate → adult → the full Notifications tab + matrix render.
export const E2E_LOGIN_NOTIF = "e2e_notif";
export const NOTIF_PROFILE = "Notif Matrix (e2e)";

// A dedicated ADULT profile for the protein-grams quick-add spec (#824): a bodyweight
// (so the adequacy target scales) plus a couple of protein-bearing food-group servings
// today (so the adequacy card renders over the ESTIMATED basis), and NO integration
// protein_g and NO protein_log rows. Isolated on purpose — the spec OWNS the protein_log
// writes on it, and logging grams flips the adequacy card to the COMBINED basis, which
// would race protein-adequacy.spec's shared-profile estimated-basis assertions if it ran
// on profile 1. No birthdate → adult → the food logger + adequacy card render.
export const E2E_LOGIN_PROTEIN = "e2e_protein";
export const PROTEIN_QUICKADD_PROFILE = "Protein Quickadd (e2e)";
// A dedicated ADULT profile carrying a JUST-FINISHED strength session (issue #924):
// a manual activity today with a start_time AND a recent end_time (~8 min ago), two
// working sets that hit their rep target, plus a prior session of the same lift a
// week earlier — so derived workout presence reads `finished` and the finished-
// window dashboard recap card renders with a PR. Read-only; isolated on purpose —
// an always-"finished" session on a SHARED profile would plant a surprise recap
// card that races neighbor specs.
export const E2E_LOGIN_RECAP = "e2e_recap";
export const RECAP_PROFILE = "Session Recap (e2e)";
// Dedicated ADULT + SENIOR profiles for the guided Fitness check spec (#834). Isolated
// on purpose: the spec RECORDS tests (writing fitness_assessments, a VO2 medical_records
// vital, and set rows on an assessment activity), which would perturb profile 1's seeded
// fitness sessions / pillar coverage under --repeat-each. Both carry sex + birthdate so
// the norms percentiles resolve; FITNESS also carries a PRIOR check so a re-record shows a
// check-over-check delta. FITNESS_SENIOR is age 72 so /training?tab=fitness renders the
// older-adult battery variant (arm curl, timed up-and-go, 4-stage balance — never a
// Cooper run or dead hang).
export const E2E_LOGIN_FITNESS = "e2e_fitness";
export const FITNESS_PROFILE = "Fitness Check (e2e)";
export const E2E_LOGIN_FITNESS_SENIOR = "e2e_fitness_senior";
export const FITNESS_SENIOR_PROFILE = "Fitness Senior (e2e)";
// A dedicated ADULT profile for the mobility spec (#840). Carries sex + birthdate (so the
// fitness-norms percentile gate opens) and a LOW sit-and-reach vital, so the Training
// overview's Mobility section renders a deficit→habit SUGGESTION (a Legs mobility habit).
// Isolated on purpose: the spec TAPS moves (writing a recovery activity) and the fixture
// keeps NO seeded recovery session / mobility_region target, so the log bar starts empty
// and the suggestion is present — state a shared profile couldn't guarantee under
// --repeat-each. The spec owns + cleans up its own toggles; it never clicks Accept (which
// would create a persistent target and hide the suggestion on the next repeat).
export const E2E_LOGIN_MOBILITY = "e2e_mobility";
export const MOBILITY_PROFILE = "Mobility (e2e)";

// A dedicated ADULT profile for the food-log slot-aware ranking + N-week habit trend
// specs (#950 / #954). Its per-tap food_log_events ledger is slot-SKEWED — exactly one
// dominant encourage group per window (whole_grains at breakfast, fatty_fish at lunch,
// berries in the evening) — so whatever slot the e2e wall clock lands in, the one-tap
// bar's lead must match the slot chip. It also carries a backdated "fatty fish 2×/week"
// habit (a real multi-week trend) and a freshly-created "leafy greens" habit (an honest
// cold-start trend). Dedicated + read-only on purpose: a slot-skewed ledger or backdated
// target on a SHARED profile would change its ranking/rollup and race neighbor specs.
export const E2E_LOGIN_FOODSLOT = "e2e_foodslot";
export const FOOD_SLOT_PROFILE = "Food Slot (e2e)";

// ── Endurance event plans (#839) ──────────────────────────────────────────────
// A dedicated ADULT profile with a few weeks of logged runs (so a created plan's
// trajectory has a real base + this-week actuals), and NO endurance_plans row — the
// spec OWNS the create/complete/delete lifecycle on it (create-and-clean, #868), so
// its writes never race the shared seed's seeded plan. No birthdate → adult → never
// training-restricted, so /training renders the full hub with the Event-plans bar.
export const E2E_LOGIN_ENDURANCE = "e2e_endurance";
export const ENDURANCE_PROFILE = "Endurance Plan (e2e)";

// A dedicated ADULT profile carrying ONE flagged biomarker reading — an out-of-range
// Hemoglobin A1c (#700 flagged-labs follow-up adapter). The followup-labs spec tracks a
// "Recheck A1c" follow-up from the biomarker detail page, watches it surface legibly on
// Upcoming, then lands a later same-family (eAG) reading and resolves the loop.
// Isolated + spec-owned on purpose: tracking a follow-up + adding/resolving a reading
// MUTATES care_plan_items + medical_records, which on a shared profile would race the
// biomarker/upcoming specs. The spec cleans its follow-up + the later reading in
// beforeAll AND afterAll so it's repeat-safe; the seeded source A1c is re-seeded each boot.
export const E2E_LOGIN_FLABS = "e2e_flabs";
export const FLAGGED_LAB_PROFILE = "Flagged Lab (e2e)";

// A dedicated ADULT profile carrying ONE flagged intraocular-pressure reading — an
// out-of-range right-eye IOP (#698 §6 IOP glaucoma follow-up adapter). The followup-iop
// spec tracks a "Recheck IOP / glaucoma workup" follow-up from the biomarker detail
// page, watches it surface legibly on Upcoming, then lands a later left-eye pressure and
// resolves the loop (bilateral — one workup covers both eyes). Isolated + spec-owned for
// the same reason as the flagged-lab profile: tracking/resolving MUTATES care_plan_items
// + medical_records. The spec cleans its follow-up + later reading in beforeAll/afterAll;
// the seeded source IOP is re-seeded each boot.
export const E2E_LOGIN_IOP = "e2e_iop";
export const FLAGGED_IOP_PROFILE = "Flagged IOP (e2e)";

// A dedicated ADULT profile for the nutrition trio (#974/#975/#976). Carries a recent
// weigh-in (a protein/fiber target to scale), this-week food-group servings across both
// protein- and fiber-bearing groups (so the protein gauge's weekly marker + the fiber
// estimate both render), a CONFIRMED capsule-unit fiber supplement today (the honest
// "grams unknown" fiber note), sex = male (a DRI fiber target), and one flagged low
// omega-3 reading (so the #577 engine fires and the vegetarian preset's plant-source
// substitution is observable). Spec-owned: the dietary-preferences spec MUTATES the
// profile's excluded set, so it lives off profile 1 (whose suggestions the coaching specs
// read) — and the preferences spec resets the set in afterAll so it's repeat-safe.
export const E2E_LOGIN_NUTRITION = "e2e_nutrition";
export const NUTRITION_PROFILE = "Nutrition Trio (e2e)";

// A dedicated ADULT profile for the menstrual-cycle spec (#714). Seeded with three
// completed, roughly-regular periods (so the derived phase, the cycle-length +
// variability trend, and the regularity read all render) and NO open period. Isolated +
// spec-owned on purpose: the cycle spec MUTATES this profile's cycles (one-tap start/end,
// add/delete a period) and it self-cleans within the spec, so it never races profile 1's
// seeded cycle data that the Timeline/phase-chip assertions read.
export const E2E_LOGIN_CYCLE = "e2e_cycle";
export const CYCLE_PROFILE = "Cycle Log (e2e)";

// ── Household visit + illness history fixtures (#1009) ────────────────────────
// A caregiver granted TWO dedicated profiles — a well parent and a currently-sick
// child — each carrying PAST visits + illness episodes so the merged household
// history (/household/history) has real cross-profile content to interleave and
// tag by person. Spec-owned + isolated on purpose: the merged-history / episode-card
// / promotion specs only READ these fixtures, so concurrent workers never contend,
// and their dedicated profiles never perturb the illness-hero fixtures' cockpit
// assertions. The child's episodes are shaped for the episode-card cases: a CLOSED
// "Flu" that OVERLAPS the parent's Flu (card-present), and an OPEN "Cold" (currently
// sick → dashboard promotion). The parent also carries a far-past "Chickenpox" that
// overlaps nobody (card-absent case).
export const E2E_LOGIN_HHHIST = "e2e_hhhist";
export const HH_HISTORY_PARENT_PROFILE = "Household History Parent (e2e)";
export const HH_HISTORY_CHILD_PROFILE = "Household History Child (e2e)";

// A SECOND caregiver granted the SAME two history profiles as READ-ONLY, proving the
// merged history renders for a view-only grant (reads are allowed) without any write
// affordance. Separate login so the read-only assertions never race the write one.
export const E2E_LOGIN_HHHIST_RO = "e2e_hhhist_ro";

// ── Nav relevance gating fixtures (#1042 phase 1) ─────────────────────────────
// Two dedicated profiles for the nav-consolidation spec's Cycle/specialty gating
// assertions, both READ-ONLY in their spec (it only inspects the sidebar), so
// concurrent workers never contend and --repeat-each stays clean.
//   • NAV_FEMALE: sex=female + explicit premenopausal reproductive status, NO
//     cycle rows — the Cycle entry shows via the status arm of
//     cycleTrackingRelevant. Owns NO vision/dental rows either, so the
//     data-gated Vision/Dental entries are provably hidden on the same profile.
//   • NAV_MALE: sex=male + adult birthdate, NO cycle rows — Cycle hidden.
export const E2E_LOGIN_NAV_FEMALE = "e2e_nav_female";
export const NAV_FEMALE_PROFILE = "Nav Cycle Female (e2e)";
export const E2E_LOGIN_NAV_MALE = "e2e_nav_male";
export const NAV_MALE_PROFILE = "Nav Cycle Male (e2e)";

// ── Dashboard weight quick-add (#1042 phase 2) ────────────────────────────────
// A dedicated, write-granted ADULT profile with two seeded weigh-ins (notes
// 'e2e:seed-weight') so the dashboard weight-trend widget renders its chart.
// Spec-owned on purpose (#868): the weight-quick-add spec resets every non-seed
// body_metrics row on it at test start (the smoke.spec direct-DB precedent), so
// it's repeat-safe and its writes never perturb a shared profile's weight series
// (which the trends/kids-growth/nutrition specs read). No birthdate → adult.
export const E2E_LOGIN_WEIGHT_QA = "e2e_weight_qa";
export const WEIGHT_QUICKADD_PROFILE = "Weight Quickadd (e2e)";

// A member granted a dedicated sick profile whose ONLY temperature reading is a
// LEGACY imported Celsius row (unit 'Cel', source 'ccd', stored before the #1018
// import-boundary conversion existed), so the episode surfaces prove the
// read-time unit gate end-to-end in the browser: the latest temperature renders
// CONVERTED ("101.3 °F"), never the raw "38.5" plotted on the °F axis. Read-only
// in its spec, so it stays repeat-safe and never perturbs the other sick
// fixtures' cockpit assertions.
export const E2E_LOGIN_CEL_IMPORT = "e2e_cel_import";
export const CEL_IMPORT_PROFILE = "Cel Import (e2e)";

// A member granted a dedicated ADULT profile proving the CODES → preventive-
// satisfaction loop (#1035/#1037) in the browser: its ONLY visit evidence is a
// coded generic encounter ("Office Visit" + CPT 99396 → adult_physical) and a
// completed CDT-coded dental row ("Prophy" + D1110 → dental_cleaning) — no text
// field matches a name synonym, so only the code path can satisfy them. Dedicated
// on purpose (#868): preventive-upcoming.spec.ts relies on profile 1's
// dental_cleaning item staying DUE (its mark-done fixture), which this profile's
// rows would extinguish if seeded there. Read-only in its spec — repeat-safe.
export const E2E_LOGIN_PREVCODE = "e2e_prevcode";
export const PREVENTIVE_CODES_PROFILE = "Preventive Codes (e2e)";
// A member granted a dedicated ADULT profile for the drug-allergy × medication
// cross-check spec (#1029): a recorded "Penicillin — hives" allergy plus a tracked
// amoxicillin (same-class hit) and cephalexin (documented cross-reactivity hit).
// Dedicated on purpose — an allergy warning on a SHARED profile would plant surprise
// safety-strip cards / Upcoming findings that race neighbor specs. The spec owns its
// dismissal state (reset per test), so it stays repeat-safe.
export const E2E_LOGIN_DRUG_ALLERGY = "e2e_drug_allergy";
export const DRUG_ALLERGY_PROFILE = "Drug Allergy (e2e)";

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

// ── Structural data-quality gaps (#1045) ──────────────────────────────────────
// A member whose SOLE (active) profile is intentionally GAPPY — no birthdate, no sex,
// and one failed-extraction document — so the dashboard "Data quality" widget renders
// the top-3 structural gaps (birthdate, sex, failed doc) with fix-it CTAs, and the
// dismiss test can silence one across the widget + the coaching rollup. Dedicated +
// isolated on purpose (#868): the dismiss test WRITES an upcoming_dismissals row on it,
// so it never perturbs a shared profile, and each test resets its own data-quality
// dismissals first so --repeat-each stays clean.
export const E2E_LOGIN_DQ_GAPPY = "e2e_dq_gappy";
export const DQ_GAPPY_PROFILE = "Data Quality Gappy (e2e)";

// A member whose SOLE (active) profile is structurally COMPLETE — birthdate + sex +
// smoking status + reviewed risk factors, and no meds/labs/failed-docs — so the
// "Data quality" widget SELF-HIDES (renders nothing, the absent-pillar rule). Proves
// the widget disappears on a complete profile.
export const E2E_LOGIN_DQ_COMPLETE = "e2e_dq_complete";
export const DQ_COMPLETE_PROFILE = "Data Quality Complete (e2e)";

// A caregiver granted TWO profiles — its own COMPLETE base profile plus a GAPPY child
// (no birthdate/sex) — so the household page shows a per-member data-quality gaps line
// on the child's card (kids are where birthdate/sex gaps cluster). Read-only in its
// spec, so concurrent workers never contend and it never perturbs the dashboard
// gappy/complete fixtures above.
export const E2E_LOGIN_DQ_CARE = "e2e_dq_care";
export const DQ_CARE_PARENT_PROFILE = "Data Quality Parent (e2e)";
export const DQ_CARE_CHILD_PROFILE = "Data Quality Child (e2e)";

// A member whose SOLE profile is a structurally-GAPPY ADULT (#1146): birthdate + sex
// set, but smoking status unknown, risk factors unreviewed, and a PARTIAL PhenoAge
// panel (one Albumin lab) — so the "Data quality" widget renders the adult-gated
// gaps whose CTAs must deep-link the exact forms (smoking-history / risk-factors
// anchors, the prefilled biomarker add form). It also owns the dashboard-deeplinks
// fixtures that need a quiet dedicated dashboard: a target-less goal (#1219 item 3)
// and four ongoing protocols + a layout that shows the active-protocols widget
// (#1219 item 4). Read-mostly: its spec only navigates; no dismissals are written.
export const E2E_LOGIN_DQ_ADULT = "e2e_dq_adult";
export const DQ_ADULT_PROFILE = "Data Quality Adult (e2e)";

// A member granted a dedicated ADULT profile for the Home Assistant channel-config
// spec. Isolated as of #1025: the spec persists a REAL (unreachable) HA webhook to
// prove the config round-trip, and the temperature write paths now dispatch the
// red-flag nudge immediately — so an HA config left on a shared profile turns any
// crossing-temp log elsewhere in the suite into a failed real send that overwrites
// the GLOBAL delivery-health marker the notify-delivery-error spec asserts on. On
// its own profile (which no spec logs temperatures for), the persisted config can
// never be dispatched to.
export const E2E_LOGIN_HA_NOTIFY = "e2e_ha_notify";
export const HA_NOTIFY_PROFILE = "HA Notify (e2e)";

// A member granted a dedicated ADULT profile for the record↔visit / episode↔visit
// linking spec (#1050/#1053). Seeds a self-contained visit + a same-day unlinked
// medication (with its prescription record) + an illness episode spanning that day
// with no linked visit — so the spec drives "From this visit?" → link all, the med's
// "Prescribed at" line, and the cockpit Care suggestion → link → encounter back-link
// entirely on its OWN profile (never a shared-seed row, so --repeat-each stays clean).
export const E2E_LOGIN_VISITLINKS = "e2e_visitlinks";
export const VISITLINKS_PROFILE = "Visit Links (e2e)";

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

// #1099 — "Create a visit from this record?". A dedicated profile carrying ONE optical
// prescription dated a day with NO encounter, so the create-a-visit prompt renders on
// the Vision record card. The spec OWNS the profile (dedicated login), so accepting the
// prompt (which mutates: creates an encounter + links the Rx) can't disturb any
// shared-seed count. Idempotent under --repeat-each: the spec accepts only when the
// prompt is still present, then asserts the created-visit end-state.
export const E2E_LOGIN_CREATEVISIT = "e2e_createvisit";
export const CREATEVISIT_PROFILE = "Create Visit (e2e)";

// ── Household-rollup + illness-episode caregiver fixtures (#868 census hardening) ──
// Five member logins granted the SHARED seeded profiles — profile 1 ("admin") and
// profile 2 ("Riley (child)", seeded by scripts/seed.ts) — so the household-rollup and
// illness-episode specs stop CREATING members at runtime through Settings → Family. That
// page's create/grant controls are onClick + router.refresh() (not form submits), so the
// grant rows render only after a client refresh that goes stale under CI load — the
// create-member census flake (#868 fixture-ownership discipline). Seeded grants render
// deterministically. These logins are READ-STRUCTURE ONLY: their grant sets are STATIC
// (never mutated by a spec), and the specs leave the shared profiles' data as found
// (household-rollup resets only its own dedicated dose row). Profile 1 is the lowest
// granted id, so a caregiver lands acting as it (createSession picks accessibleProfiles[0]).
//   • HH_CAREGIVER — profile 1 write + profile 2 write. Two Household cards; confirms
//     profile 2's due dose from its card while the active profile stays profile 1.
//   • HH_SOLO — profile 1 write ONLY. No Household nav; bounced off /household.
//   • HH_VIEWER — profile 1 read + profile 2 read. Sees both cards, NO confirm buttons.
export const E2E_LOGIN_HH_CAREGIVER = "e2e_hh_caregiver";
export const E2E_LOGIN_HH_SOLO = "e2e_hh_solo";
export const E2E_LOGIN_HH_VIEWER = "e2e_hh_viewer";
//   • ILLNESS_CAREGIVER — profile 1 write + profile 2 write. Acts as profile 2 (well),
//     so sick profile 1 surfaces only in the cross-profile illness-hero accordion (#858).
//   • ILLNESS_RO — profile 1 READ + profile 2 write. Acts as profile 2, opens sick
//     profile 1's episode read-tier (view-only banner, no write controls, #879).
export const E2E_LOGIN_ILLNESS_CAREGIVER = "e2e_illness_caregiver";
export const E2E_LOGIN_ILLNESS_RO = "e2e_illness_ro";

// #1067 Phase 1 — Trends → Body mobile overhaul. A dedicated adult profile with a
// KNOWN, PARTIAL set of synced body metrics so the chart-jump chips + per-chart
// anchors are deterministic: it has weight + resting HR (the body-composition
// block), steps, a sleep night, and one day of heart-rate minutes — but NO
// hydration / BMR / calories / lean-mass / BMI etc., so those metrics' chips must
// be ABSENT (the "chartless charts hide their chip" assertion). Read-only grant;
// the spec only navigates + scrolls (no writes), so --repeat-each stays clean.
export const E2E_LOGIN_TRENDS_BODY = "e2e_trends_body";
export const TRENDS_BODY_PROFILE = "Trends Body (e2e)";

// #1148/#1150 — the coaching rest card. A dedicated adult profile tripping TWO
// concurrent under-recovery signals at once: a short night (below the 6h floor →
// rest-sleep) AND an elevated resting HR (62 vs a ~54 baseline → rest-rhr), plus one
// old strength activity for training context. So the dashboard coaching card leads with
// the salience-ordered primary AND shows the "Also: …" line (#1148), and the
// "Training anyway" acknowledgment (#1150) has a real multi-signal rest rec to
// transform. Isolated on purpose: the ack/snooze writes here would race the coaching
// specs' reads on profile 1; its own profile means --repeat-each stays clean (the spec
// resets its ack/snooze rows itself).
export const E2E_LOGIN_REST = "e2e_rest";
export const REST_CARD_PROFILE = "Rest Card (e2e)";

// #1151 — the aggregated Upcoming "Snoozed & dismissed" section. A dedicated
// adult profile carrying one suppression from each class the section now spans:
// a CARE snooze (a future appointment), a COACHING dismissal (a training-obs
// plateau key), and a SUGGESTION dismissal (a med-bridge key with no backing
// record — the shape a pre-092 dismissal leaves behind, labelled purely from
// its key, #1232). Isolated on purpose: the spec restores/clears
// suppression rows (and resets them itself), which on profile 1 would race the
// needs-attention/coaching specs' bus reads.
export const E2E_LOGIN_SUPPRESSED = "e2e_suppressed";
export const SUPPRESSED_PROFILE = "Suppressed Center (e2e)";

// #1063 — the mobile clipped-content audit. A dedicated profile whose Health
// Connect connection is seeded CONNECTED with a long, synthetic DB-backed token,
// so the mobile-overflow spec can assert the endpoint/token rows fit a phone
// viewport WITHOUT generating or rotating anything — the HEALTH_CONNECT_PROFILE
// above is owned by the generate→rotate spec, whose token mutations would race a
// concurrent reader under parallel workers. Read-only in its spec.
export const E2E_LOGIN_MOBILE_HC = "e2e_mobile_hc";
export const MOBILE_HC_PROFILE = "Mobile HC (e2e)";

// #1119 — progress photos. A dedicated adult profile the progress-photos spec
// captures into (via the PhotoCapture fallback file input) and CLEANS ITSELF
// (it deletes the profile's progress_photos rows at spec start), so the
// data-gated "Progress photos" nav entry flips within its OWN sidebar — and the
// shared admin session's exact top-level order (nav-consolidation.spec.ts,
// which enumerates profile 1's sidebar verbatim) never changes.
export const E2E_LOGIN_PHOTOS = "e2e_photos";
export const PROGRESS_PHOTOS_PROFILE = "Progress Photos (e2e)";

// #1221 — the dashboard daily-loop recomposition. A dedicated adult FEMALE profile
// carrying one reading in every domain the four new cards read, all dated to the
// fixture's "today" so the cards render populated (not their data-aware empty state):
//   • steps today + a trailing week (Steps-today card),
//   • a recent BP pair + resting HR (Latest-vitals card),
//   • today's food + a body weight (Nutrition-today protein card),
//   • three completed periods so cycle tracking is relevant and a phase/day derives
//     (Cycle-phase card),
//   • one active PRN medication (the check-in "Take any meds?" branch).
// Isolated on purpose — the spec is read-only, but planting a female profile with
// cycles + full daily-loop data on profile 1 (or the cycle fixture) would perturb
// those specs' surfaces. Synthetic, no PHI.
export const E2E_LOGIN_DAILY = "e2e_daily";
export const DAILY_LOOP_PROFILE = "Daily Loop (e2e)";

// #1224 — video capture. A dedicated ADULT profile (birthdate seeded, so /training
// isn't age-gated) carrying ONE seeded strength activity the video spec attaches a
// form-check clip to, and its own episode/symptom surfaces. The spec CLEANS ITSELF
// (deletes the profile's activity_videos / symptom_videos rows at spec start), so
// its clip counts stay isolated from profile 1 and the shared admin sidebar.
export const E2E_LOGIN_VIDEO = "e2e_video";
export const VIDEO_PROFILE = "Video Capture (e2e)";

// #1172 — the Open-Meteo weather/UV integration + the two-sided UV-dose sun model.
// A dedicated adult profile seeded with a home location, Fitzpatrick skin type,
// the weather connection ENABLED, an outdoor daytime activity today, and cached
// live UV for that day+location — so the weather spec can assert the integration
// page's connected state AND the timeline's live UV badge without touching profile
// 1's shared timeline/integration surfaces (whose exact state other specs pin).
// Isolated on purpose: the spec toggles the weather connection (enable/disable),
// which on profile 1 would race the review-inbox/integration specs.
export const E2E_LOGIN_WEATHER = "e2e_weather";
export const WEATHER_PROFILE = "Weather (e2e)";
