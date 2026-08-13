// Shared credential + fixture-profile names for the e2e training fixtures. Composed
// into e2e/fixture-logins.ts (which every spec and seeder still imports from) —
// see that file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

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

// ── Endurance event plans (#839) ──────────────────────────────────────────────
// A dedicated ADULT profile with a few weeks of logged runs (so a created plan's
// trajectory has a real base + this-week actuals), and NO endurance_plans row — the
// spec OWNS the create/complete/delete lifecycle on it (create-and-clean, #868), so
// its writes never race the shared seed's seeded plan. No birthdate → adult → never
// training-restricted, so /training renders the full hub with the Event-plans bar.
export const E2E_LOGIN_ENDURANCE = "e2e_endurance";
export const ENDURANCE_PROFILE = "Endurance Plan (e2e)";

// ── Training → Overview, the doing surface (#1496) ────────────────────────────
// A dedicated ADULT profile whose recent strength log is deliberately LIGHT across
// several small muscles (2 sets each of curls / skullcrushers / lateral raises /
// crunches / calf raises inside the trailing 7-day window, plus earlier weeks so the
// #719 cold-start gate is satisfied), so the per-muscle volume-band engine (#742)
// fires SEVERAL shortfalls at once — exactly the pile the Overview rollup folds into
// one card. Dedicated on purpose (#868): the spec DISMISSES one of those findings, and
// a suppression write on a shared profile would silence a neighbor's finding. NO
// routine and NO injury, so nothing gates the observations (deload / injured region).
export const E2E_LOGIN_TRAINING_ROLLUP = "e2e_training_rollup";
export const TRAINING_ROLLUP_PROFILE = "Training Rollup (e2e)";

// ── Strength load contexts (#1610) ────────────────────────────────────────────
// A dedicated ADULT profile that has logged ONE exercise name on TWO registry
// machines at deliberately non-comparable loads — the reported bug's exact shape.
// Both machines are needed for anything here to be observable: with one implement
// there is no chooser to render, no second series to label, and no ambiguity for the
// goal form to resolve. Dedicated on purpose (#868): the spec creates a goal, and a
// goal write on a shared profile would race a neighbor. Every date is relative so
// the fixture never goes stale.
export const E2E_LOGIN_LOAD_CONTEXT = "e2e_load_context";
export const LOAD_CONTEXT_PROFILE = "Load Context (e2e)";
// The one logged exercise name both machines serialize as — no name-derived key can
// tell them apart, which is the whole point of #1610.
export const LOAD_CONTEXT_LIFT = "Machine Chest Press";
export const LOAD_CONTEXT_HOME = "Zzz home chest press (e2e)";
export const LOAD_CONTEXT_HOTEL = "Zzz hotel chest press (e2e)";

// ── Lab-value goals (#1853) ───────────────────────────────────────────────────
// A dedicated WRITE-granted ADULT profile whose readings make a biomarker goal
// observable end to end:
//   • LAB_GOAL_TRACKED  — an LDL with a HIGH baseline draw and a later, lower one,
//                         so a seeded "under 100" goal has real progress, a real
//                         as-of date and a real check-in date to render.
//   • LAB_GOAL_OVERDUE  — an HbA1c drawn ~400 days ago on its 90-day cadence, so
//                         the picker's "Due or flagged" group is non-empty and the
//                         ranked order is observable rather than assumed. (The LDL
//                         above is over its band, so it is FLAGGED and joins that
//                         same group, behind the overdue draw.)
//   • LAB_GOAL_IN_RANGE — an in-range Albumin, so the picker's third group ("Your
//                         markers") is non-empty too and all three headers render.
// Dedicated on purpose (#868): the spec CREATES a goal through the form and deletes
// it again, and a goal write on a shared profile would race a neighbour. Every date
// is relative, so the fixture never goes stale.
export const E2E_LOGIN_LAB_GOAL = "e2e_lab_goal";
export const LAB_GOAL_PROFILE = "Lab Goal (e2e)";
export const LAB_GOAL_TRACKED = "LDL Cholesterol";
export const LAB_GOAL_OVERDUE = "Hemoglobin A1c";
export const LAB_GOAL_IN_RANGE = "Albumin";
// The seeded goal's target, in the analyte's canonical unit.
export const LAB_GOAL_TARGET = 100;

// ── The week spine (#2566, Viz 1) ─────────────────────────────────────────────
// A dedicated ADULT profile whose training week is a KNOWN, hand-pinned shape, so the
// band's blocks can be asserted as literals rather than recomputed from the same code
// that draws them. `week_mode` is forced to ROLLING, which makes the window always
// [today − 6, today] whatever weekday the frozen clock lands on — the offsets below
// are then the picture:
//
//   −6 nothing · −5 nothing · −4 sport ×1 · −3 mobility ×1 · −2 nothing
//   −1 cardio ×1 · today strength ×2
//
// Two decoys sit deliberately OUTSIDE the window at both ends: a session eight days
// back, and a run dated TOMORROW. Neither may appear in the band or in the caption's
// counts. Dedicated on purpose (#868): the spec asserts exact per-day counts, which a
// neighbour's ordinary training write on a shared profile would destroy. Every date is
// relative, so the fixture never goes stale.
export const E2E_LOGIN_WEEK_SPINE = "e2e_week_spine";
export const WEEK_SPINE_PROFILE = "Week Spine (e2e)";
