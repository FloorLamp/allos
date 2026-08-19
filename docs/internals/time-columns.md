# The temporal-column index

Status: shipped (issue #2205 phases 2 and 3 — the persisted naming vocabulary,
declared index, and row-level readers.)

Every temporal column in the schema, with what it MEANS, what SHAPE is in it, and how
it is SERIALIZED. `docs/internals/time-model.md` is the companion: it owns the stored
instant convention and the writer chokepoint, this file owns the per-column map.

**The table at the bottom is generated** from `lib/time-columns.ts` by
`npm run gen:time-columns`, and `lib/__tests__/time-columns.test.ts` fails when the
committed copy is stale. `lib/__db_tests__/time-column-index.test.ts` runs the registry
against the migrated schema, so a new table with an undeclared temporal column fails CI
and a declared column that no longer exists fails too. That is the whole point: #2090
was closed because a hand-maintained index next to a moving schema stops being true, and
nobody finds out.

## Do not read a column — ask a question

The index exists so that surfaces stop naming columns. Read a row's time through
`lib/row-instants.ts`:

| question                                  | reader                              |
| ----------------------------------------- | ----------------------------------- |
| When did this happen?                     | `eventInstant(table, row, tz?)`     |
| When did it enter the app?                | `recordInstant(table, row, tz?)`    |
| The event instant, or the record instant  | `bestKnownInstant(table, row, tz?)` |
| Which profile-local day does it count for | `rowLocalDay(table, row, tz)`       |
| That day, from a bare instant             | `localDayOf(tz, instant)`           |

`localDayOf` (`lib/local-day-window.ts`) is the single instant→day path and shipped with
phase 1; phase 3 deliberately does not mint a second name for it.

Every reader returns a discriminated union, never a nullable string. `known: false`
carries a reason, and the reasons are different facts:

- `not-declared` — the table has no column with that semantic, for every row, forever.
  `substance_daily_totals` records when a use was stored and nothing about when it happened.
- `not-recorded` — the column exists and this row is NULL. Nobody stated an eating time
  (`food_log_events.occurred_at`); an explicitly untimed practice records no clock
  (`practice_logs.time`). **A real answer, not a gap to fill.**
- `needs-zone` — the value is a local wall clock and no timezone was supplied.
- `day-only` — the column is a day. `allergies.onset_date` and
  `illness_episodes.started_at` are days despite their `_at`/`_date` names.
- `ambiguous` — the declared grain is `mixed`; the caller must handle both shapes.
- `unreadable` — the stored value does not parse.

`eventInstant` **never** falls back to the record column. A caller that legitimately
wants "the best instant we have" — ordering a mixed timeline, labelling a last dose —
calls `bestKnownInstant`, whose result says `semantic: "event" | "record"`. The
substitution stays available and stops being invisible.

## The vocabulary

`semantic` — what the column means:

| semantic       | meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `event`        | when the thing itself happened                                          |
| `record`       | when it entered the app (a table may declare an ordered CHAIN)          |
| `window-start` | the subject's own window, opening edge                                  |
| `window-end`   | closing edge (check the notes — some are exclusive)                     |
| `day`          | a profile-local day attribution (#94), untouched by #2205               |
| `planned`      | an intended future time: a plan, a lease, an expiry. Not an observation |
| `lifecycle`    | a transition in the ROW's life (revoked, consumed, resolved)            |
| `bookkeeping`  | a creation/update stamp that is not the fact the row records            |

`grain` — what you need in hand to get an absolute moment:

| grain            | shape                                                     |
| ---------------- | --------------------------------------------------------- |
| `instant`        | absolute; resolvable with nothing else                    |
| `day`            | `YYYY-MM-DD`, profile-local                               |
| `local-datetime` | `YYYY-MM-DDTHH:MM`, zoneless — needs a zone               |
| `time-of-day`    | `HH:MM` — needs a date AND a zone                         |
| `mixed`          | more than one of the above live here; the note says which |

`convention` — how an `instant` is serialized:

| convention   | shape                                                            |
| ------------ | ---------------------------------------------------------------- |
| `canonical`  | `YYYY-MM-DDTHH:MM:SSZ` (`lib/date.ts` `utcInstant`) — the target |
| `bare`       | `YYYY-MM-DD HH:MM:SS`, SQLite's `datetime('now')`, UTC, unstated |
| `iso-ms`     | `…THH:MM:SS.mmmZ` — a JS `toISOString` that reached storage      |
| `mixed`      | the column holds more than one of these; the note says why       |
| `unverified` | not settled by a DEFAULT or a writer that was read               |
| `n/a`        | not instant-grained, so there is no instant convention           |

`unverified` is not a shrug. It is the remaining convention worklist: the scan requires a note on
every one and freezes the count, so it can only shrink. Readers do not depend on it —
`eventInstant` normalizes whatever it finds to the canonical shape on the way out, which
is what makes a caller immune both to phase 2's renames and to a later convention change.

## The entries worth reading before writing SQL

- **`metric_samples.started_at`** holds vendor ISO-with-milliseconds for an imported
  sample AND `${date}T00:00:00` — a profile-local day midnight, not an instant — for a
  reading whose author stated only a day. It is also the natural key that makes a
  re-entry a correction rather than a duplicate, so neither shape can be normalized
  without changing dedupe.
- **`illness_episodes.started_at` / `ended_at`** are DAYS, and `ended_at` is
  **exclusive** — the first inactive day. Reading it as an instant, or as an inclusive
  end, is wrong twice.
- **`intake_item_logs.given_at` is a RECORD instant, by owner ruling.** For a scheduled
  confirm it is _inferred_: the tap moment stands in for an intake the app never
  observed, so it is a `recorded_at` that has been wearing an event's name. Phase 2
  wave 1 (migration 165) added the **nullable `occurred_at`** beside it, populated only
  when the user actually states a time — "we don't know when this happened" is now a
  first-class state instead of an inferred value. The table used to have **no event
  column at all**, so `eventInstant("intake_item_logs", row)` answered `not-declared`
  for every row; today it answers `not-recorded` for a row nobody timed. Those are
  different facts and neither one is the record instant. What remains of the ruling is
  the rename of `given_at` to `recorded_at`, shipped in migration 173.
- **`occurred_at` means one thing in all three observation stores** (`medical_records`,
  `body_metrics`, `intake_item_logs`, migration 165): the instant the reading or intake
  actually happened, canonical shape, and **NULL means day-grain** — absence, not empty
  apparatus. The asymmetry with `metric_samples` is deliberate: that table files an
  untimed reading at `${date}T00:00:00` because `started_at` is part of its natural key
  and a re-entry has to be a correction rather than a duplicate. These three carry a
  real `date` column and key on it, so they can afford honest absence. Two stores spell
  "not stated" as NULL, one spells it as midnight; that is a real thing an eventual
  readings merge has to resolve, and naming it is worth more than a uniform-looking
  anchor that would change what a row's key means.
- **The dose ledger now matches the food ledger (#2876).** `recorded_at` is immutable
  capture and `occurred_at` is the administration event. `recordInstant` answers the
  former; `eventInstant` answers the latter; `bestKnownInstant` makes any cross-question
  fallback explicit.
- **`food_log_events.eaten_at`** is NULL whenever nobody stated an eating time, and
  `time_source` records whether a present value was a tap contract or a stated one. The
  web bar never defaults it to now (#2019/#2053).
- **`practice_logs.time`** is a bare local `HH:MM` and often NULL. It is not an instant;
  resolving it needs the row's `date` and the profile timezone.
- **`activities.start_time` / `end_time`** are likewise profile-local `HH:MM` clock
  values. They remain `_time` deliberately because training-rhythm inference reads
  the stated local hour; they are not unconverted instants.
- **`notify_lifecycle.at`** was `new Date().toISOString()` — milliseconds and a `Z`, a
  third serialization phase 1's rule C did not see because the module that builds the
  string writes no SQL of its own. Migration 167 (#2233) normalized it onto the
  canonical instant and the writer now binds `instantNow()`. Nothing compares it in
  SQL today.
- **`appointments.date` + `appointments.time_of_day`** are the CLINIC's local day and
  optional wall clock (#2234's split of the old mixed-grain `scheduled_at`). A NULL
  `time_of_day` IS the day-only grain, and neither half is ever resolved against the
  profile timezone — the clinic's zone is not stored anywhere (#2243 owns that
  question).

## The index

<!-- BEGIN GENERATED: time-column index -->

| table | column | semantic | grain | convention | notes |
| ----- | ------ | -------- | ----- | ---------- | ----- |
| `activities` | `date` | day | day | n/a |  |
| `activities` | `start_time` | window-start | time-of-day | n/a | A profile-local HH:MM, optional (a hand-entered activity may state only a day). It is NOT an instant: resolving it needs the row's `date` AND the profile timezone. Every writer agrees — `NormActivity.start_time` is declared HH:MM for all integrations, the editor's field is a `type="time"` input, and the AI extractor's ISO shape is folded to HH:MM at the persist boundary (`activityClockHHMM`, #2245). |
| `activities` | `end_time` | window-end | time-of-day | n/a | The same profile-local HH:MM as start_time, and NULL both for a hand-entered activity that stated only a day and while a live session is unfinished. |
| `activities` | `created_at` | record | instant | bare | Still bare, but no longer written by SQL: every app write path BINDS it from the clock seam (`sqlNow()`, #2287) instead of leaning on the column's own SQL-clock DEFAULT. `computeWorkoutPresence` reads it as a draft's first-seen instant (and as an imported row's freshness anchor) and subtracts it from a seam-derived now, so a stamp off SQL's real clock made a seconds-old draft read as an hour quiet whenever the two clocks diverged. The DEFAULT stays — it lives in a shipped migration — and is now only a backstop. |
| `activities` | `updated_at` | bookkeeping | instant | bare | The #451 auto-save stamp, and the LIVENESS signal workout presence prefers over `created_at` (lastTouchMs = updated_at ?? created_at). Bound from the clock seam (`sqlNow()`, #2287) at every writer for the same reason: it is compared to the app's now, not merely displayed. |
| `activity_telemetry` | `snapshot_at` | record | instant | unverified | Supplied by the Strava sync as a caller argument; its serialization is whatever that path produced. Nothing compares it in SQL, so phase 1 left it unclaimed. |
| `activity_videos` | `created_at` | record | instant | bare |  |
| `ai_usage_counters` | `day` | day | day | n/a |  |
| `allergies` | `onset_date` | event | day | n/a |  |
| `allergies` | `created_at` | record | instant | bare |  |
| `allergy_reactions` | `created_at` | record | instant | bare |  |
| `api_tokens` | `created_at` | bookkeeping | instant | bare |  |
| `api_tokens` | `last_used_at` | lifecycle | instant | bare |  |
| `api_tokens` | `revoked_at` | lifecycle | instant | bare |  |
| `appointments` | `date` | planned | day | n/a | The CLINIC-local calendar day of the visit (#2234) — NOT a profile-local day: the clinic is frequently not in the profile's zone, and the value is never resolved against the profile timezone. NOT NULL. |
| `appointments` | `time_of_day` | planned | time-of-day | n/a | The CLINIC-local wall clock (HH:MM), NULL for a day-only booking — a real product state, not a missing time. Resolving it to an instant needs the row's date AND the clinic's zone, which the app does not store (#2243 owns that question); it is never resolved against the profile timezone. |
| `appointments` | `created_at` | record | instant | bare |  |
| `audit_events` | `ts` | record | instant | bare |  |
| `body_metrics` | `date` | day | day | n/a |  |
| `body_metrics` | `occurred_at` | event | instant | canonical | Migration 165 (#2235, #2205 phase 2 wave 1). When the day's weigh-in was actually taken. Body weight moves a kilogram across a day, so morning-fasted and evening-fed are different measurements of one quantity and an unlabelled mix carries that swing as unattributable noise. NULL means DAY-GRAIN. Descriptive only — the natural key stays (profile_id, date, source), and one row per day is unchanged, so this records WHEN the day's reading was taken and does not enable two weigh-ins in one day. This table has no record stamp at all, so there is nothing here for an event column to be laundered from. |
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
| `coverage_gaps` | `ai_generated_at` | event | instant | unverified | When the AI produced this gap — the row's own event. Its serialization is settled by neither a DEFAULT nor a writer that was read, so phase 2 has to look. |
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
| `fasts` | `started_at` | window-start | instant | canonical | Migration 20260816-fasts (#2756). The instant the user CLAIMS the fast began — a claim, never a sensor reading, and never inferred from the food log (whose instants are tap times). BORN canonical, so the first writer is bound to utcInstant() by CANONICAL_INSTANT_COLUMNS rather than choosing a shape at the call site. An INSTANT and not a day on purpose: a fast spans a profile-local day boundary by nature, so a day column would be wrong on the majority of rows. Accepts a backdated value (forgot-to-tap is the common failure); the write core refuses a future one and one further back than FAST_MAX_HOURS. No column DEFAULT, deliberately: SQLite's own SQL clock writes the BARE shape, which is exactly how a canonical column ends up holding two serializations. |
| `fasts` | `ended_at` | window-end | instant | canonical | The claimed end, and NULL is load-bearing: `ended_at IS NULL` IS the active state (there is no status enum), which the partial unique index makes at-most-one-per-profile and every derivation downstream assumes. EXCLUSIVE as an interval end — ending one fast and starting the next at the same instant is a legitimate back-to-back pair, not an overlap. The profile-local DAY a completed fast counts for (#94) is derived from this column at read time (fastAttributedDay: a fast counts for the day it ENDS) and deliberately not stored, because storing it would freeze one timezone's answer. |
| `fasts` | `end_written_at` | lifecycle | instant | canonical | When the row's CURRENT end was WRITTEN — a transition in the record's own life, never a claim about the subject, and the pair of `ended_at` rather than a second opinion about it. NULL exactly while `ended_at` is NULL: the two are one argument at the store (`FastEnd`, lib/fast-store.ts) and are set and cleared together. It exists because the Undo window has to be measured from the ACTION, and `ended_at` is a claim the surface invites the user to backdate — an end backdated past the window was `too-old` the microsecond it landed. `created_at` cannot answer this either: it is the INSERT stamp and an end is an UPDATE. Read by lib/fast-write.ts's `reopenFast` and by nothing else; no reader surface sees it. |
| `fasts` | `created_at` | record | instant | bare | The ordinary bookkeeping stamp, on the schema's bare convention like every other one — NOT claimed canonical, and never a substitute for `started_at`: when the row reached the app says nothing about when the fast began, which is the whole point of accepting a backdated start. Nor for `end_written_at`: this is stamped once at INSERT, when the fast is still open, and no writer restamps it when the end lands. |
| `fitness_assessment_entries` | `created_at` | record | instant | bare |  |
| `fitness_assessments` | `date` | day | day | n/a |  |
| `fitness_assessments` | `created_at` | record | instant | bare |  |
| `food_daily_totals` | `date` | day | day | n/a |  |
| `food_daily_totals` | `created_at` | record | instant | bare |  |
| `food_log_events` | `date` | day | day | n/a |  |
| `food_log_events` | `recorded_at` | record | instant | canonical | The TAP instant, `logged_at` until migration 183 (#2205 phase 2, the food wave). Migration 056 froze what it means — never backfilled, because the ranking predicts the next TAP — which is the `recorded_at` semantic under a name the table had coined for itself. The same migration normalized the millisecond-shaped values the offline replay had been writing (#2370) and bound every writer to lib/date.ts. |
| `food_log_events` | `created_at` | bookkeeping | instant | bare |  |
| `food_log_events` | `occurred_at` | event | instant | canonical | NULL means nobody stated an eating time, and that stays a real answer (#2019/#2053) rather than being filled in from the tap. `time_source` records whether a present value was a tap contract or a stated one. Named `eaten_at` until migration 183; nothing was backfilled into it then either, because food REFUSES to infer an eating instant where intake infers one, and that divergence is deliberate. |
| `frequency_targets` | `created_at` | bookkeeping | instant | bare |  |
| `genomic_variants` | `report_date` | event | day | n/a |  |
| `genomic_variants` | `created_at` | record | instant | bare |  |
| `goals` | `target_date` | planned | day | n/a |  |
| `goals` | `created_at` | bookkeeping | instant | bare |  |
| `goals` | `achieved_at` | lifecycle | instant | canonical | Migration 182 (#2394) — BORN canonical: the instant `status` became 'achieved', written by setStatus through instantNow() and NULLed when a goal is set back to active. LIFECYCLE and not `event`: it is when the goal ROW was marked reached, not when the underlying performance happened — the app never observes that. NULL on every pre-182 achieved goal, deliberately: the recap announces a goal in the period its RECORDED achievement falls in, so an unrecorded one stays silent rather than being announced retroactively. |
| `hr_minutes` | `ts` | event | instant | canonical | Minute-truncated (lib/date.ts utcMinute) and the row's primary key. Migration 164 converted it from a profile-local wall clock; the local day is now derived at read time. |
| `illness_episodes` | `start_date` | window-start | day | n/a | The inclusive first active day, NULL when the episode predates the log. Renamed from `started_at` by migration 169 (#2232). |
| `illness_episodes` | `end_date` | window-end | day | n/a | The INCLUSIVE last active day, NULL while ongoing — the house day-window convention. Migration 169 (#2232) renamed it from `ended_at` AND rewrote the stored value (the old column held the exclusive first inactive day). |
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
| `intake_item_logs` | `occurred_at` | event | instant | canonical | The stored administration instant. Issue #2876 moved administration writers and corrections here and migrated the old overloaded recorded_at value into it. |
| `intake_item_logs` | `recorded_at` | record | instant | canonical | The immutable capture/insert stamp. Issue #2876 renamed the old taken_at column to this vocabulary and converted it to canonical UTC+Z, matching food_log_events.recorded_at. |
| `intake_item_side_effects` | `noted_on` | event | day | n/a |  |
| `intake_item_side_effects` | `created_at` | record | instant | bare |  |
| `intake_item_suggestions` | `time_of_day` | planned | time-of-day | n/a |  |
| `intake_item_suggestions` | `created_at` | record | instant | bare |  |
| `intake_items` | `created_at` | bookkeeping | instant | bare |  |
| `intake_items` | `cadence_anchor_date` | day | day | n/a | The day an interval cadence counts from, not an observation. |
| `integration_backfill_jobs` | `started_at` | lifecycle | instant | mixed | Written through utcInstant since #2205 phase 1, but no migration rewrote the rows that predate it, so the column can still hold both shapes. A phase-2 wave settles it. |
| `integration_backfill_jobs` | `retry_after_at` | planned | instant | mixed | The lease/backoff cutoff. Its two writers disagreeing about serialization is the bug the time-model doc uses as its worked example; both now bind utcInstant, historical rows are still bare. |
| `integration_backfill_jobs` | `finished_at` | lifecycle | instant | mixed | Written through utcInstant since phase 1, with pre-phase-1 rows still bare. Moves with started_at. |
| `integration_backfill_jobs` | `created_at` | record | instant | bare |  |
| `integration_backfill_jobs` | `updated_at` | bookkeeping | instant | bare |  |
| `integration_connections` | `last_sync_at` | lifecycle | instant | mixed | Written through utcInstant since #2205 phase 1; rows written before it are still on SQLite's bare shape, so both live here until a phase-2 wave converts them. |
| `integration_connections` | `created_at` | bookkeeping | instant | bare |  |
| `integration_connections` | `updated_at` | bookkeeping | instant | bare |  |
| `integration_connections` | `refresh_claimed_at` | lifecycle | instant | mixed | Written through utcInstant since #2205 phase 1; rows written before it are still on SQLite's bare shape, so both live here until a phase-2 wave converts them. |
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
| `medical_records` | `occurred_at` | event | instant | canonical | Migration 165 (#2154, #2205 phase 2 wave 1). When the vital was actually taken — the reading's own instant, distinct from `created_at`, which is when it reached the app. NULL means DAY-GRAIN: nobody stated a time, so `eventInstant` answers not-recorded rather than inventing one. Born on the canonical convention rather than converted onto it, so it is in CANONICAL_INSTANT_COLUMNS from the migration that added it and the first writer is already bound to utcInstant(). No column DEFAULT, deliberately: a clock default would stamp the record instant into the event column. |
| `medical_records` | `created_at` | record | instant | bare |  |
| `medication_courses` | `started_on` | window-start | day | n/a |  |
| `medication_courses` | `stopped_on` | window-end | day | n/a |  |
| `medication_courses` | `created_at` | record | instant | bare |  |
| `metric_samples` | `date` | day | day | n/a |  |
| `metric_samples` | `started_at` | window-start | instant | mixed | THE column that most rewards reading this table before writing SQL. It holds vendor ISO-with-milliseconds for an imported sample AND `${date}T00:00:00` — a profile-local DAY midnight, not an instant — for a reading whose author stated only a day. It is also the natural key (profile, metric, source, origin, started_at) that makes a re-entry a correction, so neither shape can be normalized without changing dedupe. |
| `metric_samples` | `ended_at` | window-end | instant | mixed | The same two shapes as started_at, and equal to it for an instantaneous reading. |
| `milestones` | `achieved_on` | event | day | n/a |  |
| `milestones` | `created_at` | record | instant | bare |  |
| `mood_logs` | `date` | day | day | n/a |  |
| `mood_logs` | `created_at` | record | instant | bare |  |
| `mood_logs` | `updated_at` | bookkeeping | instant | bare |  |
| `narratives` | `period_start` | window-start | day | n/a |  |
| `narratives` | `period_end` | window-end | day | n/a |  |
| `narratives` | `created_at` | record | instant | bare |  |
| `notify_lifecycle` | `at` | event | instant | canonical | Was `new Date().toISOString()` — milliseconds and a `Z`, a third serialization phase 1's rule C could not see because the module that builds the string writes no SQL of its own. Migration 167 (#2233) normalized the stored values and the writer now binds instantNow(). Nothing compares it in SQL. |
| `notify_messages` | `date` | day | day | n/a |  |
| `notify_messages` | `sent_at` | event | instant | bare |  |
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
| `practice_logs` | `time` | event | time-of-day | n/a | A profile-local HH:MM, optional (the quick path writes none). It is NOT an instant: resolving it needs the row's `date` AND the profile timezone, which is why eventInstant refuses without one. |
| `practice_logs` | `created_at` | record | instant | bare |  |
| `preventive_events` | `date` | day | day | n/a |  |
| `preventive_events` | `created_at` | record | instant | bare |  |
| `preventive_overrides` | `created_at` | record | instant | bare |  |
| `preventive_record_decisions` | `confirmed_date` | day | day | n/a | The person-confirmed completion day for a confirmed decision (#3025) — prefilled from the record date, edited before writing. NULL exactly when decision = 'dismissed' (schema CHECK). |
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
| `routines` | `started_date` | window-start | day | n/a |  |
| `routines` | `created_at` | bookkeeping | instant | bare |  |
| `saved_items` | `created_at` | record | instant | bare |  |
| `schema_migrations` | `applied_at` | record | instant | canonical | The migration runner's applied-set ledger (name-keyed migrations; lib/migrations/runner.ts is the only writer, bound to instantNow()). BORN canonical. For rows backfilled from a pre-ledger user_version stamp this is when the backfill ran, not when the migration originally applied — the name is the fact, the timestamp is provenance. |
| `sessions` | `created_at` | bookkeeping | instant | bare |  |
| `sessions` | `expires_at` | planned | instant | bare |  |
| `sessions` | `last_used_at` | lifecycle | instant | bare |  |
| `shared_supplies` | `created_at` | bookkeeping | instant | bare |  |
| `shared_supplies` | `updated_at` | bookkeeping | instant | bare |  |
| `situations` | `created_at` | bookkeeping | instant | bare |  |
| `skin_lesions` | `observed_date` | event | day | n/a |  |
| `skin_lesions` | `created_at` | record | instant | bare |  |
| `stream_frontiers` | `frontier_at` | event | instant | canonical | The newest EVENT instant the stream had reached when ingest last looked — a watermark copied from the stream table's own event column (hr_minutes.ts today), so it carries that column's semantic. NULL while the stream has never delivered a row. Migration 179 (#2341), born canonical. |
| `stream_frontiers` | `advanced_at` | lifecycle | instant | canonical | When the frontier was last observed to MOVE. A transition in this watermark row's own life, not in the subject's: it is the instant the observation was made, never the instant the data carries. Migration 179 (#2341), born canonical. |
| `stream_frontiers` | `observed_at` | record | instant | canonical | When ingest last looked at all, advancing or not — the stamp that makes `syncs_since_advance` auditable. Migration 179 (#2341), born canonical. |
| `substance_daily_totals` | `date` | day | day | n/a |  |
| `substance_daily_totals` | `recorded_at` | record | instant | canonical |  |
| `substance_daily_totals` | `created_at` | bookkeeping | instant | bare |  |
| `symptom_logs` | `date` | day | day | n/a |  |
| `symptom_logs` | `created_at` | record | instant | bare |  |
| `symptom_photos` | `date` | day | day | n/a |  |
| `symptom_photos` | `created_at` | record | instant | bare |  |
| `symptom_videos` | `date` | day | day | n/a |  |
| `symptom_videos` | `created_at` | record | instant | bare |  |
| `upcoming_dismissals` | `snooze_until` | planned | day | n/a |  |
| `upcoming_dismissals` | `dismissed_at` | lifecycle | instant | bare |  |
| `upcoming_dismissals` | `created_at` | bookkeeping | instant | bare |  |
| `visit_link_decisions` | `created_at` | record | instant | bare |  |
| `weather_days` | `date` | day | day | n/a |  |
| `weather_days` | `fetched_at` | record | instant | bare |  |
| `weather_uv_hours` | `hour_ts` | event | local-datetime | n/a | The provider's own top-of-hour stamp (`YYYY-MM-DDTHH:00`), zoneless. Part of the cache key with (lat, lng). |
| `weather_uv_hours` | `fetched_at` | record | instant | bare |  |

<!-- END GENERATED: time-column index -->

## Related

- `docs/internals/time-model.md` — the stored-instant convention, the writer helper and
  phase 1's ratchet.
- #2205 — the umbrella issue and its phasing. #2090 — the prose index this replaces.
- #94 — the day-attribution decision `date` semantics rest on, deliberately untouched.
