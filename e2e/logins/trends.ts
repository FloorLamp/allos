// Shared credential + fixture-profile names for the e2e trends fixtures. Composed
// into e2e/fixture-logins.ts (which every spec and seeder still imports from) —
// see that file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

// #1067 Phase 1 — Trends → Body mobile overhaul. A dedicated adult profile with a
// KNOWN, PARTIAL set of synced body metrics so the chart-jump chips + per-chart
// anchors are deterministic: it has manual + synced weight/resting HR (the
// body-composition block and source-control fixture), derived BMI, steps, a sleep
// night, and one day of heart-rate minutes — but NO
// hydration / BMR / calories / lean-mass etc., so those metrics' chips must
// be ABSENT (the "chartless charts hide their chip" assertion). Read-only grant;
// the spec only navigates + scrolls (no writes), so --repeat-each stays clean.
export const E2E_LOGIN_TRENDS_BODY = "e2e_trends_body";
export const TRENDS_BODY_PROFILE = "Trends Body (e2e)";
export const TRENDS_BODY_OLD_DAY = "2024-01-15";

// ── Curated Trends Overview (issue #1487 rendering half / #1485 A+B) ─────────
// A dedicated adult profile for the membership-driven Overview grid. It owns a
// KNOWN tile mix so both halves of the grid are deterministic at phone width:
//   populated → weight + resting HR (two weigh-ins, so two tiles draw a sparkline)
//   empty     → body fat + training volume (never logged) and a starred analyte
//               with no readings at all → the #1485 A compact one-line rows
// Dedicated ON PURPOSE (#868): the spec UNSTARS a standard metric and stars it
// back through the picker. Doing that on profile 1 would move a shared-seed tile
// to the front of the saved order (a re-star is a fresh save) and change the grid
// every other Trends spec reads. Write grant — the spec's writes are its own
// profile's saved_items, and it restores them itself, so --repeat-each stays clean.
export const E2E_LOGIN_TRENDS_CURATE = "e2e_trends_curate";
export const TRENDS_CURATE_PROFILE = "Trends Curate (e2e)";
// A canonical analyte this profile has NO readings for — the never-measured saved
// tile. (Profile 1 seeds its own; this one must not depend on that.)
export const TRENDS_CURATE_EMPTY_ANALYTE = "Ferritin";

// ── Compare folds into Insights (issue #1489) ────────────────────────────────
// A dedicated, TRAINING-RESTRICTED profile (birthdate ~10y ago, under the
// instance gate of 13 seeded by e2e/seed/coverage-gaps.ts) carrying weight +
// resting-HR readings on shared dates, so the compare overlay actually draws for a
// minor. It proves the #1489 gate move: the Insights tab is now offered to a
// restricted profile, carrying ONLY its age-neutral compare section.
//
// Dedicated ON PURPOSE (#868): the other restricted profile — the seeded ~18-month
// "Riley (child)" — has no second metric to overlay. Read-only in its spec
// (navigation only), so --repeat-each stays clean.
export const E2E_LOGIN_TRENDS_COMPARE = "e2e_trends_compare";
export const TRENDS_COMPARE_PROFILE = "Trends Compare (e2e)";

// ── Fitness becomes the windowed analytics lens (issue #1492) ────────────────
// A dedicated ADULT profile whose training data deliberately STRADDLES the 90-day
// default window: recent strength + cardio + sport sessions INSIDE it, and a
// deep-past block (2026-01-*, well outside any relative window) that only appears
// once the range is switched to All time. That's what makes "a range change
// re-windows every chart" observable rather than asserted on a guess — the volume
// bars, the heatmap columns, the zone/cardio weeks and the est-1RM trend all change
// shape between 90D and All time.
//
// Dedicated ON PURPOSE (#868): the shared seed's profile 1 has 16 weeks of PPL plus
// every other spec's layered activities, so an exact-count assertion there would
// break on a neighbor's write. Read-only in its spec (navigation + range chips
// only), so --repeat-each stays clean.
export const E2E_LOGIN_TRENDS_FITNESS = "e2e_trends_fitness";
export const TRENDS_FITNESS_PROFILE = "Trends Fitness (e2e)";
// The lift the fixture trains most often INSIDE the window, so the est-1RM trend
// names it deterministically.
export const TRENDS_FITNESS_LIFT = "Front Squat";
// A lift trained ONLY in the deep past — absent at 90D, present at All time.
export const TRENDS_FITNESS_OLD_LIFT = "Pendlay Row";

