# The temporal-column index

[time-columns.ts](../../lib/time-columns.ts) declares what each temporal column
means, its grain, and its stored serialization. The table below is generated;
edit the registry and run `npm run gen:time-columns`. Existing pure tests detect a
stale table; DB tests compare the registry with the migrated schema.

[Time model](time-model.md) owns instant storage and writer conventions. This
index owns the per-column map, including mixed shapes and exceptions that a column
name cannot explain.

## Read a row's time

Use [row-instants.ts](../../lib/row-instants.ts) instead of choosing columns at
each call site:

| Question | Reader |
| --- | --- |
| When did it happen? | `eventInstant(table, row, tz?)` |
| When was it recorded? | `recordInstant(table, row, tz?)` |
| Event time, with explicit capture fallback | `bestKnownInstant(table, row, tz?)` |
| Which local day does the row belong to? | `rowLocalDay(table, row, tz)` |

These readers return a discriminated result. For an absent instant, preserve the
reason: `not-declared` (no such column), `not-recorded` (no stored value),
`needs-zone` (local clock without timezone), `day-only`, `ambiguous` (mixed grain),
or `unreadable`. Missing event time does not imply capture time.
`bestKnownInstant` explicitly reports whether it used the event or record semantic.

For a standalone instant, use `localDayOf(tz, instant)` from
[local-day-window.ts](../../lib/local-day-window.ts); it returns a local day or null.
Use the domain's timezone: an appointment's clinic-local date and time must not be
resolved using the profile timezone.

## Vocabulary

| Field | Values |
| --- | --- |
| `semantic` | `event`: occurrence; `record`: capture (possibly an ordered fallback chain); `window-start`/`window-end`: interval edges; `day`: attribution day; `planned`: intended time/lease/expiry; `lifecycle`: row transition; `bookkeeping`: other creation/update stamps. |
| `grain` | `instant`: absolute; `day`: calendar date; `local-datetime`: zoneless date/time; `time-of-day`: clock needing date and zone; `mixed`: several shapes. |
| `convention` | `canonical`: UTC `YYYY-MM-DDTHH:MM:SSZ`; `bare`: SQLite-style UTC `YYYY-MM-DD HH:MM:SS`; `iso-ms`: ISO with milliseconds; `mixed`: several serializations; `unverified`: not established from a DEFAULT or writer; `n/a`: not instant-grained. |

Mixed and unverified entries require explanatory notes. Unverified serialization
is a remaining audit task, not permission to guess. Known instant results normalize
to canonical shape; mixed grain still returns `ambiguous`.

## Before writing SQL

Read the entry's notes, especially for natural keys and interval boundaries.
`metric_samples.started_at` retains writer-specific shapes in its natural key;
normalizing it changes deduplication. `illness_episodes.start_date` and `end_date`
are inclusive calendar days, with a null end while ongoing. Food and dose ledgers
separate immutable `recorded_at` from event `occurred_at`. Practice and activity
clock fields need both a date and timezone; absent clocks stay absent.

## The index

<!-- BEGIN GENERATED: time-column index -->

