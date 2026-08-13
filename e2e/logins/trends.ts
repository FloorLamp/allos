// Shared credential + fixture-profile names for the e2e trends fixtures. Composed
// into e2e/fixture-logins.ts (which every spec and seeder still imports from) —
// see that file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

// #1067 Phase 1 — Trends → Overview → body census mobile overhaul. A dedicated adult profile with a
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
// weigh-ins, plus a streamed resting heart rate and one clinic-measured reading of that
// same identity, so the row it acts on is addressed by value or by its clinical marker,
// never by position.
// Write grant — every write is its own profile's, and the spec restores what it
// changes, so --repeat-each stays clean.
export const E2E_LOGIN_TRENDS_READINGS = "e2e_trends_readings";
export const TRENDS_READINGS_PROFILE = "Trends Readings (e2e)";
// The manual HRV value the spec corrects, and what it corrects it to. Named here so
// the seeder and the spec can't drift.
export const TRENDS_READINGS_HRV_MANUAL = 41;
export const TRENDS_READINGS_HRV_SYNCED = 67;
// The same profile also owns one streamed resting heart rate and ONE clinic-measured
// reading of the same identity, in the other store (#2032). That pair is what makes
// /trends/metric/resting-hr a page showing rows from two tables — the folded observation
// used to be read-only there, and correcting it in place is the phase-2 claim.
export const TRENDS_READINGS_RHR_STREAM = 58;
export const TRENDS_READINGS_RHR_CLINIC = 73;
// What the spec corrects the clinic reading TO. A fixed target, so the write is
// idempotent and --repeat-each stays clean.
export const TRENDS_READINGS_RHR_CORRECTED = 71;

// ── Ranked default chart-card order (issue #1490) ────────────────────────────
// THREE dedicated profiles, one per scenario the ranker must answer, because the
// whole claim is about what a NEVER-ARRANGED profile's body census leads with — an
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

// ── One fold for the chart and the table (issue #2029) ───────────────────────
// A profile whose resting-HR days are chosen to make the metric page's fold
// OBSERVABLE from the browser: one day carries a wearable reading AND a clinic
// reading of the same identity with the SAME value (the reported disagreement —
// the chart plotted it once, the table listed it twice), one day carries a clinic
// reading the stream never saw, and the rest are plain streamed days.
// Dedicated ON PURPOSE (#868): the assertion is an exact point/row count, so it
// cannot ride a fixture another spec writes to. Read-only in its spec.
export const E2E_LOGIN_METRIC_FOLD = "e2e_metric_fold";
export const METRIC_FOLD_PROFILE = "Metric Fold (e2e)";
// The value the wearable and the clinic BOTH report on the duplicated day.
export const METRIC_FOLD_DUPLICATED_BPM = 57;
// The clinic reading on a day the stream never covered — the completeness half
// (#1996), which must survive the fold and be counted once by both consumers.
export const METRIC_FOLD_CLINIC_ONLY_BPM = 73;
// Streamed days, newest last, each a distinct value so a row is addressable by it.
// The duplicated day is the middle one.
export const METRIC_FOLD_STREAM_DAYS = 3;
// What the page must end up showing: 3 streamed days + the clinic-only day. The
// duplicated clinic copy is in NEITHER the chart nor the table.
export const METRIC_FOLD_EXPECTED_READINGS = 4;

// ── Long-horizon tracking (issue #1938) ──────────────────────────────────────
// A dedicated ADULT profile with ~8 months of DAILY weigh-ins — the daily-cadence
// long series the 1Y quick range exists for. Dense past the aggregation span
// threshold, so the 1Y window must render the weekly-mean + band chart (with its
// honesty caption) while the default 90D window keeps plotting raw points; no
// shared fixture holds a long dense series without other specs exact-counting it.
// Read-only in its spec, so --repeat-each stays clean.
export const E2E_LOGIN_LONG_RANGE = "e2e_long_range";
export const LONG_RANGE_PROFILE = "Long Range (e2e)";
// Daily weigh-ins, ending yesterday. 240 days: comfortably past the 180-day
// aggregation threshold at 1Y while leaving the 90-day default window dense with
// raw points — the pair of states the spec contrasts.
export const LONG_RANGE_DAYS = 240;

// ── Respiratory function: peak flow with NO personal best (issue #1850) ──────
// A dedicated ADULT profile whose peak-flow readings arrive as a home stream and
// who has NOT declared a personal best. That absence IS the fixture: the zone card
// must state that there is no verdict rather than reaching for a population band
// peak flow does not have, and no shared profile can hold "readings but no declared
// best" without another spec's writes filling it in.
// Read-only in its spec, so --repeat-each stays clean.
export const E2E_LOGIN_PEAK_FLOW = "e2e_peak_flow";
export const PEAK_FLOW_PROFILE = "Peak Flow (e2e)";
// The most recent blow, in L/min. Distinctive so the readings table row is
// addressable by its value, and low enough that a borrowed "normal adult" band —
// if anything ever tried to supply one — would visibly call it something.
export const PEAK_FLOW_LATEST_LMIN = 437;
// How many daily blows the fixture seeds, ending yesterday.
export const PEAK_FLOW_DAYS = 6;

