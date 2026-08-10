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
    "food_log_events: an enum ('tap' | 'stated'), the provenance of eaten_at.",
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
      note: "Migration 165 (#2235, #2205 phase 2 wave 1). When the day's weigh-in was actually taken. Body weight moves a kilogram across a day, so morning-fasted and evening-fed are different measurements of one quantity and an unlabelled mix carries that swing as unattributable noise. NULL means DAY-GRAIN. Descriptive only — the natural key stays (profile_id, date, source), and one row per day is unchanged, so this records WHEN the day's reading was taken and does not enable two weigh-ins in one day. This table has no record stamp at all, so there is nothing here for an event column to be laundered from.",
    },
  ],
  canonical_biomarkers: [
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
  food_log: [
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
      column: "logged_at",
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
    {
      column: "eaten_at",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "NULL means nobody stated an eating time, and that stays a real answer (#2019/#2053) rather than being filled in from the tap. `time_source` records whether a present value was a tap contract or a stated one.",
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
    {
      column: "started_at",
      semantic: "window-start",
      grain: "day",
      convention: "n/a",
      note: "VESTIGIAL, always NULL (#2232, the migration-124 pattern): survives only so the frozen 046/062 statements still prepare under migrate()'s replay. A compat trigger translates a legacy insert onto start_date; the illness-window-collapse-guard scan keeps it out of application code.",
    },
    {
      column: "ended_at",
      semantic: "window-end",
      grain: "day",
      convention: "n/a",
      note: "VESTIGIAL, always NULL (#2232): the legacy EXCLUSIVE end's dead storage, kept for frozen-migration prepares only. The compat trigger converts a legacy insert's value onto the inclusive end_date.",
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
  // THE RECORD CHAIN, AS OF MIGRATION 173 — do not re-derive this.
  //
  // `recorded_at` and `taken_at` are NOT an event/record pair. Both answer "when did this
  // enter the app": `recorded_at` is INFERRED (a scheduled confirm writes the tap moment,
  // standing in for an intake nothing observed) and `taken_at` is the row's insert
  // stamp. So the dozen hand-rolled `COALESCE(recorded_at, taken_at)` readers were falling
  // back WITHIN one question all along — the right value under the wrong name.
  //
  // Both halves of the #2229 ruling have now landed. `occurred_at` (migration 165, wave 1)
  // is the event column this chain never had — a NEW column, not a re-labelling, which is
  // why it could ship ahead of the rename. Migration 173 (wave 2) is the rename itself:
  // `given_at` → `recorded_at`, the name finally matching the meaning.
  //
  // WHY `taken_at` DID NOT MOVE WITH IT. The declared vocabulary has exactly ONE word for
  // "when it entered the app", and this table has TWO columns that answer it. `recorded_at`
  // goes to the link readers actually reach. The only other word on offer, `created_at`, is
  // declared bookkeeping — "a stamp that is not the fact the row records" — and this column
  // IS reached, as a record answer, whenever nothing more precise was written (a SKIP writes
  // no `recorded_at` and falls through to it). Renaming it `created_at` while declaring it
  // `record` would install exactly the name/meaning mismatch this wave removes; declaring it
  // `bookkeeping` to earn the name would drop a chain link and change what `recordInstant`
  // returns for every skipped dose — a behaviour change, not a rename. So it keeps its name
  // until the vocabulary grows a word for "the insert stamp BEHIND a more precise record
  // instant", which is #2205's call to make, not this wave's.
  intake_item_logs: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "occurred_at",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "Migration 165 (#2229's owner ruling, #2205 phase 2 wave 1). This table's FIRST event instant: when the dose was actually taken, populated only when somebody states a time. NULL — every row today — means not-recorded, which is a different and more informative fact than the not-declared `eventInstant` answered before the column existed. It is deliberately NOT filled from `recorded_at`: that stamp is the tap, and copying it here would be the inferred-for-observed substitution #2205 exists to close.",
    },
    {
      column: "recorded_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
      note: "RECORD, by owner ruling — it is INFERRED. A scheduled confirm writes the tap moment here, standing in for an intake the app never observed. Named `given_at` until migration 173 (#2205 phase 2 wave 2), which is the whole of that wave: it was a record instant wearing an event's name. It is FIRST in the record chain because it is the more precise of the two: an offline replay carries the client's real tap instant into it, while taken_at is only when the row reached the database. Neither link is the event instant, and that is the whole point.",
    },
    {
      column: "taken_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
      note: "The row's insert stamp (a SQLite clock column DEFAULT, which is what puts it on the bare convention), and the SECOND link of the record chain: a row that wrote no `recorded_at` — a SKIP, or anything written before the column existed (pre-migration-041) — falls through to it. The `COALESCE(recorded_at, taken_at)` a dozen readers hand-roll is this chain — a fallback WITHIN the record question, not a substitution of a record instant for an event one. It kept its name through migration 173 deliberately; see the note above this table for why.",
    },
    {
      column: "given_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
      note: "VESTIGIAL, always NULL (#2205 phase 2 wave 2, the migration-124/169 pattern): migration 173 renamed the live column to `recorded_at` and kept this empty shell so the frozen migrations still work under migrate()'s unconditional replay — 041 guards its whole rebuild on `given_at` being present, and 156 re-creates its index over it. Declared `bookkeeping` rather than `record` on purpose: a dead column must not join the record chain the row readers walk. No application code names it (the SQL orderings all moved to `recorded_at` in the same change).",
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
      column: "start_time",
      semantic: "window-start",
      grain: "instant",
      convention: "mixed",
      note: "THE column that most rewards reading this table before writing SQL. It holds vendor ISO-with-milliseconds for an imported sample AND `${date}T00:00:00` — a profile-local DAY midnight, not an instant — for a reading whose author stated only a day. It is also the natural key (profile, metric, source, origin, start_time) that makes a re-entry a correction, so neither shape can be normalized without changing dedupe.",
    },
    {
      column: "end_time",
      semantic: "window-end",
      grain: "instant",
      convention: "mixed",
      note: "The same two shapes as start_time, and equal to it for an instantaneous reading.",
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
      column: "time",
      semantic: "event",
      grain: "time-of-day",
      convention: "n/a",
      note: "A profile-local HH:MM, optional (the quick path writes none). It is NOT an instant: resolving it needs the row's `date` AND the profile timezone, which is why eventInstant refuses without one.",
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
  protein_log: [
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
  substance_log: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "logged_at",
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