// ── Chart tap-through + the metric detail readings table (issue #1488) ───────
// A dedicated adult profile for the readings table's row CRUD. Dedicated ON PURPOSE
// (#868): the spec EDITS and DELETES readings, and doing that on a shared-seed
// profile would move numbers every other Trends spec asserts on. It owns exactly two
// HRV samples (a manual one it edits, an imported one it leaves alone) and two
// weigh-ins, so the row it acts on is addressed by value, never by position.
// Write grant — every write is its own profile's, and the spec restores what it
// changes, so --repeat-each stays clean.
export const E2E_LOGIN_TRENDS_READINGS = "e2e_trends_readings";
export const TRENDS_READINGS_PROFILE = "Trends Readings (e2e)";
// The manual HRV value the spec corrects, and what it corrects it to. Named here so
// the seeder and the spec can't drift.
export const TRENDS_READINGS_HRV_MANUAL = 41;
export const TRENDS_READINGS_HRV_SYNCED = 67;

// ── Ranked default chart-card order (issue #1490) ────────────────────────────
// THREE dedicated profiles, one per scenario the ranker must answer, because the
// whole claim is about what a NEVER-ARRANGED profile's Body tab leads with — an
// assertion that a neighbour's write (or a shared-seed goal/condition) would flip.
//
//   • PEDS   — a ~6-year-old with heights + weigh-ins: the growth-percentile card
//              leads the stack (the retired planBodyCharts fork, now the life-stage
//              signal).
//   • GOAL   — an adult with a LIVE weight goal plus blood-pressure readings: the
//              Composition run and its weight card lead, ahead of Vitals.
//   • PLAIN  — an adult with the SAME data shape as GOAL but no goal, no condition
//              and no growth: the identity case, whose tab must match the static
//              layout exactly. This is the regression guard — it is what fails if a
//              signal ever starts firing for a profile the app knows nothing about.
//
// All three are read-only (their specs navigate only), so --repeat-each stays clean.
export const E2E_LOGIN_TRENDS_RANK_PEDS = "e2e_trends_rank_peds";
export const TRENDS_RANK_PEDS_PROFILE = "Trends Rank Peds (e2e)";
export const E2E_LOGIN_TRENDS_RANK_GOAL = "e2e_trends_rank_goal";
export const TRENDS_RANK_GOAL_PROFILE = "Trends Rank Goal (e2e)";
export const E2E_LOGIN_TRENDS_RANK_PLAIN = "e2e_trends_rank_plain";
export const TRENDS_RANK_PLAIN_PROFILE = "Trends Rank Plain (e2e)";

// ── ★-pinned Body card order (issue #1643) ───────────────────────────────────
// A WRITE-granted member whose profile carries exactly two Body cards with data —
// weight (a standard seed, so already starred) and steps (not seeded, so unstarred
// and sitting in its ranked slot below weight). That contrast is the whole fixture:
// starring steps must move it ahead of weight, re-sequencing it on Overview must
// move it back, and unstarring must return it to its ranked slot. The spec restores
// the seed state, so --repeat-each stays clean and no neighbour's order moves.
export const E2E_LOGIN_TRENDS_PIN = "e2e_trends_pin";
export const TRENDS_PIN_PROFILE = "Trends Pin (e2e)";