// ── Respiratory function: the logging path (issue #1850) ─────────────────────
// The write half's own profile, seeded EMPTY of peak-flow readings so the blow the
// spec logs is the only one on file — which is what makes the resulting zone an
// exact, assertable percentage rather than an average over whatever else happens to
// be there. Its writes are idempotent (a fixed date + clock time upserts on the
// stream's natural key; a fixed personal best re-saves to the same value), so
// --repeat-each stays clean.
export const E2E_LOGIN_PEAK_FLOW_LOG = "e2e_peak_flow_log";
export const PEAK_FLOW_LOG_PROFILE = "Peak Flow Log (e2e)";
// The blow the spec logs, and the best it declares: 480 of 600 is exactly 80% —
// the GREEN FLOOR, the band edge a reader would most easily get wrong.
export const PEAK_FLOW_LOG_BLOW_LMIN = 480;
export const PEAK_FLOW_LOG_BEST_LMIN = 600;

// ── Waist circumference: the metric the ruling created (issue #2322) ─────────
// A dedicated ADULT profile carrying a short history of tape readings, so the
// `waist-circ` detail page has a chart, a latest value and a readings table to
// assert against — and a WRITE half in the same profile: the reading its spec logs
// is dated to a deep-past day nothing else touches, so the exact-value assertions
// survive --repeat-each (the metric_samples natural key upserts on re-entry rather
// than stacking a second point).
//
// Dedicated ON PURPOSE (#868): the assertions are exact values, and profile 1's
// seeded waist series would make them ride a fixture other specs write to.
export const E2E_LOGIN_WAIST = "e2e_waist";
export const WAIST_PROFILE = "Waist (e2e)";
// The seeded latest reading, in cm. Distinctive so the readings table row and the
// hero value are addressable by their number.
export const WAIST_LATEST_CM = 87.3;
// How many seeded monthly readings precede it.
export const WAIST_SEEDED_READINGS = 4;
// The reading the spec LOGS. It lands on TODAY, which the seeded monthly series
// deliberately leaves empty, so it becomes the page's latest value; the manual sample
// writer upserts on its natural key, so a re-run corrects the day rather than
// stacking a second point.
export const WAIST_LOG_CM = 91.5;

// ── What a chart card may CLAIM about its latest value (issue #2615 item 3) ──
// A dedicated ADULT profile whose body census carries exactly the two states the
// chart cards used to render dishonestly, one per card, so each is observable
// alone:
//
//   • WEIGHT — two weigh-ins, the newer of them past `weight`'s presentation floor
//     (45 days). The card plots a real line and headlines a real number, and that
//     number is no longer today's — so the header must stamp the day it was read.
//     Two readings, not one, so the as-of claim is isolated from the single-reading
//     degrade below.
//   • BODY FAT — exactly ONE reading, recent enough that its currency is not in
//     question. A 90-day band with one dot clipped against the y-axis is the render
//     this replaces with the tiles' own single-reading mark.
//
// Dedicated ON PURPOSE (#868): both states are ABSENCES in disguise — "no second
// body-fat reading", "no weigh-in since" — and one neighbour's ordinary write
// destroys either. Read-only in its spec (it navigates only), so --repeat-each stays
// clean.
export const E2E_LOGIN_TRENDS_CURRENCY = "e2e_trends_currency";
export const TRENDS_CURRENCY_PROFILE = "Trends Currency (e2e)";
// Days back for each seeded reading. The weigh-ins straddle the 45-day floor so the
// OLDER one is stale too and the newer one decides; both sit inside the 90-day
// default window, so the card has a line to draw.
export const TRENDS_CURRENCY_WEIGH_IN_DAYS = [70, 50] as const;
export const TRENDS_CURRENCY_WEIGH_IN_KG = [80.6, 79.2] as const;
// The lone body-fat reading, well inside the window and well inside its own floor.
export const TRENDS_CURRENCY_BODY_FAT_DAYS = 10;
export const TRENDS_CURRENCY_BODY_FAT_PCT = 21.4;

// ── A series too thin for its stroke (issue #2653, state 5) ──────────────────
// A dedicated ADULT profile whose body census carries the density states side by
// side on one page, so the demotion and its CONTROL are observed in the same
// render and neither can pass by accident:
//
//   • WEIGHT — three weigh-ins, five hundred days apart. Over an all-time window
//     that is a two-metre stroke drawn through three facts; the card demotes the
//     line to a hint and states the count.
//   • BODY FAT — twenty consecutive daily readings. Same card grammar, same
//     window, a genuinely measured series: it keeps its confident stroke and says
//     nothing. If the floor logic were gutted to "always demote", this card is
//     what fails.
//
// Dedicated ON PURPOSE (#868): the weight state is an ABSENCE — "no weigh-in for
// a year and a half at a time" — and a single neighbouring write anywhere in that
// span destroys it. Read-only in its spec (it navigates only), so --repeat-each
// stays clean.
export const E2E_LOGIN_TRENDS_SPARSE = "e2e_trends_sparse";
export const TRENDS_SPARSE_PROFILE = "Trends Sparse (e2e)";
// Days back for each weigh-in, newest last. Five hundred days apart: past weight's
// 60-day continuity span by a wide margin, and the 1,001-day inclusive span is what
// makes the caption read in YEARS.
export const TRENDS_SPARSE_WEIGH_IN_DAYS = [1000, 500, 0] as const;
export const TRENDS_SPARSE_WEIGH_IN_KG = [83.4, 81.9, 80.1] as const;
// The caption the demoted weight plot must state, verbatim.
export const TRENDS_SPARSE_WEIGHT_CAPTION = "3 readings in 3 years";
// The dense control: twenty consecutive days of body fat, ending well clear of the
// newest weigh-in so no two rows share a date.
export const TRENDS_SPARSE_BODY_FAT_DAYS = 20;
export const TRENDS_SPARSE_BODY_FAT_OFFSET = 40;
export const TRENDS_SPARSE_BODY_FAT_PCT = 22.6;
