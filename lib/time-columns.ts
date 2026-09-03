// THE DECLARED TEMPORAL-COLUMN INDEX (issue #2205, phase 3).
//
// ── THE QUESTION THIS ANSWERS ────────────────────────────────────────────────
//
// "What does this column mean, and what shape is in it?" Two analyses in one evening
// produced confidently wrong answers from correct-looking SQL because that question
// had no answer anywhere: the reader assumed a convention for a table and the schema
// disagreed silently. #2090 tried to answer it in prose and was closed because prose
// rots. This is the same index as data, with a scan
// (lib/__db_tests__/time-column-index.test.ts) that runs it against the migrated
// schema, so a new table with an undeclared temporal column fails CI.
//
// ── WHY THE INDEX AND THE ROW READERS ARE ONE ARTIFACT ───────────────────────
//
// lib/row-instants.ts asks a ROW-level question — "when did this happen", "when was
// it recorded" — and to answer it, it has to know which column of which table carries
// which semantic. That mapping and this index are THE SAME FACT. Keeping them apart
// would mean two declarations of one thing, which is exactly how the prose index
// rotted. So the readers consult this registry and nothing else, and the published
// docs page (docs/internals/time-columns.md) is GENERATED from it
// (`npm run gen:time-columns`) with the pure test asserting the committed file still
// matches. A rename in phase 2 therefore edits one entry, and the readers, the scan
// and the docs all follow.
//
// ── WHAT IS DECLARED, AND WHAT IS DELIBERATELY NOT ───────────────────────────
//
// `semantic` and `grain` are claims about MEANING and are settled here. `convention`
// is a claim about the stored SERIALIZATION and is only as good as its evidence — a
// column DEFAULT (which the scan checks against this file) or a writer that was read.
// Where neither settles it, the entry says `unverified` WITH a note, rather than
// guessing. That is not rot: it is the phase-2 worklist, counted and frozen by the
// scan so it can only shrink.
//
// Nothing here changes schema. Phase 3 lands BEFORE phase 2's renames, so every entry
// is keyed on the column name that exists today; phase 2's job is to change the name
// in the migration and in the matching entry, in one change.
//
// PURE — no DB, no clock, no imports beyond types. The scan opens the database; this
// file only declares.

// What a temporal column MEANS.
export type TimeSemantic =
  // When the thing itself happened, as best the row knows.
  | "event"
  // When it entered the app. Never a substitute for `event` — see lib/row-instants.ts.
  | "record"
  // The subject's own window.
  | "window-start"
  | "window-end"
  // A profile-local day attribution (#94). NOT a lesser instant, and untouched by
  // #2205 by constraint.
  | "day"
  // An intended or expected future time — a plan, a lease, an expiry. Not an
  // observation, so it must never answer "when did this happen".
  | "planned"
  // A transition in the ROW's own life (revoked, consumed, resolved, superseded).
  // About the record, not about the subject.
  | "lifecycle"
  // A creation/update stamp that is not the fact the row records.
  | "bookkeeping";

// What SHAPE of time is stored — i.e. what you need in hand to turn it into an
// absolute moment.
export type TimeGrain =
  // Absolute; resolvable with no extra context.
  | "instant"
  // A profile-local calendar day, YYYY-MM-DD.
  | "day"
  // A zoneless local datetime (YYYY-MM-DDTHH:MM). Needs a zone to become an instant.
  | "local-datetime"
  // A bare HH:MM. Needs a date AND a zone.
  | "time-of-day"
  // The column holds more than one of the above, by design or by history. Requires a
  // note saying which, because this is the shape that produces wrong answers.
  | "mixed";

// What SERIALIZATION an `instant`-grain column stores.
export type TimeConvention =
  // 'YYYY-MM-DDTHH:MM:SSZ' — lib/date.ts utcInstant. The target convention.
  | "canonical"
  // 'YYYY-MM-DD HH:MM:SS' — SQLite's own datetime('now'), UTC, no zone stated.
  | "bare"
  // '…THH:MM:SS.mmmZ' — a JS toISOString that reached storage.
  | "iso-ms"
  // More than one of the above live in the column. Requires a note.
  | "mixed"
  // Not settled by a DEFAULT or by a writer that was read. Requires a note.
  | "unverified"
  // The column is not instant-grained, so there is no instant convention to state.
  | "n/a";

export interface TimeColumn {
  column: string;
  semantic: TimeSemantic;
  grain: TimeGrain;
  convention: TimeConvention;
  // Required for `mixed` and `unverified`, and for anything a reader would otherwise
  // get wrong (an `_at` that is a day, an exclusive end, an inferred event).
  note?: string;
}

