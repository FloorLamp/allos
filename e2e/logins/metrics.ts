// Shared credential + fixture-profile names for the e2e metrics fixtures. Composed
// into e2e/fixture-logins.ts (which every spec and seeder still imports from) —
// see that file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

// A member granted a dedicated profile carrying the two-document body-fat
// comparison fixture (#533): two DEXA documents plus a body-fat reading sourced
// from each (+ one manual reading). Dedicated ON PURPOSE — planting the documents
// on profile 1 made its body_fat multi-source (a surprise "Body fat" compare
// heading broke kids-growth's strict locator) and inflated its re-extract-all
// cost preview (review-inbox's "1 scan/PDF" copy pluralized). A fixture that flips
// a SHARED surface between single- and multi-source states gets its own profile.
export const E2E_LOGIN_COMPARE = "e2e_compare";
export const SOURCE_COMPARE_PROFILE = "Source Compare (e2e)";

// A member granted a dedicated sick profile whose ONLY temperature reading is a
// LEGACY imported Celsius row (unit 'Cel', source 'ccd', stored before the #1018
// import-boundary conversion existed), so the episode surfaces prove the
// read-time unit gate end-to-end in the browser: the latest temperature renders
// CONVERTED ("101.3 °F"), never the raw "38.5" plotted on the °F axis. Read-only
// in its spec, so it stays repeat-safe and never perturbs the other sick
// fixtures' cockpit assertions.
export const E2E_LOGIN_CEL_IMPORT = "e2e_cel_import";
export const CEL_IMPORT_PROFILE = "Cel Import (e2e)";

// #1171 / #1241 — the daylight-outdoor-minutes trend chart AND the free-days setting.
// A dedicated adult profile with a coarse home location (so the sun features are on)
// and outdoor daytime activities on SEVERAL recent days, so the Trends → Vitals
// "Sun / outdoor time" chart renders a real multi-day series. Also the host for the
// free-days checkbox row on Settings → Profile (#1241): the setting spec toggles this
// profile's own free_days, isolated so it never perturbs profile 1's shared sleep /
// social-jetlag surfaces (the sleep-regularity spec pins profile 1's SRI). Synthetic,
// no PHI.
export const E2E_LOGIN_SUN = "e2e_sun";
export const SUN_PROFILE = "Sun Outdoor (e2e)";
// The negative-case sibling: a profile with an outdoor activity but NO home location,
// so the sun features stay quietly OFF and the "Sun / outdoor time" chart is HIDDEN —
// the data-gate proven with the outdoor signal present, isolated from profile 1 (which
// DOES carry a seeded home location, so it can't serve as the home-less case).
export const E2E_LOGIN_SUN_NOHOME = "e2e_sun_nohome";
export const SUN_NOHOME_PROFILE = "Sun No Home (e2e)";

// Skin temperature variation on Trends → Body. A dedicated profile carrying a short
// run of nightly skin_temp_delta_c samples — SIGNED, spanning negative and positive, so
// the chart proves the delta survives ingest and per-day AVERAGING rather than being
// floored at zero or summed. Isolated from profile 1 so the shared vitals surface (and
// its manual-quick-add spec) is untouched. Synthetic, no PHI.
export const E2E_LOGIN_SKIN_TEMP = "e2e_skin_temp";
export const SKIN_TEMP_PROFILE = "Skin Temp (e2e)";

// #1081 — N-way activity duplicate merge (Review cluster card + Journal multi-merge).
// A dedicated ADULT member profile, isolated from profile 1 so the merge specs (which
// CONSUME their rows) never race a neighbor's blast radius. The spec re-seeds BOTH its
// fixtures from a shared seeder in beforeEach (repeat-safe, #868): a 3-row cross-source
// duplicate CLUSTER for the Review card, and a 3-row same-day group for the Journal
// multi-select merge. Synthetic data only.
export const E2E_LOGIN_NWAY = "e2e_nway";
export const NWAY_PROFILE = "N-Way Merge (e2e)";