// ── Day one, and what a "7-day average" covers (issues #1909 / #1917) ────────
// A dedicated WRITE-granted member whose profile is seeded with NO readings at
// all, because the state under test is the ABSENCE of history: on the day of a
// first-ever weigh-in the Rolling summary has no complete day to average, and it
// must show that reading labelled as today's rather than "No readings".
//
// Dedicated ON PURPOSE (#868): "this profile has never recorded this metric" is a
// state no shared fixture can be in for long — one neighbour's weigh-in destroys
// it — and the spec deliberately drives the profile THROUGH the states either
// side of day one (a stale reading, then a full week), so it owns every
// body_metrics / protein_log row on it and re-seeds them at test start.
//
// The same profile carries the nutrition half: every COMPLETE day in the trailing
// window logs the same protein, so the dashboard card's "7-day average" is one
// exact number whatever weekday the frozen clock lands on — while today logs a
// deliberately different one, which is what the old week-to-date figure carried
// into a line labelled "7-day average".
export const E2E_LOGIN_DAY_ONE = "e2e_day_one";
export const DAY_ONE_PROFILE = "Day One (e2e)";
export const DAY_ONE_WEIGHT_KG = 76.4;
// A weigh-in far enough back that the 7-day window cannot reach it (the "a gap is
// not day one" case), while 30d and 90d still summarise it.
export const DAY_ONE_STALE_DAYS_AGO = 20;
export const DAY_ONE_STALE_WEIGHT_KG = 81.2;
// Protein grams: the same figure on every complete day in the window, and a very
// different one today.
export const DAY_ONE_PROTEIN_COMPLETE_DAY = 100;
export const DAY_ONE_PROTEIN_TODAY = 300;

// ── Relevance-ranked biomarker pickers (issue #1675) ─────────────────────────
// A dedicated WRITE-granted member whose profile owns exactly the facts the rank
// reads, so "the markers that matter lead" is observable rather than guessed:
//   • an OVERDUE analyte  — HbA1c on its 90-day cadence, drawn ~400 days ago
//   • a FLAGGED analyte   — an LDL well over the canonical band, drawn recently
//                           (so the flag, not a stale draw, is what promotes it)
//   • a MEASURED analyte  — an in-range Albumin, alphabetically FIRST of the three,
//                           which is exactly what an alphabetical picker led with
// Dedicated ON PURPOSE (#868): the spec stars an analyte through the ★ picker and
// unstars it again, and doing that on profile 1 would reorder the shared saved grid
// every other Trends spec reads. The spec restores what it writes, so --repeat-each
// stays clean.
export const E2E_LOGIN_BIOMARKER_PICKER = "e2e_biomarker_picker";
export const BIOMARKER_PICKER_PROFILE = "Biomarker Picker (e2e)";
export const BIOMARKER_PICKER_OVERDUE = "Hemoglobin A1c";
export const BIOMARKER_PICKER_FLAGGED = "LDL Cholesterol";
export const BIOMARKER_PICKER_MEASURED = "Albumin";

// ── One judgement per identity (issues #1996 / #1997) ────────────────────────
// A dedicated CHILD profile (~2 years old) whose resting heart rate arrives ONLY
// as a wearable stream, plus ONE clinic-measured "Resting Heart Rate" observation
// in the other store. That pair is the whole of #1996 in one fixture:
//   • the streamed trend sits at ~120 bpm — perfectly normal for a toddler against
//     the curated 1–3 band (80–150), and "Above range" against the adult 50–100 —
//     so the age band being APPLIED is observable rather than asserted on a guess;
//   • the observation shares the readings' identity but not their table, so the
//     metric surface must fold it in and MARK it (it is read-only there).
// Dedicated ON PURPOSE (#868): no shared fixture can hold "a child whose only
// readings stream", and the compare-fold profile's exact series is read by its own
// spec. Read-only here — the spec navigates only, so --repeat-each stays clean.
export const E2E_LOGIN_METRIC_JUDGMENT = "e2e_metric_judgment";
export const METRIC_JUDGMENT_PROFILE = "Metric Judgment (e2e)";
// The clinic-measured reading, in bpm — on a day the stream does not cover, so it
// is visibly an ADDITION to the trend rather than a duplicate of it.
export const METRIC_JUDGMENT_CLINIC_BPM = 128;
