// Shared credential + fixture-profile names for the e2e situations fixtures. Composed
// into e2e/fixture-logins.ts (which every spec and seeder still imports from) —
// see that file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

// A dedicated ADULT profile for the menstrual-cycle spec (#714). Seeded with three
// completed, roughly-regular periods (so the derived phase, the cycle-length +
// variability trend, and the regularity read all render) and NO open period. Isolated +
// spec-owned on purpose: the cycle spec MUTATES this profile's cycles (one-tap start/end,
// add/delete a period) and it self-cleans within the spec, so it never races profile 1's
// seeded cycle data that the Timeline/phase-chip assertions read.
export const E2E_LOGIN_CYCLE = "e2e_cycle";
export const CYCLE_PROFILE = "Cycle Log (e2e)";

// Cycle plausibility guards (issue #1682). A member granted its OWN dedicated adult
// profile carrying a period left OPEN well past the plausible maximum — the "forgot to tap
// Period ended" state, which must read as a prompt rather than as menstrual forever. Kept
// apart from CYCLE_PROFILE precisely because that fixture must have NO open period: one
// profile cannot be in both states, and the stale-open spec is read-only about its own
// period (it never closes it), so it stays stable under --repeat-each. Synthetic, no PHI.
export const E2E_LOGIN_CYCLE_STALE = "e2e_cycle_stale";
export const CYCLE_STALE_PROFILE = "Cycle Stale Open (e2e)";

// The cycle LOG-AFFORDANCE fixtures (issue #1892). Two dedicated adult FEMALE profiles,
// both cycle-RELEVANT by life stage rather than by data, because the whole point is the
// state a profile is in BEFORE it has any cycle data:
//
//   • CTA — no cycle rows at all. This is the state the dashboard phase widget used to
//     SELF-HIDE on, which is precisely the state of someone who has not logged day 1 yet.
//     The spec mutates it (start → end → the reopen window) and clears its own rows before
//     every test, so --repeat-each starts from the same place.
//   • GAP — one period that ended 5 days ago: too old for the "Still bleeding" reopen
//     (> REOPEN_PERIOD_MAX_AGE_DAYS) and too soon for a plausible start
//     (< MIN_PLAUSIBLE_PERIOD_GAP_DAYS), so the card renders the derived phase and offers
//     NO button at all. Read-only, so it stays stable under --repeat-each.
//
// Both are separate from CYCLE_PROFILE, which must keep its three-period history for the
// Cycle-page spec's trend and regularity assertions. Synthetic, no PHI.
export const E2E_LOGIN_CYCLE_CTA = "e2e_cycle_cta";
export const CYCLE_CTA_PROFILE = "Cycle Log CTA (e2e)";
export const E2E_LOGIN_CYCLE_GAP = "e2e_cycle_gap";
export const CYCLE_GAP_PROFILE = "Cycle Log Gap (e2e)";

// Derived situations (issues #1292/#1298). A member granted a dedicated adult FEMALE
// (premenopausal → cycle-relevant) profile carrying a Period-keyed iron supplement and a
// Poor-sleep-keyed magnesium, and a rough last-night sleep session so the DERIVED
// poor-sleep context is measured-ON. Dedicated + isolated on purpose: the spec LOGS and
// ENDS a period (its own idempotent inverse) and toggles the Poor sleep chip, so it must
// never race the cycle-log spec's mutations on CYCLE_PROFILE. No open period is seeded,
// so today starts a gap day (Period context off) until the spec logs one. Synthetic, no PHI.
export const E2E_LOGIN_DERIVED = "e2e_derived_situ";
export const DERIVED_SITU_PROFILE = "Derived Situations (e2e)";
export const DERIVED_SITU_PERIOD_ITEM = "Iron Bisglycinate (e2e)";
export const DERIVED_SITU_SLEEP_ITEM = "Magnesium Glycinate (e2e)";
// Keyed to the built-in "High pollen" WEATHER situation (#1726) — it goes due from the
// cached daily series alone, with no toggle anywhere.
export const DERIVED_SITU_POLLEN_ITEM = "Quercetin Complex (e2e)";

// Situation-window analytics (issue #1297). A member granted a dedicated adult profile
// carrying a DECLARED "Travel" transition window (a past start→stop pair) with real weight
// + resting-HR readings across the during days AND the surrounding baseline, so the Trends →
// Insights tab renders the pooled "Situation impact" card for Travel — plus a one-day
// "High stress" toggle that has too little windowed history to render (the absent-pillar
// negative case). Dedicated + read-only so the pooled deltas stay stable under --repeat-each.
export const E2E_LOGIN_SITIMPACT = "e2e_sitimpact";
export const SITUATION_IMPACT_PROFILE = "Situation Impact (e2e)";

// Trying to conceive (issues #1679/#1680). A member granted its OWN dedicated ADULT
// FEMALE profile carrying SIX regular ~28-day cycles — enough history for a NARROW
// next-period window, which the forecast spec asserts — plus a DECLARED trying-to-conceive
// start and a follicular BBT baseline. Dedicated and isolated on purpose: it must have a
// forecastable history (CYCLE_PROFILE deliberately has only three periods, so it renders
// the "log a couple more cycles" note the same spec asserts as the negative case), and the
// TTC spec taps observation buttons whose rows it owns. Synthetic, no PHI.
export const E2E_LOGIN_TTC = "e2e_ttc";
export const TTC_PROFILE = "Trying To Conceive (e2e)";