// #1068 — the Timeline day view's intraday panel. A DEDICATED member login + adult
// profile carrying a full INTRADAY day: an overnight sleep session that starts before
// midnight (so its block is clipped, not re-attributed) with one deep-stage window,
// per-minute HR across the morning including a workout spike, a windowed cardio
// activity (the workout block), and two clock-timed document uploads (the tick rail).
// A SECOND day (three days back) carries only a day-grained weigh-in, so the same
// profile proves the panel's data gate — the day renders, the panel does not. The
// intraday day is TODAY, so the now-marker renders too. Dedicated on purpose: the
// panel keys on hr_minutes, which profile 1 has only inside the zone-ride window
// (training-zones.spec pins that day's zone totals), and a full day of all-day wear
// would change those numbers. Synthetic, no PHI.
export const E2E_LOGIN_INTRADAY = "e2e_intraday";
export const INTRADAY_PROFILE = "Intraday (e2e)";
export const INTRADAY_ACTIVITY = "Sunrise ride (e2e)";
export const INTRADAY_TICK_DOC = "e2e-intraday-morning-panel.pdf";
export const INTRADAY_TICK_TIME = "07:15";

// #1416 — the mobile shell pass. A DEDICATED member login + adult profile whose
// only job is to receive the ONE write the mobile shell spec makes: a body weight
// logged by walking the phone bar's quick-log sheet → "Log weight" → the existing
// Body quick-add form. Dedicated on purpose: the write proves the sheet reaches a
// REAL existing form (not a mock), and a weigh-in landing on a shared profile would
// move "latest weight" for the dashboard/coaching specs that assert it. Seeded with
// nothing at all — the spec asserts only the row it wrote, never a count — so
// --repeat-each and re-runs are safe. No birthdate → adult → never
// training-restricted, so the bar renders its full action cluster.
export const E2E_LOGIN_SHELL = "e2e_shell";
export const SHELL_PROFILE = "Mobile Shell (e2e)";
export const SHELL_WEIGHT_KG = "77.7";
// One scheduled supplement dose on that profile, seeded untaken, so the
// quick-log DOSE overlay has something real to confirm (#1468). Owned by
// quick-log-overlay.mobile.spec.ts, which clears its logs at test start.
export const SHELL_DOSE_ITEM = "Shell Overlay Vitamin (e2e)";
export const SHELL_DOSE_AMOUNT = "1000 IU";

// #1466 — the Trends → Vitals tab's Today strip + 1D (intraday) view. A DEDICATED
// member login + adult profile carrying a full VITALS day: per-minute HR across the
// morning (the 1D heart-rate chart), two TIMED blood-pressure pairs and two timed
// SpO2 readings ingest-shaped so each carries its reading instant (the time-positioned
// point charts), one manual temperature whose clock time rides its note, and a
// day-granular resting HR (the strip entry that has a value but no time). Dedicated
// on purpose: the 1D charts key on hr_minutes, which profile 1 has only inside the
// zone-ride window that training-zones.spec pins — a full morning of wear there would
// move those totals. Synthetic, no PHI; the spec only reads.
export const E2E_LOGIN_VITALS_DAY = "e2e_vitalsday";
export const VITALS_DAY_PROFILE = "Vitals Day (e2e)";
// The later of the day's two BP pairs — the one that must win the strip's "latest".
export const VITALS_DAY_BP_LATER = "126/82";
export const VITALS_DAY_BP_LATER_TIME = "09:40";
export const VITALS_DAY_TEMP_TIME = "08:05";
export const VITALS_DAY_RESTING_HR = "54";

// A member granted a dedicated ADULT profile carrying NOTHING but the two
// age-derived preventive findings every adult profile gets (COVID-19, Influenza),
// used by app-badge.mobile.spec.ts (#1424). Dedicated ON PURPOSE: proving the
// app-icon badge CLEARS requires driving a hero all the way to "All clear", and
// the only way there is dismissing those two findings — a write that would
// silently change the dashboard every other fixture profile renders. The spec
// resets this profile's `upcoming_dismissals` at test start, so the set→clear
// sequence is identical on every run and under --repeat-each.
export const E2E_LOGIN_BADGE = "e2e_badge";
export const APP_BADGE_PROFILE = "App Badge (e2e)";
