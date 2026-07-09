import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import canonicalSeed from "./canonical-biomarkers.json";
import { computeFlagReconciliation } from "./flag-reconcile";
import { resolveTimezone } from "./timezone";
import { canonicalFlagsSignature } from "./canonical-flags-version";
import { dateStrInTz, shiftDateStr } from "./date";
import { hashPasswordSync } from "./password";
import { roundBodyMetric, foldSampleIntoRow } from "./body-metric-extract";
import { BACKFILL_OWNED_TABLES } from "./owned-tables";
import { tableColumns } from "./migrations/schema-utils";
import {
  renameAuthTablesForBranch,
  migrateWeighInsToBodyMetrics,
  migrateSupplementsToIntakeItems,
} from "./migrations/renames";
import { migrateMedicationHistory } from "./migrations/intake";
import {
  backfillProfileIds,
  rebuildForProfileScoping,
  rebuildMetricSamplesSourceKey,
  relaxBodyMetricsWeightKg,
  swapProfileScopedIndexes,
} from "./migrations/profile-scoping";

// Single shared connection across hot-reloads in dev.
const globalForDb = globalThis as unknown as { __healthDb?: Database.Database };

// Every (table, column) that `addColumnIfMissing` is asked to ensure — recorded
// on EVERY call (whether or not the column was actually added), so a test can
// enumerate exactly which columns are added *after* the CREATE-block, i.e. the
// additive-upgrade surface, independent of any particular DB's state. Purely
// observational: it changes nothing about which columns get added. Consumed by
// lib/__db_tests__/migrate.test.ts to auto-derive a plausible "old release"
// schema (strip these) and prove the upgrade path re-adds them without crashing.
export const ADDITIVE_COLUMNS: { table: string; column: string }[] = [];

function createDb(): Database.Database {
  // The DB path is data/allos.db in normal operation. A test (see
  // lib/__db_tests__) can redirect the singleton at a throwaway database — a temp
  // file or ":memory:" — by setting ALLOS_DB_PATH before this module is first
  // imported, so the query smoke tests exercise the real query functions without
  // touching (or depending on) a developer's data/allos.db. Unset in normal boot,
  // where the path is unchanged. ":memory:" has no directory to create.
  const override = process.env.ALLOS_DB_PATH;
  const dbPath = override || path.join(process.cwd(), "data", "allos.db");
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Parallel `next build` workers each open the DB and run migrate() at once; a
  // generous busy timeout lets a writer wait out another's write lock instead of
  // failing an IMMEDIATE transaction with SQLITE_BUSY (see rebuildTable).
  db.pragma("busy_timeout = 10000");
  migrate(db);
  return db;
}