// Column names that MATCH the temporal-name detector below but are not times. Listed
// with a reason so the scan's completeness rule can be strict about everything else.
export const NOT_TEMPORAL: Record<string, string> = {
  time_source:
    "food_log_events: an enum ('tap' | 'stated'), the provenance of occurred_at.",
  weekdays:
    "intake_item_doses / schedule versions: a weekday mask for a schedule, not a moment.",
  cadence_weekdays:
    "intake_items: a weekday mask for an interval cadence, not a moment.",
  endpoint:
    "push_subscriptions: a URL. Matches only because it contains 'end'.",
  unattended_fail_message:
    "portal_run_reports: prose. Matches only because it contains 'end'.",
  candidates:
    "routine_slots: a JSON list. Matches only because it contains 'date'.",
};

// A column name that PLAUSIBLY carries a time. Deliberately over-broad: a false
// positive costs one NOT_TEMPORAL entry with a reason, while a false negative lets an
// undeclared temporal column into the schema, which is the failure this scan exists to
// prevent. Applied only to TEXT columns, which is what drops every duration and count
// (`moving_time_sec`, `follow_up_interval_days`, `start_index`).
export const TEMPORAL_NAME_RE =
  /date|time|day|when|start|end|stamp|expir|seen|since|until|_at$|_ts$|_on$|^at$|^ts$/i;