| table | column | semantic | grain | convention | notes |
| ----- | ------ | -------- | ----- | ---------- | ----- |
| `activities` | `date` | day | day | n/a |  |
| `activities` | `start_time` | window-start | time-of-day | n/a | Optional profile-local HH:MM. Resolve with the row date and profile timezone. activityClockHHMM converts extracted ISO input at persistence. |
| `activities` | `end_time` | window-end | time-of-day | n/a | Profile-local HH:MM. NULL for day-only entries and unfinished live sessions. |
| `activities` | `created_at` | record | instant | bare | App writers bind sqlNow(); the schema DEFAULT is a backstop. Workout presence uses this as first-seen time when updated_at is absent. |
| `activities` | `updated_at` | bookkeeping | instant | bare | Autosave/liveness stamp, bound from sqlNow(). Workout presence prefers this over created_at. |
| `activity_telemetry` | `snapshot_at` | record | instant | unverified | Supplied by Strava sync; writer serialization remains unverified. No SQL time comparison. |
| `activity_videos` | `created_at` | record | instant | bare |  |
| `ai_usage_counters` | `day` | day | day | n/a |  |
| `allergies` | `onset_date` | event | day | n/a |  |
| `allergies` | `created_at` | record | instant | bare |  |
| `allergy_reactions` | `created_at` | record | instant | bare |  |
| `api_tokens` | `created_at` | bookkeeping | instant | bare |  |
| `api_tokens` | `last_used_at` | lifecycle | instant | bare |  |
| `api_tokens` | `revoked_at` | lifecycle | instant | bare |  |
| `appointments` | `date` | planned | day | n/a | Required clinic-local visit day. Never resolve against the profile timezone. |
| `appointments` | `time_of_day` | planned | time-of-day | n/a | Optional clinic-local HH:MM; NULL means day-only booking. Resolving an instant requires the clinic timezone, which is not stored. |
| `appointments` | `created_at` | record | instant | bare |  |
| `audit_events` | `ts` | record | instant | bare |  |
| `body_metrics` | `date` | day | day | n/a |  |
| `body_metrics` | `occurred_at` | event | instant | canonical | The person-stated sitting instant; NULL means day grain. Distinct from source-reported per-measure instants. Descriptive only: the natural key remains (profile_id, date, source), and there is no record stamp to substitute. |
| `body_metrics` | `weight_at` | event | instant | canonical | Source-reported instant for the stored weight; NULL when unstated. Each measure has its own instant. Does not change the daily natural key or device deduplication. |
| `body_metrics` | `body_fat_at` | event | instant | canonical | Source-reported instant for the retained body-fat reading, not an instant for the stored day average. NULL when unstated. |
| `body_metrics` | `resting_hr_at` | event | instant | canonical | Source-reported instant for the retained resting-HR reading, with the same day-average caveat as body_fat_at. NULL when unstated. |
| `canonical_result_definitions` | `created_at` | bookkeeping | instant | bare |  |
| `care_goals` | `target_date` | planned | day | n/a |  |
| `care_goals` | `created_at` | bookkeeping | instant | bare |  |
| `care_plan_items` | `planned_date` | planned | day | n/a |  |
| `care_plan_items` | `created_at` | record | instant | bare |  |
| `care_plan_items` | `resolved_at` | lifecycle | instant | bare |  |
| `care_plan_items` | `settled_on` | lifecycle | day | n/a |  |
| `conditions` | `onset_date` | window-start | day | n/a |  |
| `conditions` | `resolved_date` | window-end | day | n/a |  |
| `conditions` | `created_at` | record | instant | bare |  |
| `coverage_gaps` | `ai_generated_at` | event | instant | unverified | When AI produced the gap. Serialization remains unverified: neither a DEFAULT nor an inspected writer establishes it. |
| `coverage_gaps` | `created_at` | record | instant | bare |  |
| `cycles` | `period_start` | window-start | day | n/a |  |
| `cycles` | `period_end` | window-end | day | n/a |  |
| `cycles` | `created_at` | record | instant | bare |  |
| `deleted_rows` | `deleted_at` | event | instant | bare |  |
| `dental_procedures` | `procedure_date` | event | day | n/a |  |
| `dental_procedures` | `created_at` | record | instant | bare |  |
| `document_coverage_markers` | `refused_at` | lifecycle | instant | bare |  |
| `encounters` | `date` | day | day | n/a | Both the attribution day and the visit window's inclusive start. |
| `encounters` | `end_date` | window-end | day | n/a |  |
| `encounters` | `created_at` | record | instant | bare |  |
| `endurance_plans` | `event_date` | planned | day | n/a |  |
| `endurance_plans` | `completed_on` | lifecycle | day | n/a |  |
| `endurance_plans` | `created_at` | bookkeeping | instant | bare |  |
| `episode_encounters` | `created_at` | record | instant | bare |  |
| `episode_stopped_meds` | `created_at` | record | instant | bare |  |
| `equipment` | `created_at` | bookkeeping | instant | bare |  |
| `family_history` | `created_at` | record | instant | bare |  |
| `fasts` | `started_at` | window-start | instant | canonical | User-claimed start, never inferred from food. The writer binds utcInstant with no clock DEFAULT; future starts and backdating beyond FAST_MAX_HOURS are refused. |
| `fasts` | `ended_at` | window-end | instant | canonical | Claimed exclusive end. NULL means active; at most one active fast per profile. Completed fasts count for the profile-local day of this end, derived at read time. |
| `fasts` | `end_written_at` | lifecycle | instant | canonical | When the current end was written, for the Undo clock. Set/cleared with ended_at through FastEnd. A backdated end and the insert stamp cannot answer this action-time question. |
| `fasts` | `created_at` | record | instant | bare | Insert bookkeeping only. Never substitute for the claimed start or the later end-written stamp. |
| `fitness_assessment_entries` | `created_at` | record | instant | bare |  |
| `fitness_assessments` | `date` | day | day | n/a |  |
| `fitness_assessments` | `created_at` | record | instant | bare |  |
| `food_daily_totals` | `date` | day | day | n/a |  |
| `food_daily_totals` | `created_at` | record | instant | bare |  |
| `food_log_events` | `date` | day | day | n/a |  |
| `food_log_events` | `recorded_at` | record | instant | canonical | The immutable tap/capture instant used by tap prediction. Canonical across online and offline writers; never backfill it from an eating time. |
| `food_log_events` | `created_at` | bookkeeping | instant | bare |  |
| `food_log_events` | `occurred_at` | event | instant | canonical | Eating instant; NULL when unstated, never filled from capture time. time_source distinguishes a tap contract from a stated time. The web bar does not infer one. |
| `frequency_targets` | `created_at` | bookkeeping | instant | bare |  |
| `genomic_variants` | `report_date` | event | day | n/a |  |
| `genomic_variants` | `created_at` | record | instant | bare |  |
| `glucose_trace` | `ts` | event | instant | canonical | Sensor reading instant, minute-truncated by utcMinute and part of the primary key. Profile-local day is derived at read time. |
| `goals` | `target_date` | planned | day | n/a |  |
| `goals` | `created_at` | bookkeeping | instant | bare |  |
| `goals` | `achieved_at` | lifecycle | instant | canonical | When the goal row was marked achieved, bound by instantNow(), not when the performance happened. Cleared on reactivation. Legacy achievements with no recorded instant remain NULL and are not announced retroactively. |
| `hr_minutes` | `ts` | event | instant | canonical | Minute-truncated by utcMinute and part of the primary key. Profile-local day is derived at read time. |
| `illness_episodes` | `start_date` | window-start | day | n/a | Inclusive first active day; NULL when the episode predates the log. |
| `illness_episodes` | `end_date` | window-end | day | n/a | Inclusive last active day; NULL while ongoing. |
| `imaging_studies` | `study_date` | event | day | n/a |  |
| `imaging_studies` | `created_at` | record | instant | bare |  |
| `immunization_overrides` | `created_at` | record | instant | bare |  |
| `immunizations` | `date` | day | day | n/a |  |
| `immunizations` | `created_at` | record | instant | bare |  |
| `import_jobs` | `created_at` | record | instant | bare |  |
| `import_jobs` | `updated_at` | bookkeeping | instant | bare |  |
| `import_pair_decisions` | `created_at` | record | instant | bare |  |
| `import_tombstones` | `created_at` | record | instant | bare |  |
| `injuries` | `since` | window-start | day | n/a |  |
| `injuries` | `resolved_date` | window-end | day | n/a |  |
| `injuries` | `created_at` | record | instant | bare |  |
| `injuries` | `review_date` | planned | day | n/a |  |
| `insights` | `date` | day | day | n/a |  |
| `insights` | `created_at` | record | instant | bare |  |
| `instrument_responses` | `created_at` | record | instant | bare |  |
| `intake_dose_schedule_versions` | `time_of_day` | planned | time-of-day | n/a |  |
| `intake_dose_schedule_versions` | `start_date` | window-start | day | n/a |  |
| `intake_dose_schedule_versions` | `end_date` | window-end | day | n/a |  |
| `intake_dose_schedule_versions` | `created_at` | record | instant | bare |  |
| `intake_item_doses` | `time_of_day` | planned | time-of-day | n/a |  |
| `intake_item_doses` | `created_at` | bookkeeping | instant | bare |  |
| `intake_item_doses` | `updated_at` | bookkeeping | instant | bare |  |
| `intake_item_doses` | `start_date` | window-start | day | n/a |  |
| `intake_item_doses` | `end_date` | window-end | day | n/a |  |
| `intake_item_logs` | `date` | day | day | n/a |  |
| `intake_item_logs` | `occurred_at` | event | instant | canonical | Administration instant, written and corrected by the administration paths. Distinct from immutable capture time. |
| `intake_item_logs` | `recorded_at` | record | instant | canonical | Immutable capture/insert instant, matching the food ledger capture semantic. |
| `intake_item_side_effects` | `noted_on` | event | day | n/a |  |
| `intake_item_side_effects` | `created_at` | record | instant | bare |  |
| `intake_item_suggestions` | `time_of_day` | planned | time-of-day | n/a |  |
| `intake_item_suggestions` | `created_at` | record | instant | bare |  |
| `intake_items` | `created_at` | bookkeeping | instant | bare |  |
| `intake_items` | `cadence_anchor_date` | day | day | n/a | The day an interval cadence counts from, not an observation. |
| `integration_backfill_jobs` | `started_at` | lifecycle | instant | mixed | Current writers use utcInstant; historical bare values remain. |
| `integration_backfill_jobs` | `retry_after_at` | planned | instant | mixed | Lease/backoff cutoff. Current writers use utcInstant; historical bare values remain. |
| `integration_backfill_jobs` | `finished_at` | lifecycle | instant | mixed | Current writers use utcInstant; historical bare values remain. |
| `integration_backfill_jobs` | `created_at` | record | instant | bare |  |
| `integration_backfill_jobs` | `updated_at` | bookkeeping | instant | bare |  |
| `integration_connections` | `last_sync_at` | lifecycle | instant | mixed | Current writers use utcInstant; historical bare values remain. |
| `integration_connections` | `created_at` | bookkeeping | instant | bare |  |
| `integration_connections` | `updated_at` | bookkeeping | instant | bare |  |
| `integration_connections` | `refresh_claimed_at` | lifecycle | instant | mixed | Current writers use utcInstant; historical bare values remain. |
| `integration_sync_events` | `at` | event | instant | canonical |  |
| `integration_sync_events` | `window_start` | window-start | instant | canonical |  |
| `integration_sync_events` | `window_end` | window-end | instant | canonical |  |
| `integration_sync_events` | `created_at` | record | instant | canonical |  |
| `integration_sync_rows` | `created_at` | record | instant | canonical |  |
| `lesion_photos` | `date` | day | day | n/a |  |
| `lesion_photos` | `created_at` | record | instant | bare |  |
| `login_attempts` | `created_at` | record | instant | bare |  |
| `login_auth_tokens` | `created_at` | bookkeeping | instant | bare |  |
| `login_auth_tokens` | `expires_at` | planned | instant | bare |  |
| `login_auth_tokens` | `consumed_at` | lifecycle | instant | bare |  |
| `login_recovery_codes` | `used_at` | lifecycle | instant | bare |  |
| `login_recovery_codes` | `created_at` | bookkeeping | instant | bare |  |
| `login_totp_challenges` | `created_at` | bookkeeping | instant | bare |  |
| `login_totp_challenges` | `expires_at` | planned | instant | bare |  |
| `logins` | `created_at` | bookkeeping | instant | bare |  |
| `med_link_decisions` | `created_at` | record | instant | bare |  |
| `medical_documents` | `document_date` | day | day | n/a |  |
| `medical_documents` | `uploaded_at` | record | instant | bare |  |
| `medical_documents` | `processing_started_at` | lifecycle | instant | bare |  |
| `medical_documents` | `extraction_completed_at` | lifecycle | instant | bare |  |
| `medical_documents` | `delivered_at` | lifecycle | instant | bare |  |
| `medical_record_revisions` | `date` | day | day | n/a |  |
| `medical_record_revisions` | `superseded_at` | lifecycle | instant | bare |  |
| `medical_records` | `date` | day | day | n/a |  |
| `medical_records` | `occurred_at` | event | instant | canonical | Stated measurement instant; NULL means day grain. No clock DEFAULT: capture time must not become event time. Writers use utcInstant. |
| `medical_records` | `created_at` | record | instant | bare |  |
| `medication_courses` | `started_on` | window-start | day | n/a |  |
| `medication_courses` | `stopped_on` | window-end | day | n/a |  |
| `medication_courses` | `created_at` | record | instant | bare |  |
| `metric_samples` | `date` | day | day | n/a |  |
| `metric_samples` | `started_at` | window-start | instant | mixed | Writer-owned shapes include ISO with/without milliseconds or offsets (integrations), zoneless local midnight for day-only readings (reading-writes), local datetime (offline sampleTime), bare day (import-persist), and <ISO>#<stage> (Fitbit Takeout). This inventory is not exhaustive. Part of the natural key (profile, metric, source, origin, started_at): normalizing changes deduplication. Unbranded. |
| `metric_samples` | `ended_at` | window-end | instant | mixed | The same shapes as started_at, and equal to it for an instantaneous reading. |
| `metric_samples` | `pushed_at` | bookkeeping | instant | canonical | Health Connect payload.timestamp, never a reading timestamp; identical replays keep the same stamp. NULL for other sources, unstated/unreadable/offset-less stamps, or excessive future skew (MAX_PUSH_CLOCK_SKEW_MS). NULL supersedes nothing. Parsed and serialized through utcInstant; supersede compares instants. |
| `milestones` | `achieved_on` | event | day | n/a |  |
| `milestones` | `created_at` | record | instant | bare |  |
| `mood_logs` | `date` | day | day | n/a |  |
| `mood_logs` | `created_at` | record | instant | bare |  |
| `mood_logs` | `updated_at` | bookkeeping | instant | bare |  |
| `narratives` | `period_start` | window-start | day | n/a |  |
| `narratives` | `period_end` | window-end | day | n/a |  |
| `narratives` | `created_at` | record | instant | bare |  |
| `niggles` | `reported_at` | window-start | instant | canonical | First confirmed report. Opens the injuries.since window and never advances on re-report; latest-report consumers use last_reported_at. |
| `niggles` | `last_reported_at` | event | instant | canonical | Most recent report for the region/laterality. A body event, not bookkeeping. Live while now minus this instant is below NIGGLE_QUIET_DAYS; expiry is derived. |
| `notify_lifecycle` | `at` | event | instant | canonical | Canonical instant, bound by instantNow(). No SQL time comparison. |
| `notify_messages` | `date` | day | day | n/a |  |
| `notify_messages` | `sent_at` | event | instant | bare |  |
| `notify_offers` | `date` | day | day | n/a |  |
| `notify_offers` | `created_at` | event | instant | bare | Offer-mint stamp. Must remain bare for retention comparisons against SQLite datetime(?, ?). |
| `notify_post_workout_claims` | `claimed_at` | event | instant | canonical | Dispatch-claim lease stamp, bound by instantNow(). Compared in JS against POST_WORKOUT_CLAIM_LEASE_MS; no SQL time comparison. |
| `optical_prescriptions` | `issued_date` | event | day | n/a |  |
| `optical_prescriptions` | `expiry_date` | planned | day | n/a |  |
| `optical_prescriptions` | `created_at` | bookkeeping | instant | bare |  |
| `pending_portal_identities` | `first_seen_at` | lifecycle | instant | bare |  |
| `pending_portal_identities` | `last_seen_at` | lifecycle | instant | bare |  |
| `portal_accounts` | `created_at` | bookkeeping | instant | bare |  |
| `portal_identities` | `created_at` | bookkeeping | instant | bare |  |
| `portal_identities` | `updated_at` | bookkeeping | instant | bare |  |
| `portal_run_reports` | `at` | event | instant | bare |  |
| `portal_run_reports` | `checked_at` | lifecycle | instant | bare |  |
| `portal_run_reports` | `checked_ok_at` | lifecycle | instant | bare |  |
| `portal_run_reports` | `unattended_fail_at` | lifecycle | instant | bare |  |
| `portal_sync_requests` | `created_at` | record | instant | bare |  |
| `portal_sync_requests` | `expires_at` | planned | instant | bare |  |
| `portals` | `created_at` | bookkeeping | instant | bare |  |
| `practice_logs` | `date` | day | day | n/a |  |
| `practice_logs` | `start_time` | event | time-of-day | n/a | Optional session-start HH:MM; resolve with the row date and profile timezone. A Done tap may stamp later than the true start; stated-time corrections refine it. |
| `practice_logs` | `end_time` | window-end | time-of-day | n/a | Optional stated end HH:MM; taps and imports leave it NULL. Never store a duration-derived end: activityWindow supplies that fallback at read time. |
| `practice_logs` | `created_at` | record | instant | bare |  |
| `preventive_events` | `date` | day | day | n/a |  |
| `preventive_events` | `created_at` | record | instant | bare |  |
| `preventive_overrides` | `created_at` | record | instant | bare |  |
| `preventive_record_decisions` | `confirmed_date` | day | day | n/a | Person-confirmed completion day, prefilled from the record date and editable before saving. NULL exactly for dismissed decisions (schema CHECK). |
| `preventive_record_decisions` | `created_at` | record | instant | bare |  |
| `preventive_record_decisions` | `updated_at` | bookkeeping | instant | bare |  |
| `procedures` | `date` | day | day | n/a |  |
| `procedures` | `created_at` | record | instant | bare |  |
| `profile_share_links` | `expires_at` | planned | instant | bare |  |
| `profile_share_links` | `revoked_at` | lifecycle | instant | bare |  |
| `profile_share_links` | `created_at` | bookkeeping | instant | bare |  |
| `profiles` | `created_at` | bookkeeping | instant | bare |  |
| `progress_photos` | `date` | day | day | n/a |  |
| `progress_photos` | `created_at` | record | instant | bare |  |
| `protein_daily_totals` | `date` | day | day | n/a |  |
| `protein_daily_totals` | `created_at` | record | instant | bare |  |
| `protocols` | `start_date` | window-start | day | n/a |  |
| `protocols` | `end_date` | window-end | day | n/a |  |
| `protocols` | `created_at` | bookkeeping | instant | bare |  |
| `provider_affiliations` | `created_at` | bookkeeping | instant | bare |  |
| `providers` | `created_at` | bookkeeping | instant | bare |  |
| `push_subscriptions` | `created_at` | bookkeeping | instant | bare |  |
| `push_subscriptions` | `last_used_at` | lifecycle | instant | bare |  |
| `replayed_keys` | `created_at` | record | instant | bare |  |
| `revoked_sessions` | `revoked_at` | lifecycle | instant | bare | Deliberate revocation of a still-live session. Expiry alone creates no tombstone. purgeExpiredSessions only removes tombstones after the absolute session-age ceiling. |
| `routines` | `started_date` | window-start | day | n/a |  |
| `routines` | `created_at` | bookkeeping | instant | bare |  |
| `saved_items` | `created_at` | record | instant | bare |  |
| `schema_migrations` | `applied_at` | record | instant | canonical | Migration runner stamp, bound by instantNow(). Backfilled ledger rows record backfill time, not original application time; the migration name is the applied-set identity. |
| `sessions` | `created_at` | bookkeeping | instant | bare |  |
| `sessions` | `expires_at` | planned | instant | bare |  |
| `sessions` | `last_used_at` | lifecycle | instant | bare |  |
| `shared_supplies` | `created_at` | bookkeeping | instant | bare |  |
| `shared_supplies` | `updated_at` | bookkeeping | instant | bare |  |
| `situations` | `created_at` | bookkeeping | instant | bare |  |
| `skin_lesions` | `observed_date` | event | day | n/a |  |
| `skin_lesions` | `created_at` | record | instant | bare |  |
| `stream_frontiers` | `frontier_at` | event | instant | canonical | Newest event instant observed in the stream, copied from its event column. NULL until the stream delivers a row. |
| `stream_frontiers` | `advanced_at` | lifecycle | instant | canonical | When ingest observed the frontier move, not the event time carried by the data. |
| `stream_frontiers` | `observed_at` | record | instant | canonical | When ingest last checked, advancing or not; makes syncs_since_advance auditable. |
| `substance_daily_totals` | `date` | day | day | n/a |  |
| `substance_daily_totals` | `recorded_at` | record | instant | canonical |  |
| `substance_daily_totals` | `created_at` | bookkeeping | instant | bare |  |
| `substance_log_events` | `date` | day | day | n/a |  |
| `substance_log_events` | `recorded_at` | record | instant | canonical | Tap/capture instant. Events backfilled from a day counter share that counter's last recorded_at; it is the only capture stamp the counter retained. |
| `substance_log_events` | `created_at` | bookkeeping | instant | bare |  |
| `substance_log_events` | `occurred_at` | event | instant | canonical | Stated use instant; NULL when absent, including events backfilled from day counts. Never infer from capture time. time_source distinguishes tap contracts from stated times. |
| `symptom_logs` | `date` | day | day | n/a |  |
| `symptom_logs` | `created_at` | record | instant | bare |  |
| `symptom_photos` | `date` | day | day | n/a |  |
| `symptom_photos` | `created_at` | record | instant | bare |  |
| `symptom_videos` | `date` | day | day | n/a |  |
| `symptom_videos` | `created_at` | record | instant | bare |  |
| `training_photos` | `created_at` | record | instant | bare |  |
| `upcoming_dismissals` | `snooze_until` | planned | day | n/a |  |
| `upcoming_dismissals` | `dismissed_at` | lifecycle | instant | bare |  |
| `upcoming_dismissals` | `created_at` | bookkeeping | instant | bare |  |
| `visit_link_decisions` | `created_at` | record | instant | bare |  |
| `weather_days` | `date` | day | day | n/a |  |
| `weather_days` | `fetched_at` | record | instant | bare |  |
| `weather_uv_hours` | `hour_ts` | event | local-datetime | n/a | The provider's own top-of-hour stamp (`YYYY-MM-DDTHH:00`), zoneless. Part of the cache key with (lat, lng). |
| `weather_uv_hours` | `fetched_at` | record | instant | bare |  |

<!-- END GENERATED: time-column index -->
