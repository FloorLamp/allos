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
