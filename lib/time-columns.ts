// Temporal meanings and stored shapes, shared by row-instants.ts and the generated
// docs index. Update entries with schema changes; regenerate with gen:time-columns.
// DB coverage checks the migrated schema, and pure coverage checks the doc copy.
// Mixed/unverified entries require notes; do not infer serialization from a name.

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
    "food_log_events / substance_log_events: an enum ('tap' | 'stated'), the provenance of occurred_at.",
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
      note: "Optional profile-local HH:MM. Resolve with the row date and profile timezone. activityClockHHMM converts extracted ISO input at persistence.",
    },
    {
      column: "end_time",
      semantic: "window-end",
      grain: "time-of-day",
      convention: "n/a",
      note: "Profile-local HH:MM. NULL for day-only entries and unfinished live sessions.",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
      note: "App writers bind sqlNow(); the schema DEFAULT is a backstop. Workout presence uses this as first-seen time when updated_at is absent.",
    },
    {
      column: "updated_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "bare",
      note: "Autosave/liveness stamp, bound from sqlNow(). Workout presence prefers this over created_at.",
    },
  ],
  activity_telemetry: [
    {
      column: "snapshot_at",
      semantic: "record",
      grain: "instant",
      convention: "unverified",
      note: "Supplied by Strava sync; writer serialization remains unverified. No SQL time comparison.",
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
      note: "Required clinic-local visit day. Never resolve against the profile timezone.",
    },
    {
      column: "time_of_day",
      semantic: "planned",
      grain: "time-of-day",
      convention: "n/a",
      note: "Optional clinic-local HH:MM; NULL means day-only booking. Resolving an instant requires the clinic timezone, which is not stored.",
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
      note: "The person-stated sitting instant; NULL means day grain. Distinct from source-reported per-measure instants. Descriptive only: the natural key remains (profile_id, date, source), and there is no record stamp to substitute.",
    },
    {
      column: "weight_at",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "Source-reported instant for the stored weight; NULL when unstated. Each measure has its own instant. Does not change the daily natural key or device deduplication.",
    },
    {
      column: "body_fat_at",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "Source-reported instant for the retained body-fat reading, not an instant for the stored day average. NULL when unstated.",
    },
    {
      column: "resting_hr_at",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "Source-reported instant for the retained resting-HR reading, with the same day-average caveat as body_fat_at. NULL when unstated.",
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
      note: "When AI produced the gap. Serialization remains unverified: neither a DEFAULT nor an inspected writer establishes it.",
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
      note: "User-claimed start, never inferred from food. The writer binds utcInstant with no clock DEFAULT; future starts and backdating beyond FAST_MAX_HOURS are refused.",
    },
    {
      column: "ended_at",
      semantic: "window-end",
      grain: "instant",
      convention: "canonical",
      note: "Claimed exclusive end. NULL means active; at most one active fast per profile. Completed fasts count for the profile-local day of this end, derived at read time.",
    },
    {
      column: "end_written_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "canonical",
      note: "When the current end was written, for the Undo clock. Set/cleared with ended_at through FastEnd. A backdated end and the insert stamp cannot answer this action-time question.",
    },
    {
      column: "created_at",
      semantic: "record",
      grain: "instant",
      convention: "bare",
      note: "Insert bookkeeping only. Never substitute for the claimed start or the later end-written stamp.",
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
      note: "The immutable tap/capture instant used by tap prediction. Canonical across online and offline writers; never backfill it from an eating time.",
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
      note: "Eating instant; NULL when unstated, never filled from capture time. time_source distinguishes a tap contract from a stated time. The web bar does not infer one.",
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
      note: "Sensor reading instant, minute-truncated by utcMinute and part of the primary key. Profile-local day is derived at read time.",
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
      note: "When the goal row was marked achieved, bound by instantNow(), not when the performance happened. Cleared on reactivation. Legacy achievements with no recorded instant remain NULL and are not announced retroactively.",
    },
  ],
  hr_minutes: [
    {
      column: "ts",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "Minute-truncated by utcMinute and part of the primary key. Profile-local day is derived at read time.",
    },
  ],
  illness_episodes: [
    {
      column: "start_date",
      semantic: "window-start",
      grain: "day",
      convention: "n/a",
      note: "Inclusive first active day; NULL when the episode predates the log.",
    },
    {
      column: "end_date",
      semantic: "window-end",
      grain: "day",
      convention: "n/a",
      note: "Inclusive last active day; NULL while ongoing.",
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
      note: "Administration instant, written and corrected by the administration paths. Distinct from immutable capture time.",
    },
    {
      column: "recorded_at",
      semantic: "record",
      grain: "instant",
      convention: "canonical",
      note: "Immutable capture/insert instant, matching the food ledger capture semantic.",
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
      note: "Current writers use utcInstant; historical bare values remain.",
    },
    {
      column: "retry_after_at",
      semantic: "planned",
      grain: "instant",
      convention: "mixed",
      note: "Lease/backoff cutoff. Current writers use utcInstant; historical bare values remain.",
    },
    {
      column: "finished_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "mixed",
      note: "Current writers use utcInstant; historical bare values remain.",
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
      note: "Current writers use utcInstant; historical bare values remain.",
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
      note: "Current writers use utcInstant; historical bare values remain.",
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
      note: "Stated measurement instant; NULL means day grain. No clock DEFAULT: capture time must not become event time. Writers use utcInstant.",
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
      note: "Writer-owned shapes include ISO with/without milliseconds or offsets (integrations), zoneless local midnight for day-only readings (reading-writes), local datetime (offline sampleTime), bare day (import-persist), and <ISO>#<stage> (Fitbit Takeout). This inventory is not exhaustive. Part of the natural key (profile, metric, source, origin, started_at): normalizing changes deduplication. Unbranded.",
    },
    {
      column: "ended_at",
      semantic: "window-end",
      grain: "instant",
      convention: "mixed",
      note: "The same shapes as started_at, and equal to it for an instantaneous reading.",
    },
    {
      column: "pushed_at",
      semantic: "bookkeeping",
      grain: "instant",
      convention: "canonical",
      note: "Health Connect payload.timestamp, never a reading timestamp; identical replays keep the same stamp. NULL for other sources, unstated/unreadable/offset-less stamps, or excessive future skew (MAX_PUSH_CLOCK_SKEW_MS). NULL supersedes nothing. Parsed and serialized through utcInstant; supersede compares instants.",
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
      note: "First confirmed report. Opens the injuries.since window and never advances on re-report; latest-report consumers use last_reported_at.",
    },
    {
      column: "last_reported_at",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "Most recent report for the region/laterality. A body event, not bookkeeping. Live while now minus this instant is below NIGGLE_QUIET_DAYS; expiry is derived.",
    },
  ],
  notify_lifecycle: [
    {
      column: "at",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "Canonical instant, bound by instantNow(). No SQL time comparison.",
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
      note: "Offer-mint stamp. Must remain bare for retention comparisons against SQLite datetime(?, ?).",
    },
  ],
  notify_post_workout_claims: [
    {
      column: "claimed_at",
      semantic: "event",
      grain: "instant",
      convention: "canonical",
      note: "Dispatch-claim lease stamp, bound by instantNow(). Compared in JS against POST_WORKOUT_CLAIM_LEASE_MS; no SQL time comparison.",
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
      note: "Optional session-start HH:MM; resolve with the row date and profile timezone. A Done tap may stamp later than the true start; stated-time corrections refine it.",
    },
    {
      column: "end_time",
      semantic: "window-end",
      grain: "time-of-day",
      convention: "n/a",
      note: "Optional stated end HH:MM; taps and imports leave it NULL. Never store a duration-derived end: activityWindow supplies that fallback at read time.",
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
      note: "Person-confirmed completion day, prefilled from the record date and editable before saving. NULL exactly for dismissed decisions (schema CHECK).",
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
  // NO event/day column, deliberately (#3285 item 3): a training photo's day is its
  // OWNER's (activities.date / endurance_plans.event_date) and readers derive it in
  // the SELECT, so there is no second copy to drift when a session's date is
  // corrected. Only the filing instant is this table's own fact.
  training_photos: [
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
      note: "Deliberate revocation of a still-live session. Expiry alone creates no tombstone. purgeExpiredSessions only removes tombstones after the absolute session-age ceiling.",
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
      note: "Migration runner stamp, bound by instantNow(). Backfilled ledger rows record backfill time, not original application time; the migration name is the applied-set identity.",
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
      note: "Newest event instant observed in the stream, copied from its event column. NULL until the stream delivers a row.",
    },
    {
      column: "advanced_at",
      semantic: "lifecycle",
      grain: "instant",
      convention: "canonical",
      note: "When ingest observed the frontier move, not the event time carried by the data.",
    },
    {
      column: "observed_at",
      semantic: "record",
      grain: "instant",
      convention: "canonical",
      note: "When ingest last checked, advancing or not; makes syncs_since_advance auditable.",
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
  substance_log_events: [
    { column: "date", semantic: "day", grain: "day", convention: "n/a" },
    {
      column: "recorded_at",
      semantic: "record",
      grain: "instant",
      convention: "canonical",
      note: "Tap/capture instant. Events backfilled from a day counter share that counter's last recorded_at; it is the only capture stamp the counter retained.",
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
      note: "Stated use instant; NULL when absent, including events backfilled from day counts. Never infer from capture time. time_source distinguishes tap contracts from stated times.",
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
