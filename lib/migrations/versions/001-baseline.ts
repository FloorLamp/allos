import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// -----------------------------------------------------------------------------
// MIGRATION 001 - BASELINE (issue #119). FROZEN - DO NOT EDIT.
//
// A clean apply of the CURRENT schema: every table with its final column set and
// CHECK constraints, and the final index set - nothing else. This is NOT the
// historical boot path: the legacy upgrade machinery the old migrate() carried
// (rename shims, addColumnIfMissing + the ADDITIVE_COLUMNS registry, the
// ENUM_CHECKS reconcile, profile-scoping rebuilds and index swaps, settings-flag
// one-shots, legacy data backfills) was dropped when the runner landed - all
// deployments are assumed to already be on the final schema, so that code could
// never run again. A deployment on an OLDER release must step through the last
// pre-runner release before upgrading to this one.
//
// Every statement is CREATE ... IF NOT EXISTS, so the two real cases both work:
//   - a FRESH database builds the entire schema here, then is stamped v1;
//   - an existing, up-to-date database replays this as a pure no-op, then is
//     stamped v1.
//
// APPEND-ONLY: never edit this file (the hash manifest in
// lib/migrations/manifest.json fails CI on any change). A new table/column, a
// grown enum CHECK, a one-shot data move, or a key rebuild each ship as the next
// numbered migration in this directory.
// -----------------------------------------------------------------------------

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS activities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          date TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('strength','cardio','sport')),
          title TEXT NOT NULL,
          notes TEXT,
          duration_min INTEGER,
          distance_km REAL,
          intensity TEXT,
          start_time TEXT,
          end_time TEXT,
          components TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          source TEXT,
          external_id TEXT,
          avg_hr REAL,
          max_hr REAL,
          elevation_m REAL,
          avg_speed_kmh REAL,
          max_speed_kmh REAL,
          relative_effort REAL,
          avg_power_w REAL,
          max_power_w REAL,
          weighted_avg_power_w REAL,
          avg_cadence REAL,
          avg_temp_c REAL,
          kilojoules REAL,
          workout_type TEXT,
          edited INTEGER DEFAULT 0,
          updated_at TEXT
        );
    CREATE INDEX IF NOT EXISTS idx_activities_profile_date ON activities(profile_id, date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_external
          ON activities(profile_id, external_id) WHERE external_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS exercise_sets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
          exercise TEXT NOT NULL,
          set_number INTEGER NOT NULL,
          weight_kg REAL,
          reps INTEGER,
          weight_kg_right REAL,
          reps_right INTEGER,
          duration_sec INTEGER,
          duration_sec_right INTEGER,
          target_reps INTEGER,
          to_failure INTEGER,
          equipment_id INTEGER
        );
    CREATE INDEX IF NOT EXISTS idx_sets_activity ON exercise_sets(activity_id);

    CREATE TABLE IF NOT EXISTS body_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          date TEXT NOT NULL,
          weight_kg REAL,
          body_fat_pct REAL,
          resting_hr INTEGER,
          notes TEXT,
          source TEXT
        );
    CREATE INDEX IF NOT EXISTS idx_body_metrics_profile_date ON body_metrics(profile_id, date);

    CREATE TABLE IF NOT EXISTS immunizations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          date TEXT NOT NULL,
          vaccine TEXT NOT NULL,
          dose_label TEXT,
          notes TEXT,
          source TEXT,
          external_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          provider_id INTEGER);
    CREATE INDEX IF NOT EXISTS idx_immunizations_profile ON immunizations(profile_id, vaccine, date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_immunizations_external
          ON immunizations(profile_id, external_id) WHERE external_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS immunization_overrides (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          vaccine TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('immune','declined')),
          reason TEXT,
          note TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(profile_id, vaccine)
        );

    CREATE TABLE IF NOT EXISTS goals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          title TEXT NOT NULL,
          description TEXT,
          category TEXT,
          target_value REAL,
          current_value REAL,
          unit TEXT,
          target_date TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','archived')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          exercise TEXT,
          metric TEXT,
          target_weight_kg REAL,
          target_reps INTEGER,
          target_sets INTEGER,
          target_duration_sec INTEGER,
          body_metric TEXT,
          baseline_value REAL,
          archived INTEGER NOT NULL DEFAULT 0
        );

    CREATE TABLE IF NOT EXISTS medical_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          date TEXT NOT NULL,
          category TEXT NOT NULL CHECK (category IN ('vitals','lab','genomics','biomarker','scan','prescription')),
          name TEXT NOT NULL,
          value TEXT,
          unit TEXT,
          reference_range TEXT,
          notes TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          source TEXT,
          external_id TEXT,
          provider_id INTEGER,
          document_id INTEGER,
          panel TEXT,
          flag TEXT,
          value_num REAL,
          canonical_name TEXT
        );
    CREATE INDEX IF NOT EXISTS idx_medical_document ON medical_records(document_id);
    CREATE INDEX IF NOT EXISTS idx_medical_canonical_ci ON medical_records(profile_id, canonical_name COLLATE NOCASE, date);
    CREATE INDEX IF NOT EXISTS idx_medical_profile_date ON medical_records(profile_id, date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_medical_external
          ON medical_records(profile_id, external_id) WHERE external_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS medical_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          filename TEXT NOT NULL,
          stored_path TEXT NOT NULL,
          mime_type TEXT,
          size_bytes INTEGER,
          doc_type TEXT,
          source TEXT,
          document_date TEXT,
          patient_name TEXT,
          extraction_status TEXT NOT NULL DEFAULT 'pending'
            CHECK (extraction_status IN ('pending','processing','done','failed','skipped')),
          extraction_error TEXT,
          extracted_count INTEGER NOT NULL DEFAULT 0,
          raw_extraction TEXT,
          model TEXT,
          -- The import DEBUGGER report (issue #208 Phase 2): JSON of what the parse
          -- DROPPED + why, and section/resource coverage. Written by import-persist on
          -- import/reprocess; NULL for AI-extracted documents (no structured report).
          import_report TEXT,
          uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
          content_hash TEXT);
    CREATE INDEX IF NOT EXISTS idx_meddoc_hash ON medical_documents(content_hash);
    CREATE INDEX IF NOT EXISTS idx_meddoc_profile_uploaded ON medical_documents(profile_id, uploaded_at);

    CREATE TABLE IF NOT EXISTS allergies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          substance TEXT NOT NULL,
          substance_code TEXT,
          substance_code_system TEXT,
          reaction TEXT,
          severity TEXT,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active','inactive','resolved')),
          onset_date TEXT,
          notes TEXT,
          source TEXT,
          document_id INTEGER,
          external_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_allergies_external
          ON allergies(profile_id, external_id) WHERE external_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS conditions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          name TEXT NOT NULL,
          code TEXT,
          code_system TEXT,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active','inactive','resolved')),
          onset_date TEXT,
          resolved_date TEXT,
          notes TEXT,
          source TEXT,
          document_id INTEGER,
          external_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conditions_external
          ON conditions(profile_id, external_id) WHERE external_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS encounters (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          date TEXT NOT NULL,
          end_date TEXT,
          type TEXT,
          class_code TEXT,
          reason TEXT,
          diagnoses TEXT,
          provider_id INTEGER REFERENCES providers(id),
          location_provider_id INTEGER REFERENCES providers(id),
          notes TEXT,
          source TEXT,
          document_id INTEGER,
          external_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_encounters_external
          ON encounters(profile_id, external_id) WHERE external_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS procedures (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          name TEXT NOT NULL,
          code TEXT,
          code_system TEXT,
          date TEXT,
          provider_id INTEGER REFERENCES providers(id),
          notes TEXT,
          source TEXT,
          document_id INTEGER,
          external_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_procedures_external
          ON procedures(profile_id, external_id) WHERE external_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS family_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          relation TEXT,
          condition TEXT NOT NULL,
          code TEXT,
          code_system TEXT,
          onset_age INTEGER,
          deceased INTEGER,
          notes TEXT,
          source TEXT,
          document_id INTEGER,
          external_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_family_history_external
          ON family_history(profile_id, external_id) WHERE external_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS care_plan_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          description TEXT NOT NULL,
          code TEXT,
          code_system TEXT,
          category TEXT,
          planned_date TEXT,
          status TEXT,
          provider_id INTEGER REFERENCES providers(id),
          notes TEXT,
          source TEXT,
          document_id INTEGER,
          external_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_care_plan_items_external
          ON care_plan_items(profile_id, external_id) WHERE external_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS care_goals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          description TEXT NOT NULL,
          code TEXT,
          code_system TEXT,
          target_date TEXT,
          status TEXT,
          notes TEXT,
          source TEXT,
          document_id INTEGER,
          external_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_care_goals_external
          ON care_goals(profile_id, external_id) WHERE external_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS appointments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          scheduled_at TEXT NOT NULL,
          provider_id INTEGER REFERENCES providers(id),
          title TEXT,
          location TEXT,
          notes TEXT,
          status TEXT NOT NULL DEFAULT 'scheduled'
            CHECK (status IN ('scheduled','completed','cancelled')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    CREATE INDEX IF NOT EXISTS idx_appointments_profile
          ON appointments(profile_id, scheduled_at);

    CREATE TABLE IF NOT EXISTS import_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          type TEXT NOT NULL CHECK (type IN ('workouts','biomarkers')),
          status TEXT NOT NULL DEFAULT 'processing'
            CHECK (status IN ('processing','ready','failed','skipped')),
          source_text TEXT,
          result_json TEXT,
          summary TEXT,
          error TEXT,
          model TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    CREATE INDEX IF NOT EXISTS idx_import_jobs_created ON import_jobs(created_at);

    CREATE TABLE IF NOT EXISTS intake_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          name TEXT NOT NULL,
          notes TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          -- Missed-dose escalation (issue #103 Phase A): critical marks a medication
          -- whose unconfirmed doses get a follow-up nudge; escalate_after_min is how
          -- long after the slot's reminder to wait; escalate_chat_id optionally routes
          -- the escalation to a second chat (e.g. a caregiver) instead of the
          -- profile's own. Nullable/off by default so ordinary supplements are unchanged.
          critical INTEGER NOT NULL DEFAULT 0,
          escalate_after_min INTEGER,
          escalate_chat_id TEXT,
          -- Refill tracking (issue #103 Phase B). quantity_on_hand is the units left
          -- (pills/caps/mL) — NULL means "not tracked" (ordinary supplements opt out);
          -- qty_per_dose is how many units one dose consumes, decremented on a
          -- confirmed dose. Defaulted/nullable so existing rows are unaffected.
          quantity_on_hand REAL,
          qty_per_dose REAL NOT NULL DEFAULT 1,
          -- Medication identity (issue #103 Phase C). kind splits medications from
          -- supplements so the shared dose/schedule/adherence/escalation/refill
          -- machinery serves both; prescriber/pharmacy/rx_number are medication-only
          -- free text; as_needed marks a PRN med that generates no scheduled
          -- reminders/escalation/adherence-due. All defaulted/nullable so existing
          -- supplement rows are unchanged.
          kind TEXT NOT NULL DEFAULT 'supplement',
          prescriber TEXT,
          pharmacy TEXT,
          rx_number TEXT,
          as_needed INTEGER NOT NULL DEFAULT 0,
          -- Provenance (issue #150). A medication row can be entered by hand
          -- (source='manual', document_id NULL) or auto-structured from an uploaded
          -- prescription (source='extracted', document_id = the source document).
          -- The extraction persist keys its per-document delete/replace set on
          -- (profile_id, document_id, source='extracted') so a reprocess/delete of a
          -- document updates/removes exactly the meds it produced and never touches a
          -- manual row. Nullable/undefaulted so existing rows are unaffected.
          document_id INTEGER REFERENCES medical_documents(id),
          source TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          provider_id INTEGER,
          condition TEXT NOT NULL DEFAULT 'daily',
          priority TEXT NOT NULL DEFAULT 'high',
          brand TEXT,
          product TEXT,
          situation TEXT,
          stack TEXT
        );
    CREATE INDEX IF NOT EXISTS idx_intake_items_document
           ON intake_items(profile_id, document_id);

    CREATE TABLE IF NOT EXISTS replayed_keys (
          client_key TEXT PRIMARY KEY,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          flow TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

    CREATE TABLE IF NOT EXISTS insights (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          date TEXT NOT NULL,
          summary TEXT NOT NULL,
          model TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (profile_id, date)
        );

    CREATE TABLE IF NOT EXISTS narratives (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          kind TEXT NOT NULL,
          period_start TEXT,
          period_end TEXT NOT NULL,
          summary TEXT NOT NULL,
          model TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (profile_id, kind, period_end)
        );

    CREATE TABLE IF NOT EXISTS ai_usage_counters (
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          day TEXT NOT NULL,
          kind TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (profile_id, day, kind)
        );

    CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

    CREATE TABLE IF NOT EXISTS providers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('organization','individual')),
          npi TEXT,
          identifier TEXT,
          phone TEXT,
          address TEXT,
          dedup_key TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

    CREATE TABLE IF NOT EXISTS logins (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE COLLATE NOCASE NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('admin','member')) DEFAULT 'member',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          totp_secret TEXT,
          totp_enabled INTEGER NOT NULL DEFAULT 0,
          totp_last_step INTEGER
        );

    CREATE TABLE IF NOT EXISTS profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          photo_path TEXT,
          photo_version INTEGER NOT NULL DEFAULT 0
        );

    CREATE TABLE IF NOT EXISTS login_profiles (
          login_id INTEGER NOT NULL REFERENCES logins(id) ON DELETE CASCADE,
          profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          access TEXT NOT NULL DEFAULT 'write',
          PRIMARY KEY (login_id, profile_id)
        );

    CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          login_id INTEGER NOT NULL REFERENCES logins(id) ON DELETE CASCADE,
          active_profile_id INTEGER REFERENCES profiles(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL,
          last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
          user_agent TEXT);
    CREATE INDEX IF NOT EXISTS idx_sessions_login ON sessions(login_id);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
          endpoint TEXT PRIMARY KEY,
          login_id INTEGER NOT NULL REFERENCES logins(id) ON DELETE CASCADE,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_login ON push_subscriptions(login_id);

    CREATE TABLE IF NOT EXISTS profile_share_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          token_hash TEXT NOT NULL UNIQUE,
          fields TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_by INTEGER REFERENCES logins(id) ON DELETE SET NULL,
          revoked_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    CREATE INDEX IF NOT EXISTS idx_share_links_profile ON profile_share_links(profile_id);

    CREATE TABLE IF NOT EXISTS login_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL,
          ip TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    CREATE INDEX IF NOT EXISTS idx_login_attempts_user ON login_attempts(username, created_at);
    CREATE INDEX IF NOT EXISTS idx_login_attempts_created ON login_attempts(created_at);

    CREATE TABLE IF NOT EXISTS login_recovery_codes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          login_id INTEGER NOT NULL REFERENCES logins(id) ON DELETE CASCADE,
          code_hash TEXT NOT NULL,
          used_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    CREATE INDEX IF NOT EXISTS idx_recovery_codes_login ON login_recovery_codes(login_id);

    CREATE TABLE IF NOT EXISTS login_totp_challenges (
          token_hash TEXT PRIMARY KEY,
          login_id INTEGER NOT NULL REFERENCES logins(id) ON DELETE CASCADE,
          username TEXT NOT NULL,
          next_path TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL
        );
    CREATE INDEX IF NOT EXISTS idx_totp_challenges_expires ON login_totp_challenges(expires_at);

    CREATE TABLE IF NOT EXISTS audit_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL DEFAULT (datetime('now')),
          login_id INTEGER,
          active_profile_id INTEGER,
          action TEXT NOT NULL,
          target TEXT,
          detail TEXT
        );
    CREATE INDEX IF NOT EXISTS idx_audit_events_ts ON audit_events(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_events_login_ts ON audit_events(login_id, ts);

    CREATE TABLE IF NOT EXISTS profile_settings (
          profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (profile_id, key)
        );

    CREATE TABLE IF NOT EXISTS login_settings (
          login_id INTEGER NOT NULL REFERENCES logins(id) ON DELETE CASCADE,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (login_id, key)
        );

    CREATE TABLE IF NOT EXISTS integration_connections (
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          provider TEXT NOT NULL,                           -- 'health-connect','strava','garmin'
          status TEXT NOT NULL DEFAULT 'disconnected',      -- 'connected' | 'disconnected'
          config TEXT,                                      -- JSON: { token } now; OAuth tokens later
          last_sync_at TEXT,
          last_sync_summary TEXT,                           -- JSON counts
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (profile_id, provider)
        );

    CREATE TABLE IF NOT EXISTS integration_sync_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          provider TEXT NOT NULL,                           -- 'health-connect' | 'strava'
          at TEXT NOT NULL,                                 -- ISO / SQLite UTC datetime of the sync
          ok INTEGER NOT NULL,                              -- 1 success, 0 failure
          window_start TEXT,                                -- data window the batch covered (nullable)
          window_end TEXT,
          received INTEGER,                                 -- rows received from the source (nullable)
          written INTEGER,                                  -- rows persisted by the idempotent upserts
          skipped INTEGER,                                  -- rows received but not written (parser-dropped: malformed/unmappable)
          error TEXT,                                       -- failure message when ok = 0 (nullable)
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          inserted INTEGER,
          updated INTEGER,
          unchanged INTEGER,
          raw_ref TEXT
        );
    CREATE INDEX IF NOT EXISTS idx_sync_events_profile_provider_at
          ON integration_sync_events(profile_id, provider, at);

    CREATE TABLE IF NOT EXISTS metric_samples (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          source TEXT NOT NULL,                             -- integration id (provenance)
          metric TEXT NOT NULL,                             -- 'steps','distance_km','active_kcal','total_kcal','hrv_ms'
          date TEXT NOT NULL,                               -- YYYY-MM-DD calendar day of start_time in the PROFILE's timezone at ingest (issue #94)
          start_time TEXT NOT NULL,                         -- absolute ISO instant (zone-independent) — the natural-key anchor
          end_time TEXT NOT NULL,                           -- absolute ISO instant
          value REAL NOT NULL,
          -- Natural key is the absolute time window, NOT date. Ingest derives date from
          -- the profile timezone (see integrations/health-connect.parts), so a rolling-
          -- 48h re-push of the same sample matches this key regardless of the derived day
          -- and the ON CONFLICT re-writes date in place — no duplicate row. A profile-
          -- timezone change thus self-heals recent rows on their next re-push; rows older
          -- than the re-push window keep their originally-derived day (a one-time
          -- historical skew accepted rather than backfilled — issue #94).
          UNIQUE (profile_id, metric, source, start_time, end_time)
        );
    CREATE INDEX IF NOT EXISTS idx_metric_samples_md ON metric_samples(profile_id, metric, date);

    CREATE TABLE IF NOT EXISTS hr_minutes (
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          ts TEXT NOT NULL,                                 -- YYYY-MM-DDTHH:MM profile-local at ingest (no zone stored — see #94 note above)
          bpm REAL NOT NULL,                                -- count-weighted average
          bpm_min REAL,
          bpm_max REAL,
          n INTEGER NOT NULL,                               -- samples in bucket (for weighted merge)
          source TEXT,
          PRIMARY KEY (profile_id, ts)
        );
    CREATE INDEX IF NOT EXISTS idx_hr_minutes_day ON hr_minutes(profile_id, substr(ts,1,10));

    CREATE TABLE IF NOT EXISTS upcoming_dismissals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          signal_key TEXT NOT NULL,
          snooze_until TEXT,
          dismissed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_upcoming_dismissals_key
          ON upcoming_dismissals(profile_id, signal_key);

    CREATE TABLE IF NOT EXISTS milestones (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          key TEXT NOT NULL,
          kind TEXT NOT NULL,
          threshold INTEGER NOT NULL,
          title TEXT NOT NULL,
          detail TEXT,
          achieved_on TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_milestones_key
          ON milestones(profile_id, key);

    CREATE TABLE IF NOT EXISTS deleted_rows (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          kind TEXT NOT NULL,
          -- Short, NON-PHI descriptor of the kind (e.g. "activity") for a future trash
          -- view. The identifying content lives only in the payload column.
          label TEXT,
          payload TEXT NOT NULL,
          deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    CREATE INDEX IF NOT EXISTS idx_deleted_rows_deleted_at
          ON deleted_rows(deleted_at);

    CREATE TABLE IF NOT EXISTS import_pair_decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          domain TEXT NOT NULL,        -- 'activity' | 'body_metric'
          pair_signature TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('merged','kept-both','dismissed')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_import_pair_decisions_key
          ON import_pair_decisions(profile_id, domain, pair_signature);

    CREATE TABLE IF NOT EXISTS equipment (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          weight_kg REAL,
          category TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          -- Born NOT NULL: every row is owned by a profile from creation.
          profile_id INTEGER NOT NULL REFERENCES profiles(id)
        );

    CREATE TABLE IF NOT EXISTS frequency_targets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope_kind TEXT NOT NULL CHECK (scope_kind IN ('region','group','type')),
          scope_value TEXT NOT NULL,
          per_week INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          -- Born NOT NULL: every row is owned by a profile from creation.
          profile_id INTEGER NOT NULL REFERENCES profiles(id)
        );

    CREATE TABLE IF NOT EXISTS intake_item_suggestions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          dosage TEXT,
          time_of_day TEXT,
          condition TEXT NOT NULL DEFAULT 'daily',
          priority TEXT NOT NULL DEFAULT 'high',
          brand TEXT,
          product TEXT,
          situation TEXT,
          rationale TEXT NOT NULL,
          trigger TEXT,
          source_detail TEXT,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','accepted','dismissed')),
          model TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          -- Born NOT NULL: every row is owned by a profile from creation.
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          food_timing TEXT NOT NULL DEFAULT 'any');
    CREATE INDEX IF NOT EXISTS idx_intake_sugg_status ON intake_item_suggestions(status);

    CREATE TABLE IF NOT EXISTS intake_item_doses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          supplement_id INTEGER NOT NULL REFERENCES intake_items(id) ON DELETE CASCADE,
          amount TEXT,
          time_of_day TEXT,
          food_timing TEXT NOT NULL DEFAULT 'any',
          sort INTEGER NOT NULL DEFAULT 0
        );
    CREATE INDEX IF NOT EXISTS idx_intake_doses_item ON intake_item_doses(supplement_id);

    CREATE TABLE IF NOT EXISTS intake_item_pairs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          a_id INTEGER NOT NULL REFERENCES intake_items(id) ON DELETE CASCADE,
          b_id INTEGER NOT NULL REFERENCES intake_items(id) ON DELETE CASCADE,
          relation TEXT NOT NULL DEFAULT 'separate' CHECK (relation IN ('with','separate')),
          note TEXT,
          UNIQUE (a_id, b_id, relation)
        );

    CREATE TABLE IF NOT EXISTS intake_item_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          dose_id INTEGER NOT NULL REFERENCES intake_item_doses(id) ON DELETE CASCADE,
          supplement_id INTEGER REFERENCES intake_items(id) ON DELETE CASCADE,
          date TEXT NOT NULL,
          taken_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (dose_id, date)
        );
    CREATE INDEX IF NOT EXISTS idx_intake_log_date ON intake_item_logs(date);

    CREATE TABLE IF NOT EXISTS medication_courses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_id INTEGER NOT NULL REFERENCES intake_items(id) ON DELETE CASCADE,
          started_on TEXT,
          stopped_on TEXT,
          stop_reason TEXT,
          notes TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    CREATE INDEX IF NOT EXISTS idx_med_courses_item ON medication_courses(item_id);

    CREATE TABLE IF NOT EXISTS intake_item_side_effects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_id INTEGER NOT NULL REFERENCES intake_items(id) ON DELETE CASCADE,
          course_id INTEGER REFERENCES medication_courses(id) ON DELETE SET NULL,
          effect TEXT NOT NULL,
          severity TEXT,
          noted_on TEXT,
          notes TEXT,
          resolved INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    CREATE INDEX IF NOT EXISTS idx_side_effects_item
          ON intake_item_side_effects(item_id);

    CREATE TABLE IF NOT EXISTS starred_biomarkers (
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          canonical_name TEXT NOT NULL COLLATE NOCASE,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (profile_id, canonical_name)
        );

    CREATE TABLE IF NOT EXISTS canonical_biomarkers (
          name TEXT PRIMARY KEY COLLATE NOCASE,
          category TEXT,
          unit TEXT,
          ref_low REAL, ref_high REAL,
          ref_low_male REAL, ref_high_male REAL,
          ref_low_female REAL, ref_high_female REAL,
          optimal_low REAL, optimal_high REAL,
          optimal_low_male REAL, optimal_high_male REAL,
          optimal_low_female REAL, optimal_high_female REAL,
          direction TEXT,
          -- Age-banded reference/optimal overrides as a JSON array (AgeBandedRange[]),
          -- for analytes whose normal range shifts with age. NULL when the adult
          -- top-level fields suffice. See lib/reference-range.selectAgeBand.
          ranges_by_age TEXT,
          -- Reproductive-status reference overrides as a JSON object keyed by menopausal
          -- status (female physiology only), for the reproductive hormones. NULL when
          -- inapplicable. See lib/reference-range.selectStatusRange.
          ranges_by_status TEXT,
          note TEXT,
          source TEXT NOT NULL DEFAULT 'ai',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
  `);
}

// The ordered baseline migration. id === position in the MIGRATIONS array.
export const migration: Migration = {
  id: 1,
  name: "001-baseline",
  up,
};