export function migrate(db: Database.Database) {
  // Branch-era shim (PR #100): the auth tables were originally named
  // accounts/account_profiles/account_settings, with sessions.account_id. They're
  // renamed to logins/login_profiles/login_settings (+ sessions.login_id) — an
  // account is the *login*, distinct from the profile (the data subject). Because
  // PR #100 is unmerged, these tables exist only on this branch, so we rename in
  // place for any dev DB created while testing the old names. Idempotent: if the
  // old table exists and the new one doesn't, rename it; otherwise no-op. Runs
  // before the CREATE TABLE IF NOT EXISTS blocks below so they find the new names.
  renameAuthTablesForBranch(db);

  // weigh_ins → body_metrics (#120): the table now holds weightless rows (a
  // vitals panel's resting HR / body-fat with no scale weight), so its name is no
  // longer accurate. Rename in place before the CREATE blocks below find it, so an
  // existing dev/prod DB carries its rows over; the NOT NULL on weight_kg is
  // dropped later (relaxBodyMetricsWeightKg, after profile_id/source exist).
  migrateWeighInsToBodyMetrics(db);

  // supplements → intake_items (#147): the table (and its child tables) now hold
  // both supplements and medications, split by `kind`, so the old names
  // misrepresent the contents. Rename the whole family in place before the CREATE
  // blocks below find them, so an existing dev/prod DB carries its rows over
  // instead of getting fresh empty tables. Idempotent + no behavior change.
  migrateSupplementsToIntakeItems(db);

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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

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
      duration_sec_right INTEGER
    );

    -- Dated body metrics: weight, body-fat %, resting HR. weight_kg is nullable
    -- (#120) so a document/vitals panel reporting only HR or body fat still lands
    -- here rather than being split into medical_records. source: NULL for manual
    -- entries, 'health-connect'/etc. for integration rows, 'document:<id>' for
    -- rows projected from an uploaded medical record.
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

    -- Vaccine administrations (one row per dose). vaccine is a catalog/combo
    -- code (lib/immunization-catalog); antibody titers live in medical_records,
    -- not here. source matches the medical provenance convention: NULL for
    -- manual entries, document:<id> for rows projected from an uploaded record.
    CREATE TABLE IF NOT EXISTS immunizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      date TEXT NOT NULL,
      vaccine TEXT NOT NULL,
      dose_label TEXT,
      notes TEXT,
      source TEXT,
      external_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Manual per-vaccine status overrides (issue #155). One row per
    -- (profile, vaccine) code: kind='immune' counts the series complete despite
    -- missing doses (the manual counterpart to a titer); kind='declined' drops
    -- the vaccine from needs-attention and shows a muted "Declined" status. The
    -- pure resolver is applyOverride() in lib/immunization-status.
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

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
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Allergies / intolerances (issue #179). A CCD Allergies section (LOINC
    -- 48765-2) or a manual entry. substance is the offending agent (a name, with
    -- an optional code); reaction/severity are free text as printed. status is the
    -- clinical status. source mirrors the medical provenance convention: NULL for
    -- manual entries, 'document:<id>' for rows projected from an uploaded record;
    -- external_id is the stable per-document dedup key (a per-profile partial-unique
    -- index enforces it). A "No known allergies" statement is NOT stored as a row
    -- (see lib/clinical-parse) — the empty list renders as "no known allergies".
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

    -- Problem list / conditions (issue #180). A CCD Active Problems section (LOINC
    -- 11450-4) or a manual entry. name is the display term; code/code_system the
    -- coded identity (ICD-10 / SNOMED) when present. status is the clinical status;
    -- onset/resolved dates when known. Provenance/dedup mirror the allergies table.
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

    -- Encounters / visit history (issue #178 Phase B). A CCD Encounters section
    -- (LOINC 46240-8) or a manual entry. date is the visit start; end_date the
    -- period end when carried. type is the encounter type display ("Office Visit");
    -- class_code the HL7 ActEncounterCode (AMB/IMP/…). reason is the chief
    -- complaint. diagnoses is a '; '-joined SUMMARY of the visit diagnosis display
    -- names — a single column rather than a child table (the simpler modeling that
    -- still preserves the printed diagnoses; the coded problem list lives in the
    -- conditions table). provider_id is the attending clinician, location_provider_id
    -- the facility — both nullable FKs into the shared, GLOBAL providers registry.
    -- Provenance/dedup mirror the allergies/conditions tables: source NULL for a
    -- manual entry, 'document:<id>' for an imported row; external_id is the stable
    -- per-document dedup key (a per-profile partial-unique index enforces it). This
    -- is a brand-new table, so every column below is present at CREATE and the
    -- inline index is upgrade-safe (never the #157 add-column-then-index bug).
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

    -- Procedures / surgical history. A CCD Procedures section (LOINC 47519-4) or a
    -- FHIR Procedure resource, plus manual entry. name is the display term;
    -- code/code_system the coded identity (CPT / SNOMED / ICD-10-PCS) when present;
    -- date the performed date. provider_id is the performing clinician, an OPTIONAL
    -- nullable FK into the shared GLOBAL providers registry. Provenance/dedup mirror
    -- the allergies/conditions tables: source NULL for a manual entry, 'document:<id>'
    -- for an imported row; external_id is the stable per-document dedup key (a
    -- per-profile partial-unique index enforces it). Brand-new table, so every column
    -- is present at CREATE and the inline index is upgrade-safe (never the #157
    -- add-column-then-index bug).
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

    -- Family history. A CCD Family History section (LOINC 10157-6) or a FHIR
    -- FamilyMemberHistory resource, plus manual entry. relation is the affected
    -- relative (mother/father/sibling/…); condition the display term for their
    -- diagnosis; code/code_system its coded identity (SNOMED / ICD-10) when present.
    -- onset_age is the relative's age at onset (years, nullable); deceased is 0/1
    -- (nullable when unknown). One row per (relative, condition) pair. Provenance/
    -- dedup mirror the conditions table. Brand-new table — every column present at
    -- CREATE, inline index upgrade-safe.
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

    -- Care plan items — planned / ordered future care. A CCD Plan of Treatment /
    -- Care Plan section (LOINC 18776-5) or a FHIR CarePlan resource's activities,
    -- plus manual entry. description is the display term; code/code_system its coded
    -- identity when present; category classifies the planned activity (procedure /
    -- encounter / medication / observation / …); planned_date the intended date;
    -- status the lifecycle (planned / active / completed / …). provider_id is the
    -- ordering/responsible clinician, an OPTIONAL nullable FK into the shared GLOBAL
    -- providers registry. Provenance/dedup mirror the procedures table. NB: distinct
    -- from the user's own fitness 'goals' — this is imported CLINICAL care. Brand-new
    -- table, every column present at CREATE, inline index upgrade-safe.
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

    -- Care goals — clinical targets from a health record's Goals section (LOINC
    -- 61146-7) or a FHIR Goal resource, plus manual entry. description is the goal
    -- statement; code/code_system its coded identity when present; target_date when
    -- it's aimed to be met; status the lifecycle (proposed / active / achieved / …).
    -- Provenance/dedup mirror the conditions table. NB: DISTINCT from the 'goals'
    -- table (the user's own fitness/body goals) — these are imported clinical goals.
    -- Brand-new table, every column present at CREATE, inline index upgrade-safe.
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

    -- Scheduled medical visits / appointments (issue #213, Phase 2). Forward-
    -- looking, user-entered, and surfaced on the Upcoming page: a 'scheduled' row
    -- whose scheduled_at is in the future/today shows in the appropriate urgency
    -- band, and a past-and-still-scheduled row reads as Overdue. Completing or
    -- cancelling it drops it off Upcoming (status != 'scheduled'). scheduled_at is
    -- a date (YYYY-MM-DD) or datetime; provider_id is an OPTIONAL nullable FK into
    -- the shared, GLOBAL providers registry (the same link immunizations/
    -- medical_records use). This is a brand-new table, so every column is present
    -- at CREATE and the inline index is upgrade-safe (never the #157 add-column-
    -- then-index bug).
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

    -- Async paste/CSV imports awaiting review. An 'Extract' kicks off background
    -- AI extraction (status 'processing'); on completion the parsed preview is
    -- stored in result_json (status 'ready') for the user to review and save, or
    -- an error is recorded ('failed'/'skipped'). The row is deleted once saved or
    -- discarded. Mirrors the medical_documents status pattern.
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- NOTE: idx_intake_items_document is created after the addColumnIfMissing
    -- calls below, not here — on an existing DB this CREATE TABLE is a no-op so
    -- document_id doesn't exist yet at this point (it's added by
    -- addColumnIfMissing), and an inline index here would crash the upgrade.

    CREATE TABLE IF NOT EXISTS intake_item_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplement_id INTEGER NOT NULL REFERENCES intake_items(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      taken_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (supplement_id, date)
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

    -- Per-profile daily AI-operation counters (rate-limiting Fix 1: bound the
    -- per-profile cost of AI-backed document processing / insights). One row per
    -- (profile, local-day, kind); count is incremented BEFORE a Claude call is
    -- dispatched so a logged-in member can't loop uploads/insights into unbounded
    -- API spend. day is the profile's OWN timezone-local date (today(profileId)),
    -- so the cap rolls over at the user's midnight, not UTC's. Directly
    -- profile-owned (born profile_id NOT NULL) -- in OWNED_TABLES, cleared by
    -- profile_id on profile deletion. See lib/ai-usage.ts for the read-increment.
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

    -- Healthcare providers / organizations (issue #178). GLOBAL — shared across
    -- the whole family/instance, modeled like logins/profiles (NOT profile-scoped,
    -- and excluded from the profile-scoping leak test for the same reason). Records
    -- link to a provider via a nullable provider_id FK on their own profile-owned
    -- row. type discriminates an organization from an individual clinician; npi
    -- (US National Provider Identifier) is authoritative for dedup when present,
    -- identifier is any other stable id, phone/address are captured from the CCD
    -- when carried. dedup_key is the pure global key (lib/providers) with a UNIQUE
    -- index, so "resolve or create" (INSERT OR IGNORE) is idempotent and a reimport
    -- never coins a duplicate provider.
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

    -- Authentication & multi-user scaffolding (issue #67). Phase 1 login-gates the
    -- app with a single bootstrap admin login + profile; the profile_id threading
    -- these tables enable is Phases 2-4. logins are login identities (logins were
    -- called accounts in issue #67); profiles are the tracked people. A member
    -- login sees only its granted profiles (login_profiles); admins bypass grants
    -- in code.
    CREATE TABLE IF NOT EXISTS logins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE COLLATE NOCASE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','member')) DEFAULT 'member',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS login_profiles (
      login_id INTEGER NOT NULL REFERENCES logins(id) ON DELETE CASCADE,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      PRIMARY KEY (login_id, profile_id)
    );

    -- The cookie carries a random 256-bit token; token_hash is its SHA-256, so a
    -- DB leak yields no replayable cookie. active_profile_id is the server-side
    -- "which profile am I acting as" for the session.
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      login_id INTEGER NOT NULL REFERENCES logins(id) ON DELETE CASCADE,
      active_profile_id INTEGER REFERENCES profiles(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_login ON sessions(login_id);

    -- Unauthenticated, read-only "medical passport" share links (issue #105). The
    -- URL carries a random 256-bit token; token_hash is its SHA-256 (mirrors the
    -- sessions pattern), so a DB leak yields no usable link. The fields column is
    -- a JSON array of shared section keys (the creator's allow-list). expires_at (ISO
    -- 8601 UTC) makes every link short-lived; revoked_at (ISO 8601 UTC, else NULL)
    -- lets the owner kill it early. Lookups are by token_hash only, then every
    -- downstream read is scoped by the row's profile_id.
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

    -- Failed-login attempts, for the login-throttle (issue #132, Phase A). Global
    -- (NOT profile-scoped — a failed login has no profile), like sessions/logins,
    -- so it's excluded from the profile-scoping leak test. One row per failed or
    -- throttled attempt; username is the lowercased submission (the throttle keys
    -- on it, so a NAT'd family isn't locked out by IP), ip is a coarse backstop.
    -- Rows are cleared on that username's next success and pruned by age at login.
    CREATE TABLE IF NOT EXISTS login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      ip TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_login_attempts_user ON login_attempts(username, created_at);
    CREATE INDEX IF NOT EXISTS idx_login_attempts_created ON login_attempts(created_at);

    -- Per-profile and per-login key/value settings. Created now; the actual
    -- migration of existing settings keys onto them is Phase 2 (do not move keys yet).
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

    -- Per-provider connection state for the Integrations framework. Holds the push
    -- token for Health Connect and OAuth tokens for Strava (Garmin later).
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

    -- Append-only debug history for integration syncs: one row per ingest POST
    -- (Health Connect) or sync run (Strava), so a user can see whether their last
    -- sync arrived, when, what it wrote vs skipped, and any error — none of which
    -- was visible before (failures only reached the SERVER log). Profile-scoped:
    -- the Health Connect ingest is TOKEN-authed (not session-authed), so the row is
    -- tagged with the profile the presented token resolved to. Brand-new full table
    -- (every column present at CREATE), so the migrate-upgrade path is a no-op.
    -- Writing an event is best-effort and MUST NOT change ingest behavior.
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sync_events_profile_provider_at
      ON integration_sync_events(profile_id, provider, at);

    -- One row per ingested record for summable/scalar daily metrics (steps,
    -- distance, calories, HRV). Daily rollups are derived by query, so re-sends of
    -- the same record (the exporter resends a rolling 48h window) are idempotent
    -- via the natural key (metric + source + time window). Point records set
    -- start == end. source is PART of the unique key (#128): two providers can
    -- report the same metric for the same window (e.g. Health Connect and Strava
    -- both covering a workout distance), and each provenance keeps its own row
    -- instead of silently overwriting the other. The daily rollup readers already
    -- keep multiple sources per day (GROUP BY date, source) and de-duplicate one
    -- provider per day in JS, so coexisting per-source rows are the intended shape.
    -- Column order leads with (profile_id, metric) to serve the rollup reads
    -- WHERE profile_id = ? AND metric = ? prefix.
    CREATE TABLE IF NOT EXISTS metric_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      source TEXT NOT NULL,                             -- integration id (provenance)
      metric TEXT NOT NULL,                             -- 'steps','distance_km','active_kcal','total_kcal','hrv_ms'
      date TEXT NOT NULL,                               -- YYYY-MM-DD of start (server-local)
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      value REAL NOT NULL,
      UNIQUE (profile_id, metric, source, start_time, end_time)
    );

    -- Continuous heart-rate samples bucketed to 1-minute averages (a watch can emit
    -- tens of thousands of raw samples/day; ≤1440 minute buckets keeps the intraday
    -- shape tractable). Re-syncs merge by count-weighted average.
    CREATE TABLE IF NOT EXISTS hr_minutes (
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      ts TEXT NOT NULL,                                 -- 'YYYY-MM-DDTHH:MM' (local)
      bpm REAL NOT NULL,                                -- count-weighted average
      bpm_min REAL,
      bpm_max REAL,
      n INTEGER NOT NULL,                               -- samples in bucket (for weighted merge)
      source TEXT,
      PRIMARY KEY (profile_id, ts)
    );

    -- profile_id-scoped composite indexes are created in swapProfileScopedIndexes()
    -- below, after the profile_id column exists on upgraded DBs.
    CREATE INDEX IF NOT EXISTS idx_sets_activity ON exercise_sets(activity_id);
    CREATE INDEX IF NOT EXISTS idx_intake_log_date ON intake_item_logs(date);

    -- Per-item snooze / dismiss for the Upcoming page (issue #213, Phase 3). One
    -- row per (profile, signal): a STABLE signal_key derived by lib/upcoming-
    -- suppress.signalKey (e.g. 'biomarker:ldl', 'appointment:5', 'dose:12'), so a
    -- snooze/dismiss follows the underlying due-signal, not a transient row order.
    -- snooze_until (nullable, 'YYYY-MM-DD') hides the item until that date, then it
    -- reappears; dismissed_at (nullable datetime) hides it indefinitely until the
    -- user restores it (which DELETEs the row). A re-snooze upserts on the unique
    -- (profile_id, signal_key). Brand-new table: every column is present at CREATE
    -- and the inline unique index is upgrade-safe (never the #157 add-then-index
    -- bug). collectUpcoming filters items through these rows; the digest reuses
    -- collectUpcoming, so a suppression applies to the push automatically.
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
  `);

  // First-run auth bootstrap: create the initial admin login + its profile so a
  // fresh (or upgraded, pre-auth) database is usable behind the login gate, and so
  // profile 1 exists before the profile_id backfill/rebuilds below reference it.
  bootstrapAuth(db);

  // Optional profile avatar. photo_path is the on-disk relative path (NULL = no
  // photo); photo_version is bumped on every upload/remove so the <img> URL's
  // ?v= cache-buster changes and a replaced photo shows immediately.
  addColumnIfMissing(db, "profiles", "photo_path", "TEXT");
  addColumnIfMissing(
    db,
    "profiles",
    "photo_version",
    "INTEGER NOT NULL DEFAULT 0"
  );

  // Truncated User-Agent captured at session creation, so the active-sessions
  // view (issue #132, Phase B) can show "which device". Nullable — older sessions
  // and any created without a UA header stay NULL ("Unknown device"). last_used_at
  // (updated at most hourly in getCurrentSession) doubles as the "last seen" time.
  addColumnIfMissing(db, "sessions", "user_agent", "TEXT");

  // Incremental column additions for existing databases.
  addColumnIfMissing(db, "activities", "start_time", "TEXT");
  addColumnIfMissing(db, "activities", "end_time", "TEXT");
  addColumnIfMissing(db, "activities", "components", "TEXT");

  // Provenance + idempotent dedup for integration imports (e.g. Health Connect).
  // Nullable: NULL means a manually-entered row. Exercise sessions have no source
  // record id, so external_id is synthesized as '<source>:<start_time>'.
  addColumnIfMissing(db, "activities", "source", "TEXT");
  addColumnIfMissing(db, "activities", "external_id", "TEXT");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_external ON activities(external_id) WHERE external_id IS NOT NULL;"
  );

  // Richer per-activity metrics carried by pull integrations (Strava). All
  // nullable, so manual entries and Health Connect imports (which don't supply
  // them) are unaffected; the UI renders each only when present. avg/max HR,
  // elevation gain, and avg/max speed apply to any activity; power, cadence, and
  // total work (kilojoules) are populated for cycling only; temperature for any
  // outdoor activity; relative_effort is Strava's suffer score; workout_type is a
  // label (race/long run/workout).
  for (const col of [
    "avg_hr",
    "max_hr",
    "elevation_m",
    "avg_speed_kmh",
    "max_speed_kmh",
    "relative_effort",
    "avg_power_w",
    "max_power_w",
    "weighted_avg_power_w",
    "avg_cadence",
    "avg_temp_c",
    "kilojoules",
  ]) {
    addColumnIfMissing(db, "activities", col, "REAL");
  }
  addColumnIfMissing(db, "activities", "workout_type", "TEXT");
  // Marks a source-owned (integration-imported) activity the user has hand-edited,
  // so re-ingest of the rolling window won't clobber those edits. 0 = untouched.
  addColumnIfMissing(db, "activities", "edited", "INTEGER DEFAULT 0");

  // Real insert/update/unchanged accounting for a sync (issue #273). The original
  // integration_sync_events CREATE only carried the flat `written` count, which
  // can't tell a no-op re-send of the rolling window from a genuine change. These
  // additive columns let each sync record how many rows were brand-new, changed,
  // or unchanged; NULL on legacy rows (the Review feed falls back to `written`).
  addColumnIfMissing(db, "integration_sync_events", "inserted", "INTEGER");
  addColumnIfMissing(db, "integration_sync_events", "updated", "INTEGER");
  addColumnIfMissing(db, "integration_sync_events", "unchanged", "INTEGER");

  // Lets integration ingest keep one imported body-metrics row per day without
  // touching manually-entered rows. (Fresh DBs already have it via CREATE TABLE;
  // this covers DBs upgraded from before the column existed.)
  addColumnIfMissing(db, "body_metrics", "source", "TEXT");

  // Provenance + idempotent dedup for vitals/biomarkers imported from an
  // integration (e.g. Health Connect blood pressure, glucose, SpO2). Nullable:
  // NULL means a manual entry or an AI-extracted document row. external_id is
  // synthesized as '<source>:<canonical>:<time>'.
  addColumnIfMissing(db, "medical_records", "source", "TEXT");
  addColumnIfMissing(db, "medical_records", "external_id", "TEXT");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_medical_external ON medical_records(external_id) WHERE external_id IS NOT NULL;"
  );

  // Idempotent dedup for immunizations imported from an integration / SMART
  // Health Card. NULL for manual and document-extracted rows; set (e.g.
  // 'smart-health-card:<code>:<date>' or 'epic:<Immunization.id>') for synced
  // rows so re-import updates in place instead of duplicating.
  addColumnIfMissing(db, "immunizations", "external_id", "TEXT");

  // Nullable provider_id FK linking a profile-owned row to the shared, GLOBAL
  // providers registry (issue #178). The FK column lives on the profile-owned
  // row (so its statements stay profile-scoped); the providers row it points at
  // is shared across the family. Plain INTEGER (no ON DELETE action) — set/read in
  // code, so it survives ALTER ADD COLUMN on upgraded DBs without a table rebuild.
  addColumnIfMissing(db, "immunizations", "provider_id", "INTEGER");
  addColumnIfMissing(db, "medical_records", "provider_id", "INTEGER");
  addColumnIfMissing(db, "intake_items", "provider_id", "INTEGER");

  // Per-side (asymmetric) loads for unilateral lifts. Nullable: NULL means a
  // normal bilateral set, where weight_kg/reps apply to both sides; when set,
  // weight_kg/reps are the left side and these are the right.
  addColumnIfMissing(db, "exercise_sets", "weight_kg_right", "REAL");
  addColumnIfMissing(db, "exercise_sets", "reps_right", "INTEGER");

  // Hold time for timed exercises (planks, dead hangs), in seconds. Nullable:
  // NULL for rep-based sets; for per-side timed holds, *_right is the right side.
  addColumnIfMissing(db, "exercise_sets", "duration_sec", "INTEGER");
  addColumnIfMissing(db, "exercise_sets", "duration_sec_right", "INTEGER");

  // Declared intent for rep-based sets: the planned rep count, or "to failure"
  // (AMRAP, 1 = true). Missed-target signals compare actual reps against these
  // instead of guessing from rep variance (which false-positives on 5/3/1,
  // drop sets, rep ranges…). Nullable: no intent declared.
  addColumnIfMissing(db, "exercise_sets", "target_reps", "INTEGER");
  addColumnIfMissing(db, "exercise_sets", "to_failure", "INTEGER");

  // User-defined equipment (custom bars/implements the fixed lift enum doesn't
  // cover, e.g. an EZ-curl bar or a trap bar). `weight_kg` is the implement's own
  // weight, kept for reference only — logged set weights are always the TOTAL
  // load, so the bar weight is never added into stored numbers.
  db.exec(`
    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      weight_kg REAL,
      category TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      -- Fresh DBs get profile_id NOT NULL here; upgraded DBs add it nullable via
      -- addColumnIfMissing below. NOT NULL keeps a stray NULL insert from later
      -- making backfillProfileIds resurrect a deliberately deleted profile 1.
      profile_id INTEGER NOT NULL REFERENCES profiles(id)
    );
  `);
  // Drop the abandoned plates-only flag from databases created by an earlier
  // iteration — logged weights are always total, so the flag has no effect.
  dropColumnIfPresent(db, "equipment", "plates_only");

  // Links a logged set to a user-defined equipment row (the implement used).
  // Nullable: NULL means no specific implement is recorded. Plain INTEGER (no FK
  // action) — deleteEquipment() nulls references in code so the column survives
  // ALTER ADD COLUMN on existing databases without a table rebuild.
  addColumnIfMissing(db, "exercise_sets", "equipment_id", "INTEGER");

  // Exercise-linked goals: a goal can target a specific exercise + metric, with
  // progress auto-derived from logged sets. All nullable, so existing freeform
  // goals (target_value/current_value/unit) are unaffected.
  addColumnIfMissing(db, "goals", "exercise", "TEXT");
  addColumnIfMissing(db, "goals", "metric", "TEXT"); // 'weight'|'reps'|'sets'|'hold'
  addColumnIfMissing(db, "goals", "target_weight_kg", "REAL");
  addColumnIfMissing(db, "goals", "target_reps", "INTEGER");
  addColumnIfMissing(db, "goals", "target_sets", "INTEGER");
  addColumnIfMissing(db, "goals", "target_duration_sec", "INTEGER");

  // Body-metric goals: target a body metric (bodyweight / body fat % /
  // resting HR), auto-tracked from body_metrics. `baseline_value` is the metric's
  // value when the goal was created, so progress runs baseline → target (which
  // handles reduction goals like losing weight). target_value holds the target
  // (canonical: kg for weight, % / bpm otherwise). Both nullable.
  addColumnIfMissing(db, "goals", "body_metric", "TEXT"); // 'weight'|'body_fat'|'resting_hr'
  addColumnIfMissing(db, "goals", "baseline_value", "REAL");

  // Archiving is orthogonal to the active/achieved status, so an achieved goal
  // stays achieved when filed away. Migrate any legacy status='archived' rows
  // onto the flag (idempotent — no-op once migrated).
  addColumnIfMissing(db, "goals", "archived", "INTEGER NOT NULL DEFAULT 0");
  db.exec(
    "UPDATE goals SET archived = 1, status = 'active' WHERE status = 'archived'"
  );

  // User-defined weekly frequency targets ("hit X at least N times/week"), where
  // X is a muscle region, a body group (Upper/Lower/Core/Full), or an activity type.
  db.exec(`
    CREATE TABLE IF NOT EXISTS frequency_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('region','group','type')),
      scope_value TEXT NOT NULL,
      per_week INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      -- Fresh DBs get profile_id NOT NULL here; upgraded DBs add it nullable via
      -- addColumnIfMissing below. NOT NULL keeps a stray NULL insert from later
      -- making backfillProfileIds resurrect a deliberately deleted profile 1.
      profile_id INTEGER NOT NULL REFERENCES profiles(id)
    );
  `);

  // Fold legacy lift names into the catalog's variant/canonical names so their
  // history isn't fragmented from the equipment variants.
  migrateLiftMerges(db);

  // Link extracted lab/scan rows back to their source document, plus richer
  // structured fields. All nullable so existing rows + manual entry are unaffected.
  addColumnIfMissing(db, "medical_records", "document_id", "INTEGER");
  addColumnIfMissing(db, "medical_records", "panel", "TEXT");
  addColumnIfMissing(db, "medical_records", "flag", "TEXT");
  addColumnIfMissing(db, "medical_records", "value_num", "REAL");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_medical_document ON medical_records(document_id);"
  );

  // Canonical biomarker name groups readings of the same analyte across labs.
  // Nullable so existing rows + manual entry are unaffected until backfilled.
  addColumnIfMissing(db, "medical_records", "canonical_name", "TEXT");
  // Biomarker lookups compare `canonical_name = ? COLLATE NOCASE` (getBiomarkerSeries,
  // the starred-latest reading), so the index must carry the SAME NOCASE collation
  // on canonical_name or SQLite can't use it and falls back to a full scan per
  // starred biomarker. Include profile_id (the leading equality) and date (the
  // ORDER BY) so the whole predicate is served by the index. There's no migration
  // tool, so drop the old BINARY index and create the NOCASE one under a new name —
  // the rename lets `CREATE INDEX IF NOT EXISTS` skip a rebuild on later boots.
  db.exec("DROP INDEX IF EXISTS idx_medical_canonical;");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_medical_canonical_ci ON medical_records(profile_id, canonical_name COLLATE NOCASE, date);"
  );

  // SHA-256 of the stored file's bytes, so an identical upload is detected and
  // rejected even under a different filename. Nullable: NULL means the row
  // predates this feature or was never stored (e.g. an unsupported/too-large
  // upload). Non-unique index — a re-upload is blocked in code, not by a
  // constraint, so historical duplicates don't break the migration.
  addColumnIfMissing(db, "medical_documents", "content_hash", "TEXT");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_meddoc_hash ON medical_documents(content_hash);"
  );

  // The import DEBUGGER report (issue #208 Phase 2): JSON of dropped candidates +
  // section/resource coverage. Additive/upgrade-safe; an existing DB gets the
  // column here, and reprocessing a document repopulates it.
  addColumnIfMissing(db, "medical_documents", "import_report", "TEXT");
  backfillDocumentHashes(db);

  // Supplement scheduling context, priority, brand/product, and situational
  // support (issue #15). Defaulted/nullable so existing rows are unaffected:
  // every prior supplement becomes a daily, high-priority item.
  addColumnIfMissing(
    db,
    "intake_items",
    "condition",
    "TEXT NOT NULL DEFAULT 'daily'"
  );
  addColumnIfMissing(
    db,
    "intake_items",
    "priority",
    "TEXT NOT NULL DEFAULT 'high'"
  );
  addColumnIfMissing(db, "intake_items", "brand", "TEXT");
  addColumnIfMissing(db, "intake_items", "product", "TEXT");
  addColumnIfMissing(db, "intake_items", "situation", "TEXT");
  addColumnIfMissing(db, "intake_items", "stack", "TEXT");
  // Missed-dose escalation (issue #103 Phase A). Defaulted/nullable so existing
  // supplements are non-critical with no escalation until the user opts in.
  addColumnIfMissing(
    db,
    "intake_items",
    "critical",
    "INTEGER NOT NULL DEFAULT 0"
  );
  addColumnIfMissing(db, "intake_items", "escalate_after_min", "INTEGER");
  addColumnIfMissing(db, "intake_items", "escalate_chat_id", "TEXT");
  // Refill tracking (issue #103 Phase B). quantity_on_hand NULL = untracked;
  // qty_per_dose defaults to 1 unit/dose. Existing rows stay untracked.
  addColumnIfMissing(db, "intake_items", "quantity_on_hand", "REAL");
  addColumnIfMissing(
    db,
    "intake_items",
    "qty_per_dose",
    "REAL NOT NULL DEFAULT 1"
  );
  // Medication identity (issue #103 Phase C). kind defaults to 'supplement' so
  // every existing row stays a supplement; the rest are medication-only.
  addColumnIfMissing(
    db,
    "intake_items",
    "kind",
    "TEXT NOT NULL DEFAULT 'supplement'"
  );
  addColumnIfMissing(db, "intake_items", "prescriber", "TEXT");
  addColumnIfMissing(db, "intake_items", "pharmacy", "TEXT");
  addColumnIfMissing(db, "intake_items", "rx_number", "TEXT");
  addColumnIfMissing(
    db,
    "intake_items",
    "as_needed",
    "INTEGER NOT NULL DEFAULT 0"
  );
  // Provenance (issue #150). document_id/source trace an auto-structured
  // medication back to the prescription document it came from; NULL for the
  // manual and legacy rows, so existing supplements/medications are unaffected.
  addColumnIfMissing(db, "intake_items", "document_id", "INTEGER");
  addColumnIfMissing(db, "intake_items", "source", "TEXT");
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_intake_items_document
       ON intake_items(profile_id, document_id)`
  );
  // `frequency` was a free-text, display-only field superseded by `condition` +
  // `time_of_day`; drop it from older databases.
  dropColumnIfPresent(db, "intake_items", "frequency");
  // Multi-dose model: per-intake amount/time/food, plus pair relationships. Runs
  // after the intake_item_suggestions table exists (created below) — see call site.

  db.exec(`
    -- AI-proposed supplements awaiting user review (mirrors the medical_documents
    -- status pattern). Accepted rows are copied into intake_items; the row records
    -- why it was suggested and what triggered it.
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
      -- Fresh DBs get profile_id NOT NULL here; upgraded DBs add it nullable via
      -- addColumnIfMissing below. NOT NULL keeps a stray NULL insert from later
      -- making backfillProfileIds resurrect a deliberately deleted profile 1.
      profile_id INTEGER NOT NULL REFERENCES profiles(id)
    );
    CREATE INDEX IF NOT EXISTS idx_intake_sugg_status ON intake_item_suggestions(status);
  `);
  addColumnIfMissing(
    db,
    "intake_item_suggestions",
    "food_timing",
    "TEXT NOT NULL DEFAULT 'any'"
  );

  migrateSupplementDoses(db);

  // Medication history / lifecycle (issue #209, Phase 1): the course + side-effect
  // child tables of intake_items, plus the idempotent backfill of one initial
  // course per existing medication. Runs after intake_items + its kind column
  // exist (above).
  migrateMedicationHistory(db);

  // The public URL setting was Telegram-specific before being shared with the
  // other integrations; move a stored value to the new key and drop the old one.
  db.exec(`
    INSERT INTO settings (key, value)
      SELECT 'public_url', value FROM settings WHERE key = 'telegram_public_url'
      ON CONFLICT(key) DO NOTHING;
    DELETE FROM settings WHERE key = 'telegram_public_url';
  `);

  db.exec(`
    -- Biomarkers the user has pinned. NOCASE so a star can't fork on casing and
    -- matches the case-insensitive grouping used everywhere else.
    CREATE TABLE IF NOT EXISTS starred_biomarkers (
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      canonical_name TEXT NOT NULL COLLATE NOCASE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (profile_id, canonical_name)
    );

    -- Controlled vocabulary + reference/optimal ranges. Seeded from the committed
    -- lib/canonical-biomarkers.json (source 'seed'); AI-discovered names are added
    -- later with source 'ai' and null ranges. 'source' is never user free-text.
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

  // Sex-specific optimal bands, for canonical_biomarkers tables created before
  // these columns existed. (Fresh tables already have them via CREATE TABLE.)
  ensureCanonicalSexColumns(db);
  // Sex-specific reference ranges, likewise added to older tables.
  ensureCanonicalSexRefColumns(db);
  // Age-banded ranges (ranges_by_age), likewise added to older tables.
  ensureCanonicalAgeColumn(db);
  // Reproductive-status ranges (ranges_by_status), likewise added to older tables.
  ensureCanonicalStatusColumn(db);

  seedCanonicalBiomarkers(db);

  // Multi-user (issue #67, Phase 2): thread a profile_id onto every per-profile
  // table. Runs here, after every per-profile table exists (equipment,
  // frequency_targets, intake_item_suggestions, starred_biomarkers are created
  // above) and after bootstrapAuth() has ensured profile 1 exists. Fresh DBs are
  // born with the column NOT NULL (see the CREATE blocks); upgraded DBs get a
  // nullable column added here, then backfilled to profile 1, with non-null
  // enforced in code. Order: add columns → ensure profile 1 → backfill → rebuild
  // the tables whose primary/unique keys must gain profile_id → swap indexes.
  // The set is BACKFILL_OWNED_TABLES (the shared owned-table source of truth): the
  // pre-#67 tables that get profile_id as a nullable addColumnIfMissing column.
  for (const t of BACKFILL_OWNED_TABLES) {
    addColumnIfMissing(db, t, "profile_id", "INTEGER REFERENCES profiles(id)");
  }
  backfillProfileIds(db);
  rebuildForProfileScoping(db);
  // Add `source` to the metric_samples unique key (#128) for DBs already migrated
  // to the profile_id shape but predating the source-in-key change. Runs BEFORE
  // swapProfileScopedIndexes so the non-unique idx_metric_samples_md is recreated
  // on the rebuilt table. No-op on fresh DBs (born with the source key) and on
  // pre-#67 DBs (rebuildForProfileScoping already produced the source key).
  rebuildMetricSamplesSourceKey(db);
  // Drop the legacy NOT NULL on body_metrics.weight_kg (#120). Runs after
  // profile_id + source exist, and before swapProfileScopedIndexes recreates the
  // index the rebuild drops with the table.
  relaxBodyMetricsWeightKg(db);
  swapProfileScopedIndexes(db);

  // Fold integration-imported body fat / resting HR out of metric_samples and into
  // body_metrics (#120), so every source of these two metrics shares one home.
  migrateBodyMetricSamplesIntoBodyMetrics(db);

  // Split the flat settings table into the per-profile / per-login tiers.
  migrateMultiUserSettings(db);

  // Move birthdate/age (properties of the tracked person) to profile 1.
  migrateProfileBirthdate(db);

  // One-time legacy backfill: pre-value_num manual rows whose `value` is a plain
  // number become chartable. Numeric-only strings only; idempotent.
  db.exec(
    `UPDATE medical_records SET value_num = CAST(value AS REAL)
       WHERE value_num IS NULL AND value GLOB '[0-9]*' AND value NOT GLOB '*[^0-9.]*'`
  );

  // Re-derive every record's flag against the canonical ranges, but only when
  // those ranges (or the flag-derivation logic) have actually changed since the
  // last run — so editing lib/canonical-biomarkers.json propagates to existing
  // records on the next boot, without a full re-scan on every startup.
  reconcileFlagsIfCanonicalChanged(db);

  // Background extraction runs in-process. A fresh process can't have any
  // extraction in flight, so any doc left mid-extraction was interrupted by a
  // restart/crash — mark it failed rather than leaving it stuck on 'processing'.
  db.exec(
    `UPDATE medical_documents
       SET extraction_status = 'failed',
           extraction_error = 'Extraction was interrupted (server restarted). Delete and re-upload to retry.'
     WHERE extraction_status IN ('processing','pending')`
  );

  // Same for async paste/CSV import jobs left mid-extraction by a restart/crash:
  // mark them failed rather than leaving them stuck spinning on 'processing'.
  db.exec(
    `UPDATE import_jobs
       SET status = 'failed',
           error = 'Extraction was interrupted (server restarted). Discard and try again.',
           updated_at = datetime('now')
     WHERE status = 'processing'`
  );

  // One-time bootstrap: timezone moved from the `TZ` env into a DB setting. If no
  // timezone is stored yet but a TZ env is present and valid, seed the setting from
  // it so upgrading deploys keep their zone instead of snapping to UTC. This reads
  // the env once on first boot only — it is NOT an ongoing fallback.
  seedTimezoneFromEnv(db);
}

// One-time split of the flat settings table into per-profile / per-login tiers
// (issue #67, Phase 2). Per-profile keys (sex, timezone, notification schedule,
// telegram delivery target, active situations, the notify_last_* dedup markers)
// move to profile_settings for profile 1; the unit display prefs move to
// login_settings for login 1. Global keys (bot token, webhook secret,
// transport mode, public url, ai_auto_*, birthdate/age, migration flags,
// canonical_flags_sig) stay in settings. The timezone is COPIED, not moved, so
// the original stays behind as the instance default for future profiles. Guarded
// by a settings flag so it runs exactly once and never re-migrates keys written
// afterward. Mirrors the migrateLiftMerges flag pattern.
function migrateMultiUserSettings(db: Database.Database) {
  const FLAG = "multi_user_settings_v1";
  const done = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(FLAG) as { value?: string } | undefined;
  if (done) return;

  const PROFILE_KEYS = [
    "sex",
    "timezone",
    "active_situations",
    "telegram_enabled",
    "telegram_chat_id",
    "notify_supp_morning_hour",
    "notify_supp_midday_hour",
    "notify_supp_evening_hour",
    "notify_supp_bedtime_hour",
    "notify_workout_enabled",
  ];
  const LOGIN_KEYS = ["weight_unit", "distance_unit"];
  // timezone is the instance default for new profiles, so it stays in settings.
  const KEEP_GLOBAL = new Set(["timezone"]);

  const get = db.prepare("SELECT value FROM settings WHERE key = ?");
  const listLike = db.prepare(
    "SELECT key, value FROM settings WHERE key LIKE 'notify_last_%'"
  );
  const toProfile = db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (1, ?, ?)
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  );
  const toLogin = db.prepare(
    `INSERT INTO login_settings (login_id, key, value) VALUES (1, ?, ?)
     ON CONFLICT(login_id, key) DO UPDATE SET value = excluded.value`
  );
  const del = db.prepare("DELETE FROM settings WHERE key = ?");

  const run = db.transaction(() => {
    const move = (
      key: string,
      value: string,
      dest: typeof toProfile | typeof toLogin
    ) => {
      dest.run(key, value);
      if (!KEEP_GLOBAL.has(key)) del.run(key);
    };
    for (const key of PROFILE_KEYS) {
      const row = get.get(key) as { value?: string } | undefined;
      if (row?.value !== undefined) move(key, row.value, toProfile);
    }
    for (const row of listLike.all() as { key: string; value: string }[]) {
      move(row.key, row.value, toProfile);
    }
    for (const key of LOGIN_KEYS) {
      const row = get.get(key) as { value?: string } | undefined;
      if (row?.value !== undefined) move(key, row.value, toLogin);
    }
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')"
    ).run(FLAG);
  });
  run();
}

// Move the user's birthdate/age from the global settings table to profile 1's
// profile_settings (issue #67 follow-up). These are properties of the tracked
// person, not the instance. Runs after migrateMultiUserSettings (which left them
// global) and exactly once, guarded by its own flag; keys written to a profile
// afterward are never re-migrated. Mirrors migrateMultiUserSettings's pattern.
function migrateProfileBirthdate(db: Database.Database) {
  const FLAG = "profile_birthdate_v1";
  const done = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(FLAG) as { value?: string } | undefined;
  if (done) return;

  const get = db.prepare("SELECT value FROM settings WHERE key = ?");
  const toProfile = db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (1, ?, ?)
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  );
  const del = db.prepare("DELETE FROM settings WHERE key = ?");

  const run = db.transaction(() => {
    for (const key of ["birthdate", "age"]) {
      const row = get.get(key) as { value?: string } | undefined;
      if (row?.value !== undefined) {
        toProfile.run(key, row.value);
        del.run(key);
      }
    }
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')"
    ).run(FLAG);
  });
  run();
}

// One-time (#120 follow-up): body fat % and resting HR imported from an integration
// used to land in metric_samples, while manual/document readings of the same two
// metrics went to body_metrics — splitting one metric across two tables, so goals
// and getLatestBodyMetric (which read body_metrics) missed the imported values. Now
// that body_metrics.weight_kg is nullable both share that table. Fold any existing
// metric_samples rows for these two metrics into body_metrics, daily-averaged and
// keyed by (profile, date, source): an existing body_metrics value wins (COALESCE
// fills only gaps), a matching same-source row is updated in place, else a new
// (weightless) row is inserted. Then drop the folded rows from metric_samples.
// Guarded by a settings flag so it runs exactly once.
function migrateBodyMetricSamplesIntoBodyMetrics(db: Database.Database) {
  const FLAG = "body_metric_samples_merged_v1";
  const done = db.prepare("SELECT value FROM settings WHERE key = ?").get(FLAG);
  if (done) return;

  // The metric_samples metrics that are really body_metrics columns. One list
  // drives both the fold loop and the cleanup DELETE, so they can't drift.
  const METRICS = ["body_fat_pct", "resting_hr"] as const;
  const isDone = () =>
    !!db.prepare("SELECT value FROM settings WHERE key = ?").get(FLAG);

  const run = db.transaction(() => {
    // Re-check inside the txn: a parallel `next build` worker may have folded
    // already (the flag is committed atomically with the fold + DELETE), so a
    // loser no-ops rather than re-handling.
    if (isDone()) return;
    for (const column of METRICS) {
      const agg = db
        .prepare(
          "SELECT profile_id, date, source, AVG(value) AS v FROM metric_samples WHERE metric = ? GROUP BY profile_id, date, source"
        )
        .all(column) as {
        profile_id: number;
        date: string;
        source: string | null;
        v: number;
      }[];
      // The existing row's value for this column, so foldSampleIntoRow can decide
      // precedence (existing manual/document value wins over the folded sample).
      const find = db.prepare(
        `SELECT id, ${column} AS cur FROM body_metrics WHERE profile_id = ? AND date = ? AND source IS ? LIMIT 1`
      );
      const insert = db.prepare(
        `INSERT INTO body_metrics (profile_id, date, ${column}, source) VALUES (?, ?, ?, ?)`
      );
      const update = db.prepare(
        `UPDATE body_metrics SET ${column} = ? WHERE id = ? AND profile_id = ?`
      );
      for (const r of agg) {
        const value = roundBodyMetric(column, r.v);
        const mine = find.get(r.profile_id, r.date, r.source) as
          { id: number; cur: number | null } | undefined;
        if (mine)
          update.run(foldSampleIntoRow(mine.cur, value), mine.id, r.profile_id);
        else insert.run(r.profile_id, r.date, value, r.source);
      }
    }
    db.exec(
      `DELETE FROM metric_samples WHERE metric IN (${METRICS.map(
        (m) => `'${m}'`
      ).join(", ")})`
    );
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')"
    ).run(FLAG);
  });

  // IMMEDIATE takes the write lock at BEGIN, so there's no deferred read-snapshot
  // to upgrade (which would throw SQLITE_BUSY_SNAPSHOT under a concurrent writer,
  // uncovered by busy_timeout). busy_timeout waits out a competing worker; the
  // retry loop is the final backstop, and the in-txn isDone() re-check makes a
  // won race a clean no-op — matching rebuildTable's pattern.
  for (let attempt = 0; ; attempt++) {
    try {
      run.immediate();
      return;
    } catch (err) {
      if (isDone()) return;
      if (attempt < 5 && /SQLITE_BUSY/i.test(String(err))) continue;
      throw err;
    }
  }
}

// If no logins exist yet, create login 1 (admin) and profile 1, wired
// together with a grant row. The password comes from ADMIN_PASSWORD, or a random
// one printed to the log exactly once so the operator can capture it. Username
// from ADMIN_USERNAME (default "admin"). Runs inside migrate(), so it also
// upgrades an existing pre-auth database on its next boot.
function bootstrapAuth(db: Database.Database) {
  const count = (
    db.prepare("SELECT COUNT(*) AS c FROM logins").get() as { c: number }
  ).c;
  if (count > 0) return;

  const username = (process.env.ADMIN_USERNAME ?? "admin").trim() || "admin";
  const envPassword = process.env.ADMIN_PASSWORD;
  // A URL-safe random password when none is supplied. Printed once below.
  const password =
    envPassword && envPassword.length > 0
      ? envPassword
      : crypto.randomBytes(18).toString("base64url");
  const passwordHash = hashPasswordSync(password);

  const create = db.transaction(() => {
    const acct = db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, ?, 'admin')"
      )
      .run(username, passwordHash);
    const prof = db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run(username);
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id) VALUES (?, ?)"
    ).run(acct.lastInsertRowid, prof.lastInsertRowid);
  });
  try {
    create();
  } catch (err) {
    // `next build` collects page data with several workers, each running
    // migrate() against the same DB at once; two can both see logins empty and
    // race to bootstrap. Swallow the loser's UNIQUE violation — the admin now
    // exists, which is all we need. Re-throw anything else.
    if (
      err instanceof Error &&
      /UNIQUE constraint failed: logins\.username/i.test(err.message)
    ) {
      return;
    }
    throw err;
  }

  if (!envPassword) {
    // eslint-disable-next-line no-console
    console.log(
      `\n[allos] Created admin login "${username}" with a generated password:\n` +
        `    ${password}\n` +
        `Set ADMIN_PASSWORD to choose your own. This is shown once — save it now.\n`
    );
  }
}

// See migrate(): seed the timezone setting from the TZ env on first boot.
function seedTimezoneFromEnv(db: Database.Database) {
  const existing = db
    .prepare("SELECT value FROM settings WHERE key = 'timezone'")
    .get() as { value?: string } | undefined;
  if (existing?.value) return;
  const tz = process.env.TZ;
  if (!tz) return;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  } catch {
    return; // invalid TZ env — leave unset so getTimezone() falls back to UTC
  }
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('timezone', ?)
     ON CONFLICT(key) DO NOTHING`
  ).run(tz);
}

// Add the sex-specific optimal columns to an older canonical_biomarkers table.
// SQLite refuses ALTER TABLE ADD COLUMN on a table that has a column with a
// non-constant default (here, created_at DEFAULT (datetime('now'))), so the only
// way to add them is to rebuild the table and copy the existing rows over.
function ensureCanonicalSexColumns(db: Database.Database) {
  const cols = db.prepare("PRAGMA table_info(canonical_biomarkers)").all() as {
    name: string;
  }[];
  if (cols.some((c) => c.name === "optimal_low_male")) return; // already migrated

  // Rebuild atomically so a crash mid-migration can't brick boot: DROP any stale
  // _new table from a prior aborted attempt, then do the create/copy/swap inside a
  // single transaction (all-or-nothing).
  db.exec("DROP TABLE IF EXISTS canonical_biomarkers_new");
  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE canonical_biomarkers_new (
        name TEXT PRIMARY KEY COLLATE NOCASE,
        category TEXT,
        unit TEXT,
        ref_low REAL, ref_high REAL,
        optimal_low REAL, optimal_high REAL,
        optimal_low_male REAL, optimal_high_male REAL,
        optimal_low_female REAL, optimal_high_female REAL,
        direction TEXT,
        note TEXT,
        source TEXT NOT NULL DEFAULT 'ai',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO canonical_biomarkers_new
        (name, category, unit, ref_low, ref_high, optimal_low, optimal_high,
         direction, note, source, created_at)
        SELECT name, category, unit, ref_low, ref_high, optimal_low, optimal_high,
               direction, note, source, created_at
        FROM canonical_biomarkers;
      DROP TABLE canonical_biomarkers;
      ALTER TABLE canonical_biomarkers_new RENAME TO canonical_biomarkers;
    `);
  });
  rebuild();
}

// Add the sex-specific reference-range columns to an older canonical_biomarkers
// table. These take a constant (NULL) default, so a plain ALTER ADD COLUMN works
// even alongside created_at's non-constant default — no table rebuild needed.
function ensureCanonicalSexRefColumns(db: Database.Database) {
  const cols = db.prepare("PRAGMA table_info(canonical_biomarkers)").all() as {
    name: string;
  }[];
  const have = new Set(cols.map((c) => c.name));
  for (const col of [
    "ref_low_male",
    "ref_high_male",
    "ref_low_female",
    "ref_high_female",
  ]) {
    if (!have.has(col))
      db.exec(`ALTER TABLE canonical_biomarkers ADD COLUMN ${col} REAL`);
  }
}

// Add the age-banded ranges column (JSON text) to an older canonical_biomarkers
// table. Constant (NULL) default, so a plain ALTER ADD COLUMN works.
function ensureCanonicalAgeColumn(db: Database.Database) {
  const cols = db.prepare("PRAGMA table_info(canonical_biomarkers)").all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "ranges_by_age"))
    db.exec("ALTER TABLE canonical_biomarkers ADD COLUMN ranges_by_age TEXT");
}

// Add the reproductive-status ranges column (JSON text) to an older
// canonical_biomarkers table. Constant (NULL) default, so a plain ALTER works.
function ensureCanonicalStatusColumn(db: Database.Database) {
  const cols = db.prepare("PRAGMA table_info(canonical_biomarkers)").all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "ranges_by_status"))
    db.exec(
      "ALTER TABLE canonical_biomarkers ADD COLUMN ranges_by_status TEXT"
    );
}

// Seed the canonical_biomarkers table from the committed JSON dataset. The JSON
// is the source of truth for any name it lists, so this UPSERTs: a missing row is
// inserted, and an existing row is refreshed to match the JSON (so edits to
// ranges — including the sex-specific bands — propagate to existing DBs on
// startup). A name present in the JSON also promotes the row to source='seed',
// so a biomarker first discovered by AI (source='ai') adopts curated ranges
// once the JSON gains an entry for it. Idempotent.
function seedCanonicalBiomarkers(db: Database.Database) {
  const rows = (canonicalSeed as { biomarkers?: any[] }).biomarkers ?? [];
  if (rows.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO canonical_biomarkers
       (name, category, unit, ref_low, ref_high,
        ref_low_male, ref_high_male, ref_low_female, ref_high_female,
        optimal_low, optimal_high,
        optimal_low_male, optimal_high_male, optimal_low_female, optimal_high_female,
        direction, ranges_by_age, ranges_by_status, note, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'seed')
     ON CONFLICT(name) DO UPDATE SET
       category = excluded.category, unit = excluded.unit,
       ref_low = excluded.ref_low, ref_high = excluded.ref_high,
       ref_low_male = excluded.ref_low_male,
       ref_high_male = excluded.ref_high_male,
       ref_low_female = excluded.ref_low_female,
       ref_high_female = excluded.ref_high_female,
       optimal_low = excluded.optimal_low, optimal_high = excluded.optimal_high,
       optimal_low_male = excluded.optimal_low_male,
       optimal_high_male = excluded.optimal_high_male,
       optimal_low_female = excluded.optimal_low_female,
       optimal_high_female = excluded.optimal_high_female,
       direction = excluded.direction,
       ranges_by_age = excluded.ranges_by_age,
       ranges_by_status = excluded.ranges_by_status,
       note = excluded.note,
       source = 'seed'`
  );
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const str = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  // Age bands are stored as a JSON array; null when absent so the adult fields win.
  const ageBands = (v: unknown) =>
    Array.isArray(v) && v.length > 0 ? JSON.stringify(v) : null;
  // Reproductive-status ranges are stored as a JSON object; null when absent.
  const statusRanges = (v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0
      ? JSON.stringify(v)
      : null;
  const seedAll = db.transaction(() => {
    for (const b of rows) {
      const name = str(b?.name);
      if (!name) continue;
      insert.run(
        name,
        str(b?.category),
        str(b?.unit),
        num(b?.ref_low),
        num(b?.ref_high),
        num(b?.ref_low_male),
        num(b?.ref_high_male),
        num(b?.ref_low_female),
        num(b?.ref_high_female),
        num(b?.optimal_low),
        num(b?.optimal_high),
        num(b?.optimal_low_male),
        num(b?.optimal_high_male),
        num(b?.optimal_low_female),
        num(b?.optimal_high_female),
        str(b?.direction),
        ageBands(b?.ranges_by_age),
        statusRanges(b?.ranges_by_status),
        str(b?.note)
      );
    }
  });
  seedAll();
}

// Flag-reconcile migration: re-derive every record's flag against the canonical
// ranges, but only when the ranges (or the flag-derivation logic) changed since
// the last run. The current signature is compared against the one stored in
// settings; equal means nothing relevant changed, so we skip the full scan.
// After reconciling, the new signature is recorded so it runs once per change.
// (An existing DB with no stored signature always reconciles once on first boot.)
function reconcileFlagsIfCanonicalChanged(db: Database.Database) {
  const sig = canonicalFlagsSignature();
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'canonical_flags_sig'")
    .get() as { value?: string } | undefined;
  if (row?.value === sig) return; // ranges + logic unchanged — nothing to do
  reconcileNonOptimalFlags(db);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('canonical_flags_sig', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(sig);
}

// Reconcile every record's flag against the canonical reference + optimal ranges
// (clinical high/low from the reference range, non-optimal from the optimal band,
// cleared when optimal). Mirrors queries.reconcileFlags but runs at migrate time,
// where importing queries would be circular — it reads the canonical ranges
// straight from the table.
function reconcileNonOptimalFlags(db: Database.Database) {
  const cbs = db
    .prepare(
      `SELECT name, unit, ref_low, ref_high,
              ref_low_male, ref_high_male, ref_low_female, ref_high_female,
              optimal_low, optimal_high,
              optimal_low_male, optimal_high_male, optimal_low_female, optimal_high_female,
              direction, ranges_by_age, ranges_by_status
       FROM canonical_biomarkers`
    )
    .all() as Record<string, unknown>[];
  const byName = new Map(cbs.map((c) => [String(c.name).toLowerCase(), c]));

  // Flags depend on the profile's sex (sex-specific bands) and, for age-banded
  // biomarkers, the subject's age on each record's collection date. Both are
  // per-profile, so this loops profiles: each profile's sex/birthdate/age live in
  // profile_settings (issue #67, Phase 2) and records are scoped by profile_id.
  // Read them inline (importing lib/settings here would be circular), falling back
  // to legacy global settings for a DB migrated before the settings split ran.
  const profiles = db.prepare("SELECT id FROM profiles").all() as {
    id: number;
  }[];
  const profileSetting = db.prepare(
    "SELECT value FROM profile_settings WHERE profile_id = ? AND key = ?"
  );
  const globalSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
  const readProfileOrLegacy = (profileId: number, key: string) => {
    const row = profileSetting.get(profileId, key) as
      { value?: string } | undefined;
    if (row) return row.value;
    return (globalSetting.get(key) as { value?: string } | undefined)?.value;
  };
  const readSex = (profileId: number) => {
    const v = readProfileOrLegacy(profileId, "sex");
    return v === "male" ? "male" : v === "female" ? "female" : undefined;
  };
  const readBirthdate = (profileId: number) =>
    readProfileOrLegacy(profileId, "birthdate") ?? null;
  const readAge = (profileId: number) => {
    const v = readProfileOrLegacy(profileId, "age");
    const n = v != null ? Number(v) : NaN;
    return Number.isInteger(n) && n > 0 && n < 150 ? n : null;
  };
  // Reproductive (menopausal) status: female physiology only, overrides the age
  // proxy for the reproductive hormones. Per-profile; no legacy global fallback.
  const readReproductiveStatus = (profileId: number) => {
    const v = profileSetting.get(profileId, "reproductive_status") as
      { value?: string } | undefined;
    return v?.value === "premenopausal"
      ? "premenopausal"
      : v?.value === "postmenopausal"
        ? "postmenopausal"
        : null;
  };

  const rowsStmt = db.prepare(
    `SELECT id, value_num, unit, canonical_name, flag, date FROM medical_records
       WHERE profile_id = ? AND canonical_name IS NOT NULL AND value_num IS NOT NULL
         AND (flag IS NULL OR flag IN ('normal','non-optimal','non-optimal-high','non-optimal-low','high','low'))`
  );
  const setFlag = db.prepare(
    "UPDATE medical_records SET flag = ? WHERE id = ?"
  );
  const clear = db.prepare(
    "UPDATE medical_records SET flag = NULL WHERE id = ?"
  );
  const run = db.transaction(() => {
    for (const p of profiles) {
      const sex = readSex(p.id);
      const birthdate = readBirthdate(p.id);
      const age = readAge(p.id);
      const reproductiveStatus = readReproductiveStatus(p.id);
      const rows = rowsStmt.all(p.id) as {
        id: number;
        value_num: number;
        unit: string | null;
        canonical_name: string;
        flag: string | null;
        date: string;
      }[];
      // Same pure per-row derivation queries.reconcileFlags uses, so the boot-time
      // reconcile and the request-time one can't drift (lib/flag-reconcile). Age is
      // derived per row from birthdate + the record's own date (age on the
      // collection date, not today).
      for (const c of computeFlagReconciliation(rows, byName, {
        sex,
        birthdate,
        age,
        reproductiveStatus,
      })) {
        if (c.flag === null) clear.run(c.id);
        else setFlag.run(c.flag, c.id);
      }
    }
  });
  run();
}

// One-time backfill of content_hash for documents stored before the dedup
// feature existed, so a re-upload of an older file is still caught. Hashes each
// stored file on disk; missing/unreadable files are skipped (left NULL). Guarded
// to only touch rows lacking a hash, so it's a no-op once every doc is hashed.
function backfillDocumentHashes(db: Database.Database) {
  const rows = db
    .prepare(
      "SELECT id, stored_path FROM medical_documents WHERE content_hash IS NULL AND stored_path IS NOT NULL AND stored_path != ''"
    )
    .all() as { id: number; stored_path: string }[];
  if (rows.length === 0) return;
  const setHash = db.prepare(
    "UPDATE medical_documents SET content_hash = ? WHERE id = ?"
  );
  for (const r of rows) {
    try {
      const buf = fs.readFileSync(path.join(process.cwd(), r.stored_path));
      setHash.run(crypto.createHash("sha256").update(buf).digest("hex"), r.id);
    } catch {
      // File missing/unreadable — leave the hash NULL and move on.
    }
  }
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  type: string
) {
  // Record the ask on every call (added or not) so tests can enumerate the
  // additive-upgrade surface. Observational only — does not affect the ALTER.
  ADDITIVE_COLUMNS.push({ table, column });
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === column)) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch (err) {
      // `next build` collects page data with several workers, each opening the DB
      // and running migrate() at once; two can both see the column missing and
      // race to add it. Swallow the loser's "duplicate column name" — the column
      // now exists, which is all we need. Re-throw anything else.
      if (!/duplicate column name/i.test(String(err))) throw err;
    }
  }
}

function dropColumnIfPresent(
  db: Database.Database,
  table: string,
  column: string
) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (cols.some((c) => c.name === column)) {
    try {
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    } catch (err) {
      // `next build` runs migrate() in several workers at once; two can both see
      // the column present and race to drop it. Swallow the loser's "no such
      // column" — the column is gone, which is all we need. Re-throw anything else.
      if (!/no such column/i.test(String(err))) throw err;
    }
  }
}

// One-time rename of legacy/duplicate lift names to the catalog's canonical
// names, so prior history merges with the equipment-variant model instead of
// living under an orphaned name. Renames both exercise_sets.exercise and the
// strength component names embedded in activities.components (JSON). Guarded by
// a settings flag so it runs once and never rewrites names logged afterwards.
function migrateLiftMerges(db: Database.Database) {
  // Bump the version suffix whenever RENAMES gains an entry so it re-runs on
  // existing databases; the prior renames are idempotent (nothing matches the
  // old name once merged), so re-running the whole list is harmless.
  const FLAG = "lift_merge_v2";
  const done = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(FLAG) as { value?: string } | undefined;
  if (done) return;

  // [from, to]
  const RENAMES: [string, string][] = [
    ["Bench Press", "Barbell Bench Press"],
    ["Overhead Press", "Barbell Overhead Press"],
    ["Squat", "Back Squat"],
    ["Bicep Curl", "Dumbbell Curl"],
    // Rear Delt Fly became a Dumbbell/Cable variant group; fold historical
    // bare rows into the cable variant so they don't read as a variant with no
    // equipment picked (which would flag them as unsaveable in the journal).
    ["Rear Delt Fly", "Cable Rear Delt Fly"],
  ];
  const renameMap = new Map(RENAMES);

  const updSet = db.prepare(
    "UPDATE exercise_sets SET exercise = ? WHERE exercise = ?"
  );
  const acts = db
    .prepare(
      "SELECT id, components FROM activities WHERE components IS NOT NULL"
    )
    .all() as { id: number; components: string }[];
  const updComp = db.prepare(
    "UPDATE activities SET components = ? WHERE id = ?"
  );

  const run = db.transaction(() => {
    for (const [from, to] of RENAMES) updSet.run(to, from);
    for (const a of acts) {
      let comps: { name?: string }[];
      try {
        comps = JSON.parse(a.components);
      } catch {
        continue;
      }
      let changed = false;
      for (const c of comps) {
        const to = c.name ? renameMap.get(c.name) : undefined;
        if (to) {
          c.name = to;
          changed = true;
        }
      }
      if (changed) updComp.run(JSON.stringify(comps), a.id);
    }
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')"
    ).run(FLAG);
  });
  run();
}

// Move per-intake fields (amount/time/food) off supplements into a child table
// so a supplement can have multiple scheduled doses, and re-key intake_item_logs
// on the dose. Also creates the intake_item_pairs table. Idempotent.
function migrateSupplementDoses(db: Database.Database) {
  db.exec(`
    -- One scheduled intake of a supplement (amount + time + food relationship).
    CREATE TABLE IF NOT EXISTS intake_item_doses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplement_id INTEGER NOT NULL REFERENCES intake_items(id) ON DELETE CASCADE,
      amount TEXT,
      time_of_day TEXT,
      food_timing TEXT NOT NULL DEFAULT 'any',
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_intake_doses_item ON intake_item_doses(supplement_id);

    -- "Take together" / "keep apart" relationships between two supplements.
    CREATE TABLE IF NOT EXISTS intake_item_pairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      a_id INTEGER NOT NULL REFERENCES intake_items(id) ON DELETE CASCADE,
      b_id INTEGER NOT NULL REFERENCES intake_items(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'separate' CHECK (relation IN ('with','separate')),
      note TEXT,
      UNIQUE (a_id, b_id, relation)
    );
  `);

  // One-time backfill: turn each legacy supplement's (dosage, time_of_day) into a
  // single dose, then drop those columns. Guarded so it only runs while the
  // legacy columns still exist.
  const suppCols = tableColumns(db, "intake_items");
  const hasLegacy =
    suppCols.includes("dosage") || suppCols.includes("time_of_day");
  if (hasLegacy) {
    const dosageSel = suppCols.includes("dosage") ? "dosage" : "NULL AS dosage";
    const timeSel = suppCols.includes("time_of_day")
      ? "time_of_day"
      : "NULL AS time_of_day";
    const rows = db
      .prepare(`SELECT id, ${dosageSel}, ${timeSel} FROM intake_items`)
      .all() as {
      id: number;
      dosage: string | null;
      time_of_day: string | null;
    }[];
    const countDose = db.prepare(
      "SELECT COUNT(*) AS c FROM intake_item_doses WHERE supplement_id = ?"
    );
    const insertDose = db.prepare(
      `INSERT INTO intake_item_doses (supplement_id, amount, time_of_day, food_timing, sort)
       VALUES (?, ?, ?, 'any', 0)`
    );
    const tx = db.transaction(() => {
      for (const r of rows) {
        if ((countDose.get(r.id) as { c: number }).c === 0) {
          insertDose.run(r.id, r.dosage, r.time_of_day);
        }
      }
    });
    tx();
    dropColumnIfPresent(db, "intake_items", "dosage");
    dropColumnIfPresent(db, "intake_items", "time_of_day");
  }

  // Re-key intake_item_logs on dose_id. A UNIQUE constraint can't be altered in
  // place, so rebuild the table, mapping each old (supplement_id, date) log to
  // that supplement's first dose (every supplement has exactly one after backfill).
  if (!tableColumns(db, "intake_item_logs").includes("dose_id")) {
    // Rebuild atomically (all-or-nothing) and drop any stale _new table left by a
    // prior aborted attempt, so a crash mid-migration can't brick the next boot.
    db.exec("DROP TABLE IF EXISTS intake_item_logs_new");
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE intake_item_logs_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          dose_id INTEGER NOT NULL REFERENCES intake_item_doses(id) ON DELETE CASCADE,
          supplement_id INTEGER REFERENCES intake_items(id) ON DELETE CASCADE,
          date TEXT NOT NULL,
          taken_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (dose_id, date)
        );
        INSERT INTO intake_item_logs_new (dose_id, supplement_id, date, taken_at)
          SELECT
            (SELECT id FROM intake_item_doses d WHERE d.supplement_id = l.supplement_id
               ORDER BY sort, id LIMIT 1),
            l.supplement_id, l.date, l.taken_at
          FROM intake_item_logs l
          WHERE EXISTS (
            SELECT 1 FROM intake_item_doses d WHERE d.supplement_id = l.supplement_id
          );
        DROP TABLE intake_item_logs;
        ALTER TABLE intake_item_logs_new RENAME TO intake_item_logs;
        CREATE INDEX IF NOT EXISTS idx_intake_log_date ON intake_item_logs(date);
      `);
    });
    rebuild();
  }
}

export const db = globalForDb.__healthDb ?? createDb();
if (process.env.NODE_ENV !== "production") globalForDb.__healthDb = db;

// today()/appTimezone() run many times per request (weekWindowStart, streaks,
// dashboards, adherence), and resolving the zone costs 1–2 DB reads. Memoize the
// resolved zone per profile with a short TTL: within a request every call after
// the first is a map hit (1–2 reads per profile per request, not per call), while
// the TTL bounds staleness for the long-lived notify process, which is a separate
// process that never sees the web app's in-process invalidation. Settings writes
// invalidate the entry in-process for immediate correctness — see
// lib/settings.setProfileSetting/setSetting on the 'timezone' key.
const tzMemo = new Map<number, { tz: string; at: number }>();
const TZ_MEMO_TTL_MS = 5000;

// Drop the memoized timezone for a profile (or all profiles when omitted) so the
// next today()/appTimezone() re-reads it. Called by lib/settings on a 'timezone'
// write (per-profile write clears that profile; the instance default is a
// fallback for every profile, so its write clears the whole memo).
export function invalidateTimezoneMemo(profileId?: number): void {
  if (profileId == null) tzMemo.clear();
  else tzMemo.delete(profileId);
}

// Day boundaries follow the profile's configured timezone (profile_settings key
// 'timezone'), falling back to the instance default (global settings 'timezone')
// and then UTC. We read it inline rather than importing lib/settings (settings.ts
// imports this module, so importing it back would create a cycle);
// lib/settings.getTimezone() is the canonical copy and MUST stay in sync.
function appTimezone(profileId: number): string {
  const hit = tzMemo.get(profileId);
  const now = Date.now();
  if (hit && now - hit.at < TZ_MEMO_TTL_MS) return hit.tz;
  const tz = resolveAppTimezone(profileId);
  tzMemo.set(profileId, { tz, at: now });
  return tz;
}

function resolveAppTimezone(profileId: number): string {
  // Per-profile setting wins; only when it's absent do we read the instance
  // default. The validate-or-UTC decision is the shared resolveTimezone
  // (lib/timezone), the same one lib/settings.getTimezone uses, so the two
  // day-boundary readers can't drift.
  const prof = (
    db
      .prepare(
        "SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'timezone'"
      )
      .get(profileId) as { value?: string } | undefined
  )?.value;
  const instance = prof
    ? undefined
    : (
        db
          .prepare("SELECT value FROM settings WHERE key = 'timezone'")
          .get() as { value?: string } | undefined
      )?.value;
  return resolveTimezone(prof, instance);
}

export function today(profileId: number): string {
  return dateStrInTz(appTimezone(profileId));
}

export function yesterday(profileId: number): string {
  return shiftDateStr(today(profileId), -1);
}