// The index. One entry per temporal column of every table in the migrated schema; the
// scan fails on anything present in one and missing from the other.
export const TIME_COLUMNS = {
  activities: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "start_time",
      semantic: "window-start",
      grain: "time-of-day",
      convention: "n/a",
      note: "A profile-local HH:MM, optional (a hand-entered activity may state only a day). It is NOT an instant: resolving it needs the row's `date` AND the profile timezone. Every writer agrees — `NormActivity.start_time` is declared HH:MM for all integrations, the editor's field is a `type=\"time\"` input, and the AI extractor's ISO shape is folded to HH:MM at the persist boundary (`activityClockHHMM`, #2245).",
    },
    {
      column: "end_time",
      semantic: "window-end",
      grain: "time-of-day",
      convention: "n/a",
      note: "The same profile-local HH:MM as start_time, and NULL both for a hand-entered activity that stated only a day and while a live session is unfinished.",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
      note: "Still bare, but no longer written by SQL: every app write path BINDS it from the clock seam (`sqlNow()`, #2287) instead of leaning on the column's own SQL-clock DEFAULT. `computeWorkoutPresence` reads it as a draft's first-seen instant (and as an imported row's freshness anchor) and subtracts it from a seam-derived now, so a stamp off SQL's real clock made a seconds-old draft read as an hour quiet whenever the two clocks diverged. The DEFAULT stays — it lives in a shipped migration — and is now only a backstop.",
    },
    {
      column: "updated_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
      note: "The #451 auto-save stamp, and the LIVENESS signal workout presence prefers over `created_at` (lastTouchMs = updated_at ?? created_at). Bound from the clock seam (`sqlNow()`, #2287) at every writer for the same reason: it is compared to the app's now, not merely displayed.",
    },
  ],
  activity_telemetry: [
    {
      column: "snapshot_at",
      semantic: "record",
      grain: "instant",
      convention: "unverified",
      note: "Supplied by the Strava sync as a caller argument; its serialization is whatever that path produced. Nothing compares it in SQL, so phase 1 left it unclaimed.",
    },
  ],
  activity_videos: [
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  ai_usage_counters: [
    { column: "day", semantic: "day", grain: "day", convention: "n/a" },
  ],
  allergies: [
    {
      column: "onset_date",
      semantic: "event",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  allergy_reactions: [
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  api_tokens: [
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "last_used_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "revoked_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "bare",
    },
  ],
  appointments: [
    {
      column: "date",
      semantic: "planned",
      grain: "day",
      convention: "n/a",
      note: "The CLINIC-local calendar day of the visit (#2234) — NOT a profile-local day: the clinic is frequently not in the profile's zone, and the value is never resolved against the profile timezone. NOT NULL.",
    },
    {
      column: "time_of_day",
      semantic: "planned",
      grain: "time-of-day",
      convention: "n/a",
      note: "The CLINIC-local wall clock (HH:MM), NULL for a day-only booking — a real product state, not a missing time. Resolving it to an instant needs the row's date AND the clinic's zone, which the app does not store (#2243 owns that question); it is never resolved against the profile timezone.",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  audit_events: [
    { column: "ts", semantic: "record", grain: "instant", convention: "bare" },
  ],
  body_metrics: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "occurred_at",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "Migration 165 (#2235, #2205 phase 2 wave 1). When the day's weigh-in was actually taken. Body weight moves a kilogram across a day, so morning-fasted and evening-fed are different measurements of one quantity and an unlabelled mix carries that swing as unattributable noise. NULL means DAY-GRAIN. Descriptive only — the natural key stays (profile_id, date, source), and one row per day is unchanged, so this records WHEN the day's reading was taken and does not enable two weigh-ins in one day. This table has no record stamp at all, so there is nothing here for an event column to be laundered from. It is the time the PERSON stated for their sitting; the three per-measure columns below are what the SOURCE said about each measure, and neither answers the other's question.",
    },
    {
      column: "weight_at",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "Migration 20260902-body-metric-measure-instants (#3950, owner-ruled 2026-08-29). When the SOURCE says this day's stored weight was measured. Health Connect delivers weight, body fat and resting HR with their own instants, so one shared column cannot hold three — a 07:00 fasted weigh-in stamped with the day's latest instant reads as 22:00. NULL means the source stated no instant. Descriptive: the natural key stays (profile_id, date, source) and the #608 two-device dedup is untouched.",
    },
    {
      column: "body_fat_at",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "Migration 20260902-body-metric-measure-instants (#3950). As weight_at, for the day's body-fat reading. Body fat is stored as the DAY AVERAGE, so this is the instant of the reading whose value the merge kept, not of the average.",
    },
    {
      column: "resting_hr_at",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "Migration 20260902-body-metric-measure-instants (#3950). As weight_at, for the day's resting-HR reading, with the same day-average caveat as body_fat_at.",
    },
  ],
  canonical_result_definitions: [
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  care_goals: [
    {
      column: "target_date",
      semantic: "planned",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  care_plan_items: [
    {
      column: "planned_date",
      semantic: "planned",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "resolved_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "settled_on",
      semantic: "lifecycle",
      grain: "day",
      convention: "n/a",
    },
  ],
  conditions: [
    {
      column: "onset_date",
      semantic: "window-start",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "resolved_date",
      semantic: "window-end",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  coverage_gaps: [
    {
      column: "ai_generated_at",
      semantic: "event",
      grain: "instant",
      convention: "unverified",
      note: "When the AI produced this gap — the row's own event. Its serialization is settled by neither a DEFAULT nor a writer that was read, so phase 2 has to look.",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  cycles: [
    {
      column: "period_start",
      semantic: "window-start",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "period_end",
      semantic: "window-end",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  deleted_rows: [
    {
      column: "deleted_at",
      semantic: "event",
      grain: "instant",
      convention: "bare",
    },
  ],
  dental_procedures: [
    {
      column: "procedure_date",
      semantic: "event",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  document_coverage_markers: [
    {
      column: "refused_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "bare",
    },
  ],
  encounters: [
    {
      column: "date",
      semantic: "day",
      grain: "day",
      convention: "n/a",
      note: "Both the attribution day and the visit window's inclusive start.",
    },
    {
      column: "end_date",
      semantic: "window-end",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  endurance_plans: [
    {
      column: "event_date",
      semantic: "planned",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "completed_on",
      semantic: "lifecycle",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  episode_encounters: [
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  episode_stopped_meds: [
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  equipment: [
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  family_history: [
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  fasts: [
    {
      column: "started_at",
      semantic: "window-start",
      grain: "instant",
      convention: "canonical",
      note: "Migration 20260816-fasts (#2756). The instant the user CLAIMS the fast began — a claim, never a sensor reading, and never inferred from the food log (whose instants are tap times). BORN canonical, so the first writer is bound to utcInstant() by CANONICAL_INSTANT_COLUMNS rather than choosing a shape at the call site. An INSTANT and not a day on purpose: a fast spans a profile-local day boundary by nature, so a day column would be wrong on the majority of rows. Accepts a backdated value (forgot-to-tap is the common failure); the write core refuses a future one and one further back than FAST_MAX_HOURS. No column DEFAULT, deliberately: SQLite's own SQL clock writes the BARE shape, which is exactly how a canonical column ends up holding two serializations.",
    },
    {
      column: "ended_at",
      semantic: "window-end",
      grain: "instant",
      convention: "canonical",
      note: "The claimed end, and NULL is load-bearing: `ended_at IS NULL` IS the active state (there is no status enum), which the partial unique index makes at-most-one-per-profile and every derivation downstream assumes. EXCLUSIVE as an interval end — ending one fast and starting the next at the same instant is a legitimate back-to-back pair, not an overlap. The profile-local DAY a completed fast counts for (#94) is derived from this column at read time (fastAttributedDay: a fast counts for the day it ENDS) and deliberately not stored, because storing it would freeze one timezone's answer.",
    },
    {
      column: "end_written_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "canonical",
      note: "When the row's CURRENT end was WRITTEN — a transition in the record's own life, never a claim about the subject, and the pair of `ended_at` rather than a second opinion about it. NULL exactly while `ended_at` is NULL: the two are one argument at the store (`FastEnd`, lib/fast-store.ts) and are set and cleared together. It exists because the Undo window has to be measured from the ACTION, and `ended_at` is a claim the surface invites the user to backdate — an end backdated past the window was `too-old` the microsecond it landed. `created_at` cannot answer this either: it is the INSERT stamp and an end is an UPDATE. Read by lib/fast-write.ts's `reopenFast` and by nothing else; no reader surface sees it.",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
      note: "The ordinary bookkeeping stamp, on the schema's bare convention like every other one — NOT claimed canonical, and never a substitute for `started_at`: when the row reached the app says nothing about when the fast began, which is the whole point of accepting a backdated start. Nor for `end_written_at`: this is stamped once at INSERT, when the fast is still open, and no writer restamps it when the end lands.",
    },
  ],
  fitness_assessment_entries: [
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  fitness_assessments: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  food_daily_totals: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  food_log_events: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "recorded_at",
      semantic: "record",
      grain: "instant",
      convention: "canonical",
      note: "The TAP instant, `logged_at` until migration 183 (#2205 phase 2, the food wave). Migration 056 froze what it means — never backfilled, because the ranking predicts the next TAP — which is the `recorded_at` semantic under a name the table had coined for itself. The same migration normalized the millisecond-shaped values the offline replay had been writing (#2370) and bound every writer to lib/date.ts.",
    },
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "occurred_at",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "NULL means nobody stated an eating time, and that stays a real answer (#2019/#2053) rather than being filled in from the tap. `time_source` records whether a present value was a tap contract or a stated one. Named `eaten_at` until migration 183; nothing was backfilled into it then either, because food REFUSES to infer an eating instant where intake infers one, and that divergence is deliberate.",
    },
  ],
  frequency_targets: [
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  genomic_variants: [
    {
      column: "report_date",
      semantic: "event",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  glucose_trace: [
    {
      column: "ts",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "The instant a CGM sensor emitted one interstitial reading, minute-truncated (lib/date.ts utcMinute) and part of the row's primary key. Migration 20260819-glucose-trace (#2810), BORN canonical — unlike hr_minutes.ts, which had to be converted off a profile-local wall clock by migration 164, this column has never held any other shape. The profile-local day is derived at read time through lib/local-day-window.ts.",
    },
  ],
  goals: [
    {
      column: "target_date",
      semantic: "planned",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "achieved_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "canonical",
      note: "Migration 182 (#2394) — BORN canonical: the instant `status` became 'achieved', written by setStatus through instantNow() and NULLed when a goal is set back to active. LIFECYCLE and not `event`: it is when the goal ROW was marked reached, not when the underlying performance happened — the app never observes that. NULL on every pre-182 achieved goal, deliberately: the recap announces a goal in the period its RECORDED achievement falls in, so an unrecorded one stays silent rather than being announced retroactively.",
    },
  ],
  hr_minutes: [
    {
      column: "ts",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "Minute-truncated (lib/date.ts utcMinute) and the row's primary key. Migration 164 converted it from a profile-local wall clock; the local day is now derived at read time.",
    },
  ],
  illness_episodes: [
    {
      column: "start_date",
      semantic: "window-start",
      grain: "day",
      convention: "n/a",
      note: "The inclusive first active day, NULL when the episode predates the log. Renamed from `started_at` by migration 169 (#2232).",
    },
    {
      column: "end_date",
      semantic: "window-end",
      grain: "day",
      convention: "n/a",
      note: "The INCLUSIVE last active day, NULL while ongoing — the house day-window convention. Migration 169 (#2232) renamed it from `ended_at` AND rewrote the stored value (the old column held the exclusive first inactive day).",
    },
  ],
  imaging_studies: [
    {
      column: "study_date",
      semantic: "event",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  immunization_overrides: [
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  immunizations: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  import_jobs: [
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "updated_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  import_pair_decisions: [
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  import_tombstones: [
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  injuries: [
    {
      column: "since",
      semantic: "window-start",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "resolved_date",
      semantic: "window-end",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "review_date",
      semantic: "planned",
      grain: "day",
      convention: "n/a",
    },
  ],
  insights: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  instrument_responses: [
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  intake_dose_schedule_versions: [
    {
      column: "time_of_day",
      semantic: "planned",
      grain: "time-of-day",
      convention: "n/a",
    },
    {
      column: "start_date",
      semantic: "window-start",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "end_date",
      semantic: "window-end",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  intake_item_doses: [
    {
      column: "time_of_day",
      semantic: "planned",
      grain: "time-of-day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "updated_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "start_date",
      semantic: "window-start",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "end_date",
      semantic: "window-end",
      grain: "day",
      convention: "n/a",
    },
  ],
  // Issue #2876 completes the same event/record split as food_log_events:
  // `recorded_at` is immutable capture and `occurred_at` is administration time.
  intake_item_logs: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "occurred_at",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "The stored administration instant. Issue #2876 moved administration writers and corrections here and migrated the old overloaded recorded_at value into it.",
    },
    {
      column: "recorded_at",
      semantic: "record",
      grain: "instant",
      convention: "canonical",
      note: "The immutable capture/insert stamp. Issue #2876 renamed the old taken_at column to this vocabulary and converted it to canonical UTC+Z, matching food_log_events.recorded_at.",
    },
  ],
  intake_item_side_effects: [
    { column: "noted_on", semantic: "event", grain: "day", convention: "n/a" },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  intake_item_suggestions: [
    {
      column: "time_of_day",
      semantic: "planned",
      grain: "time-of-day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  intake_items: [
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "cadence_anchor_date",
      semantic: "day",
      grain: "day",
      convention: "n/a",
      note: "The day an interval cadence counts from, not an observation.",
    },
  ],
  integration_backfill_jobs: [
    {
      column: "started_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "mixed",
      note: "Written through utcInstant since #2205 phase 1, but no migration rewrote the rows that predate it, so the column can still hold both shapes. A phase-2 wave settles it.",
    },
    {
      column: "retry_after_at",
      semantic: "planned",
      grain: "instant",
      convention: "mixed",
      note: "The lease/backoff cutoff. Its two writers disagreeing about serialization is the bug the time-model doc uses as its worked example; both now bind utcInstant, historical rows are still bare.",
    },
    {
      column: "finished_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "mixed",
      note: "Written through utcInstant since phase 1, with pre-phase-1 rows still bare. Moves with started_at.",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "updated_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  integration_connections: [
    {
      column: "last_sync_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "mixed",
      note: "Written through utcInstant since #2205 phase 1; rows written before it are still on SQLite's bare shape, so both live here until a phase-2 wave converts them.",
    },
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "updated_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "refresh_claimed_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "mixed",
      note: "Written through utcInstant since #2205 phase 1; rows written before it are still on SQLite's bare shape, so both live here until a phase-2 wave converts them.",
    },
  ],
  integration_sync_events: [
    {
      column: "at",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
    },
    {
      column: "window_start",
      semantic: "window-start",
      grain: "instant",
      convention: "canonical",
    },
    {
      column: "window_end",
      semantic: "window-end",
      grain: "instant",
      convention: "canonical",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "canonical",
    },
  ],
  integration_sync_rows: [
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "canonical",
    },
  ],
  lesion_photos: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  login_attempts: [
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  login_auth_tokens: [
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "expires_at",
      semantic: "planned",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "consumed_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "bare",
    },
  ],
  login_recovery_codes: [
    {
      column: "used_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  login_totp_challenges: [
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "expires_at",
      semantic: "planned",
      grain: "instant",
      convention: "bare",
    },
  ],
  logins: [
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  med_link_decisions: [
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  medical_documents: [
    {
      column: "document_date",
      semantic: "day",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "uploaded_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "processing_started_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "extraction_completed_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "bare",
    },
    {
      // When a portal run claimed this archive as part of the delivery it reported
      // (#2999). LIFECYCLE, not a clinical fact: it says nothing about the document's
      // contents, only that the run → documents attribution has been made. Durable by
      // design — the provenance rows that list the delivery expire with their event on
      // the #388 sweep, and this is what stops the claim being made a second time.
      //
      // BARE, like the three instants beside it, and that is a deliberate choice
      // rather than the default one. The column was born empty, so canonical was free
      // for the taking — the same freedom fasts.started_at used the same day. What made
      // it not free HERE is the table: `medical_documents` is a BARE table, and
      // CANONICAL_INSTANT_COLUMNS binds a whole table, so claiming one column makes
      // rule B reject every SQL-clock statement on it — four files of extraction lease
      // and reaper machinery (extraction-claim, extraction-reaper, medical-pipeline,
      // migrations/boot-tasks) that this feature has no business re-timing. One
      // convention per table is worth more here than matching a precedent set on a table
      // whose instants are all canonical.
      //
      // Safe as bare because it is never compared against a canonical column: the
      // reads are `IS NULL` (the claim's guard), `MAX()` with a `date(…, '-1 day')`
      // bound, and the instant itself resolved to a profile-local day in JS — all
      // convention-blind. The `substr(…, 1, 10)` this sentence used to name was the
      // UTC truncation #3880 removed and #3944 declined to bring back; the delivery
      // day is no longer computed in SQL at all. Its one writer is
      // claimDeliveredDocuments,
      // bound to sqlNow() beside the guard it feeds. No column DEFAULT, so SQLite's SQL
      // clock can never write it behind that writer's back.
      column: "delivered_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "bare",
    },
  ],
  medical_record_revisions: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "superseded_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "bare",
    },
  ],
  medical_records: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "occurred_at",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "Migration 165 (#2154, #2205 phase 2 wave 1). When the vital was actually taken — the reading's own instant, distinct from `created_at`, which is when it reached the app. NULL means DAY-GRAIN: nobody stated a time, so `eventInstant` answers not-recorded rather than inventing one. Born on the canonical convention rather than converted onto it, so it is in CANONICAL_INSTANT_COLUMNS from the migration that added it and the first writer is already bound to utcInstant(). No column DEFAULT, deliberately: a clock default would stamp the record instant into the event column.",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  medication_courses: [
    {
      column: "started_on",
      semantic: "window-start",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "stopped_on",
      semantic: "window-end",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  metric_samples: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "started_at",
      semantic: "window-start",
      grain: "instant",
      convention: "mixed",
      note: "THE column that most rewards reading this table before writing SQL. It holds vendor ISO-with-milliseconds for an imported sample AND `${date}T00:00:00` — a profile-local DAY midnight, not an instant — for a reading whose author stated only a day. It is also the natural key (profile, metric, source, origin, started_at) that makes a re-entry a correction, so neither shape can be normalized without changing dedupe.",
    },
    {
      column: "ended_at",
      semantic: "window-end",
      grain: "instant",
      convention: "mixed",
      note: "The same two shapes as started_at, and equal to it for an instantaneous reading.",
    },
    {
      column: "pushed_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "canonical",
      note: "WHEN THE PUSH THAT WROTE THIS ROW HAPPENED, as the payload itself states it (#3424) — never when the reading was taken, which is started_at. Health Connect only; NULL on every other source and on every row written before 20260821-hc-overlap-supersede. It holds the exporter's own `payload.timestamp` and NOTHING derived from the rows themselves — a byte-identical replay therefore carries the same value as the push it replays and cannot out-rank it. An earlier cut fell back to the furthest-forward `ended_at` in the push and was measured LOSING a reading: an end belongs to the reading, not to the push, and a re-anchored completed day ends earlier than the still-filling row it corrects. NULL when the push stated nothing readable, or when the stated instant was further ahead of the server clock than MAX_PUSH_CLOCK_SKEW_MS, and a NULL stamp supersedes nothing. CANONICAL rather than mixed, unlike its started_at/ended_at neighbours: the writer parses whichever of those two it picked and re-serializes through utcInstant, so a new column is not born holding two shapes. It also refuses an offset-less spelling outright, because a delete decision must not move with the server's zone. The supersede compares it as an instant; nothing else reads it.",
    },
  ],
  milestones: [
    {
      column: "achieved_on",
      semantic: "event",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  mood_logs: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "updated_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  narratives: [
    {
      column: "period_start",
      semantic: "window-start",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "period_end",
      semantic: "window-end",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  niggles: [
    {
      column: "reported_at",
      semantic: "window-start",
      grain: "instant",
      convention: "canonical",
      note: "When the person FIRST reported this niggle — i.e. when they tapped the confirm chip on the note that named it. Migration 20260819-niggles (#2948), BORN canonical (lib/clock.ts instantNow). `window-start` on the `injuries.since` reading: it opens the span the niggle has been going on for, and never advances — a re-report moves last_reported_at and leaves this alone. It is deliberately NOT the row's `event` column: the fact every consumer reads is the FRESHEST report, so declaring two events here would be exactly the substitution-wearing-a-declaration the index forbids.",
    },
    {
      column: "last_reported_at",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "The MOST RECENT report of the same niggle (same region + laterality). Migration 20260819-niggles (#2948), BORN canonical. `event`, not `lifecycle`: a re-report is a fact about the person's body, not a transition in the row's bookkeeping. It is also the whole expiry clock — a niggle is live iff now - last_reported_at < NIGGLE_QUIET_DAYS (lib/niggle-model.ts), so nothing is stored about expiry and nothing has to run to resolve one.",
    },
  ],
  notify_lifecycle: [
    {
      column: "at",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "Was `new Date().toISOString()` — milliseconds and a `Z`, a third serialization phase 1's rule C could not see because the module that builds the string writes no SQL of its own. Migration 167 (#2233) normalized the stored values and the writer now binds instantNow(). Nothing compares it in SQL.",
    },
  ],
  notify_messages: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "sent_at",
      semantic: "event",
      grain: "instant",
      convention: "bare",
    },
  ],
  notify_offers: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "created_at",
      semantic: "event",
      grain: "instant",
      convention: "bare",
      note: "The #2460 offer-mint stamp, BARE like its sibling `notify_messages.sent_at`: the retention sweep compares it in SQL against `datetime(?, ?)`, which a canonical `…Z` string would not compare against at all.",
    },
  ],
  notify_post_workout_claims: [
    {
      column: "claimed_at",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "The #3058 dispatch-claim lease stamp. Born canonical (the table is new and its one writer binds instantNow), and compared only in JS against POST_WORKOUT_CLAIM_LEASE_MS; nothing compares it in SQL.",
    },
  ],
  optical_prescriptions: [
    {
      column: "issued_date",
      semantic: "event",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "expiry_date",
      semantic: "planned",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  pending_portal_identities: [
    {
      column: "first_seen_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "last_seen_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "bare",
    },
  ],
  portal_accounts: [
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  portal_identities: [
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "updated_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  portal_run_reports: [
    { column: "at", semantic: "event", grain: "instant", convention: "bare" },
    {
      column: "checked_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "checked_ok_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "unattended_fail_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "bare",
    },
  ],
  portal_sync_requests: [
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "expires_at",
      semantic: "planned",
      grain: "instant",
      convention: "bare",
    },
  ],
  portals: [
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  practice_logs: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "start_time",
      semantic: "event",
      grain: "time-of-day",
      convention: "n/a",
      note: 'The START of the session, a profile-local HH:MM, optional (a backdated correction states none). It is NOT an instant: resolving it needs the row\'s `date` AND the profile timezone, which is why eventInstant refuses without one. It stays the table\'s `event` column through #3142\'s rename because it is still the one answer to "when did this happen" — but a TAP-stamped start trails the true start by up to a session length (a "Done" tap fires at or after the end), which is noise at the hour granularity the rhythm inference reads and is what the #2875 chips correct.',
    },
    {
      column: "end_time",
      semantic: "window-end",
      grain: "time-of-day",
      convention: "n/a",
      note: "The same profile-local HH:MM as start_time, and NULL for every session nobody stated an end for — which is every tap (#3142: being one-tap is the point) and every import. Never derived from `duration_min`: `activityWindow` falls back to the duration at READ time, so storing that end would turn a derivation into a claim.",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  preventive_events: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  preventive_overrides: [
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  preventive_record_decisions: [
    {
      column: "confirmed_date",
      semantic: "day",
      grain: "day",
      convention: "n/a",
      note: "The person-confirmed completion day for a confirmed decision (#3025) — prefilled from the record date, edited before writing. NULL exactly when decision = 'dismissed' (schema CHECK).",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "updated_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  procedures: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  profile_share_links: [
    {
      column: "expires_at",
      semantic: "planned",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "revoked_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  profiles: [
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  progress_photos: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  protein_daily_totals: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  protocols: [
    {
      column: "start_date",
      semantic: "window-start",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "end_date",
      semantic: "window-end",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  provider_affiliations: [
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  providers: [
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  push_subscriptions: [
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "last_used_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "bare",
    },
  ],
  replayed_keys: [
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  revoked_sessions: [
    {
      column: "revoked_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "bare",
      note: "When a LIVE session was deliberately ended (#3053) — the tombstone that lets the server answer REVOKED rather than merely unauthorized. Written by lib/auth's revocation paths and only for a session that had not already lapsed, so a device whose cookie merely expired is never told it was revoked; never written by purgeExpiredSessions, which sweeps these once past the session absolute-max ceiling.",
    },
  ],
  routines: [
    {
      column: "started_date",
      semantic: "window-start",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  saved_items: [
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  schema_migrations: [
    {
      column: "applied_at",
      semantic: "record",
      grain: "instant",
      convention: "canonical",
      note: "The migration runner's applied-set ledger (name-keyed migrations; lib/migrations/runner.ts is the only writer, bound to instantNow()). BORN canonical. For rows backfilled from a pre-ledger user_version stamp this is when the backfill ran, not when the migration originally applied — the name is the fact, the timestamp is provenance.",
    },
  ],
  sessions: [
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "expires_at",
      semantic: "planned",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "last_used_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "bare",
    },
  ],
  shared_supplies: [
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "updated_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  situations: [
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  skin_lesions: [
    {
      column: "observed_date",
      semantic: "event",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  stream_frontiers: [
    {
      column: "frontier_at",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "The newest EVENT instant the stream had reached when ingest last looked — a watermark copied from the stream table's own event column (hr_minutes.ts today), so it carries that column's semantic. NULL while the stream has never delivered a row. Migration 179 (#2341), born canonical.",
    },
    {
      column: "advanced_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "canonical",
      note: "When the frontier was last observed to MOVE. A transition in this watermark row's own life, not in the subject's: it is the instant the observation was made, never the instant the data carries. Migration 179 (#2341), born canonical.",
    },
    {
      column: "observed_at",
      semantic: "record",
      grain: "instant",
      convention: "canonical",
      note: "When ingest last looked at all, advancing or not — the stamp that makes `syncs_since_advance` auditable. Migration 179 (#2341), born canonical.",
    },
  ],
  substance_daily_totals: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "recorded_at",
      semantic: "record",
      grain: "instant",
      convention: "canonical",
    },
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  symptom_logs: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  symptom_photos: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  symptom_videos: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  upcoming_dismissals: [
    {
      column: "snooze_until",
      semantic: "planned",
      grain: "day",
      convention: "n/a",
    },
    {
      column: "dismissed_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "bare",
    },
    {
      column: "created_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
    },
  ],
  visit_link_decisions: [
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  weather_days: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "fetched_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
  weather_uv_hours: [
    {
      column: "hour_ts",
      semantic: "event",
      grain: "local-datetime",
      convention: "n/a",
      note: "The provider's own top-of-hour stamp (`YYYY-MM-DDTHH:00`), zoneless. Part of the cache key with (lat, lng).",
    },
    {
      column: "fetched_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
    },
  ],
} as const satisfies Record<string, readonly TimeColumn[]>;

// Every table that declares at least one temporal column — the domain of the row-level
// readers, and the key space the scan compares against the schema.
export type TemporalTable = keyof typeof TIME_COLUMNS;

// The declared columns of a table carrying `semantic`. At most one for `event` and
// `record` (the pure test enforces it), so the readers can take [0].
export function timeColumnsFor(
  table: TemporalTable,
  semantic: TimeSemantic
): TimeColumn[] {
  return (TIME_COLUMNS[table] as readonly TimeColumn[]).filter(
    (c) => c.semantic === semantic
  );
}

// The single column of `table` carrying `semantic`, or null when it declares none.
export function timeColumn(
  table: TemporalTable,
  semantic: TimeSemantic
): TimeColumn | null {
  return timeColumnsFor(table, semantic)[0] ?? null;
}

// The docs index (docs/internals/time-columns.md), rendered from the registry above.
// Generated rather than written so it cannot drift: `npm run gen:time-columns` writes
// it and lib/__tests__/time-columns.test.ts fails when the committed file is stale.
export function renderTimeColumnIndex(): string {
  const rows: string[] = [];
  for (const table of Object.keys(TIME_COLUMNS).sort()) {
    for (const c of TIME_COLUMNS[
      table as TemporalTable
    ] as readonly TimeColumn[]) {
      const note = c.note ? c.note.replace(/\|/g, "\\|") : "";
      rows.push(
        `| \`${table}\` | \`${c.column}\` | ${c.semantic} | ${c.grain} | ${c.convention} | ${note} |`
      );
    }
  }
  return [
    "| table | column | semantic | grain | convention | notes |",
    "| ----- | ------ | -------- | ----- | ---------- | ----- |",
    ...rows,
  ].join("\n");
}

// Where the published index lives, and the markers that fence the generated half off
// from the hand-written prose around it.
export const TIME_COLUMN_INDEX_DOC = "docs/internals/time-columns.md";
const BEGIN = "<!-- BEGIN GENERATED: time-column index -->";
const END = "<!-- END GENERATED: time-column index -->";

// The generated block exactly as the doc should currently hold it.
export function timeColumnIndexBlock(): string {
  return `${BEGIN}\n\n${renderTimeColumnIndex()}\n\n${END}`;
}

// Splice the current block into a document. Throws when the markers are missing —
// appending silently would leave two tables in the file, one of them stale.
export function spliceTimeColumnIndex(doc: string): string {
  const from = doc.indexOf(BEGIN);
  const to = doc.indexOf(END);
  if (from < 0 || to < 0 || to < from) {
    throw new Error(
      `${TIME_COLUMN_INDEX_DOC} is missing the generated-block markers (${BEGIN} … ${END}).`
    );
  }
  return (
    doc.slice(0, from) + timeColumnIndexBlock() + doc.slice(to + END.length)
  );
}
