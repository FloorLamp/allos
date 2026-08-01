// Shared credential + fixture-profile names for the e2e dashboard fixtures. Composed
// into e2e/fixture-logins.ts (which every spec and seeder still imports from) —
// see that file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

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

// A dedicated READ-ONLY segmented-night fixture (#1190/#1191/#1283): every seeded
// night is a biphasic 23:00→03:00 (4h) + 04:00→08:00 (4h) pair with NO single block
// reaching the 6h main-sleep floor, so the merge must read them as ONE ~8h night
// (bed 23:00 → wake 08:00, no nap) rather than a 4h night + a separate nap. Seeded
// once before the suite in UTC; the browser spec never mutates or cleans it, so
// parallel / --repeat-each runs cannot race another test's state.
export const E2E_LOGIN_SLEEP_SEGMENTED = "e2e_sleep_segmented";
export const SLEEP_SEGMENTED_PROFILE = "Sleep Segmented (e2e)";

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

// The RECORDED-HISTORY half of the #1433 cold-start pair. Same demographics as
// PREVENTIVE_PROFILE above, but carrying deep-past preventive_events for two rules,
// so their intervals have genuinely elapsed and they band as real "Overdue" work.
// It is the negative control that keeps the never-recorded fix from degenerating
// into "preventive care never alarms": one profile proves zero evidence produces no
// alarm, the other proves evidence still does. Read-only in its spec, isolated
// login, so concurrent workers and --repeat-each can't contend.
export const E2E_LOGIN_PREVENTIVE_LAPSED = "e2e_preventive_lapsed";
export const PREVENTIVE_LAPSED_PROFILE = "Preventive Lapsed (e2e)";
// The two rules its seeded history covers, and the deep-past date they were last
// done on. Named here so the seeder and the spec can never disagree.
export const PREVENTIVE_LAPSED_RULES = [
  "dental_cleaning",
  "blood_pressure",
] as const;
export const PREVENTIVE_LAPSED_DATE = "2011-05-17";

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

// #1421 — the in-app "What's new" page and its per-login unread dot. A DEDICATED
// member login with its own profile, so the whats-new spec can clear this login's
// `whats_new_seen_date` marker in beforeEach and prove the fresh-login dot →
// visit → cleared transition repeatably (--repeat-each would otherwise see the
// marker its own first iteration wrote). Isolated because the marker is
// LOGIN-scoped: driving it on the shared admin storageState would flip the dot for
// every other spec's session. Carries no health data at all — the page reads the
// checked-in release-notes file, not the DB.
export const E2E_LOGIN_WHATSNEW = "e2e_whatsnew";
export const WHATS_NEW_PROFILE = "Whats New (e2e)";

// ── Dashboard "Now" strip + collapsible hero (issue #1413) ───────────────────
// Two spec-owned fixtures for e2e/dashboard-now.mobile.spec.ts.
//
// The first carries a JUST-FINISHED strength session (so the Now strip's highest
// signal fires deterministically — the strip is otherwise time-of-day dependent,
// and the e2e clock pins local time to 13:mm) plus one appointment scheduled
// TODAY, which gives the "Needs attention" hero a non-zero, stable count to
// collapse. It needs its own LOGIN because the collapse preference is stored per
// login (login_settings) and the spec toggles it — doing that on a shared login
// would leak a collapsed hero into every other spec's dashboard.
export const E2E_LOGIN_NOWSTRIP = "e2e_nowstrip";
export const NOW_STRIP_PROFILE = "Now Strip (e2e)";
export const NOW_STRIP_APPOINTMENT = "Now Strip checkup (e2e)";

// The second proves the #449 safety carve-out: a severe PHQ-9 reading (with a
// positive item 9) makes the crisis finding fire, and that item declares
// `suppressionPolicy: "safety-ungated"` — so its hero must render EXPANDED with no
// collapse control at all, no matter what the viewer's preference says. Separate
// from the profile above precisely because a safety-locked hero can't be collapsed:
// one profile cannot exercise both contracts.
export const E2E_LOGIN_NOWSAFETY = "e2e_nowsafety";
export const NOW_SAFETY_PROFILE = "Now Safety (e2e)";

// ── Just-recovered dashboard band folds (issues #1548 / #1549) ────────────────
// Three spec-owned caregiver fixtures for e2e/dashboard-household-folds.spec.ts, one
// per state of the household-history promo's placement. Every one is a MULTI-profile
// login (the promo is multi-profile only) whose parent profile is well and whose
// children carry a CLOSED illness episode at a chosen distance from the frozen run
// clock — the distance is the whole fixture, because the reopen window (7 days) is a
// strict subset of the promo window (14).
//
// The parent is created first so it holds the LOWEST id and therefore becomes each
// login's acting profile (createSession picks accessibleProfiles[0]), which is what
// makes the children's lines CROSS-PROFILE rows.
//
//   • FOLDREOPEN — two children resolved 3 and 5 days ago. Both inside the reopen
//     window, so the band shows two lines and the promo folds into it as a footer.
//     This is also the DISMISSAL fixture (#1548): the spec dismisses one line, reloads,
//     and then dismisses the second to watch the promo relocate. Its login_settings
//     dismissal key is therefore MUTATED by the spec — which is exactly why it is its
//     own login, and why the spec clears that key before each run so --repeat-each
//     iterations start from the same state.
export const E2E_LOGIN_FOLDREOPEN = "e2e_foldreopen";
export const FOLD_REOPEN_PARENT_PROFILE = "Fold Reopen Parent (e2e)";
export const FOLD_REOPEN_KID_A_PROFILE = "Fold Reopen Kid A (e2e)";
export const FOLD_REOPEN_KID_B_PROFILE = "Fold Reopen Kid B (e2e)";
export const FOLD_REOPEN_KID_A_SITUATION = "Croup";
export const FOLD_REOPEN_KID_B_SITUATION = "Strep throat";

//   • FOLDTAIL — one child resolved 10 days ago: past the 7-day reopen window, still
//     inside the 14-day promo window. The 8–14-day TAIL, where #1009's "surfaces near
//     the illness hero" rationale is void because the hero is long gone. No reopen band
//     exists, so the promo lands in the household strip's label row instead. The
//     household is deliberately QUIET (no attention items anywhere), so the strip has
//     NO chips — the orphan case #1549's sketch assumed away.
export const E2E_LOGIN_FOLDTAIL = "e2e_foldtail";
export const FOLD_TAIL_PARENT_PROFILE = "Fold Tail Parent (e2e)";
export const FOLD_TAIL_KID_PROFILE = "Fold Tail Kid (e2e)";

//   • FOLDWELL — one child resolved 20 days ago: outside BOTH windows. The house has
//     clearly recovered, so no reopen band and no promo anywhere. The negative control
//     that keeps the two folds above from degenerating into "always render it".
export const E2E_LOGIN_FOLDWELL = "e2e_foldwell";
export const FOLD_WELL_PARENT_PROFILE = "Fold Well Parent (e2e)";
export const FOLD_WELL_KID_PROFILE = "Fold Well Kid (e2e)";
