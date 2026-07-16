// Single source of truth for the set of profile-OWNED tables (issue: PHI-delete
// integrity). Before this module, separate hand-maintained lists that nothing
// forced to agree lived in deleteProfile's delete loop and the profile-scoping
// test's owned set — so a table added to one and forgotten in another would
// either leak a deleted person's PHI (a table missing from deleteProfile is never
// cleared — deleteProfile deletes by profile_id explicitly, never via FK cascade)
// or silently escape the profile-scoping leak check. They now all consume the
// constant below.
//
// This module intentionally imports NOTHING (no DB, no network), so:
//   - it can be imported by lib/db.ts without an import cycle, and
//   - it is safe to import from the PURE test suite (lib/__tests__).
//
// ── HOW TO ADD A NEW PROFILE-OWNED TABLE (do it in ONE place) ──────────────────
// Any table carrying a `profile_id` column is "directly owned". When you add one
// (as a new migration in lib/migrations/versions/ — born `profile_id INTEGER NOT
// NULL` in its CREATE):
//   1. Add its name to OWNED_TABLES below. That single edit propagates to:
//        • deleteProfile   (app/(app)/settings/family/actions.ts) — clears its
//          rows on profile deletion,
//        • the profile-scoping leak test (lib/__tests__/profile-scoping.test.ts)
//          — enforces every `.prepare` on it names profile_id.
// The agreement test (in lib/__tests__/profile-scoping.test.ts) DERIVES the owned
// set from the schema source — the tables whose CREATE TABLE block declares a
// profile_id column — and fails the build if OWNED_TABLES doesn't equal it (minus
// a documented grant-matrix/settings-tier allowlist) or if a consumer stops
// referencing this constant. So a new profile_id table added to the schema but
// forgotten here fails the build (the exact orphaned-PHI drift this module
// prevents) — you cannot silently omit step 1 above.

// Every DIRECTLY profile-owned table: those carrying a `profile_id` column. A
// `.prepare` statement naming any of these must also name profile_id (enforced by
// the profile-scoping test), and every one of them is cleared by profile_id when a
// profile is deleted.
//
// NOT here (by design):
//   • CHILD tables (exercise_sets, intake_item_doses/_logs/_pairs,
//     medication_courses, intake_item_side_effects, and the routine children
//     routine_days/routine_slots — #738) — they carry no profile_id and are
//     scoped/deleted THROUGH their parent's profile_id via a JOIN/subquery
//     (routine_days → routines, routine_slots → routine_days → routines).
//   • GLOBAL tables (logins, profiles, login_profiles, sessions, login_attempts,
//     settings, canonical_biomarkers, providers) — shared across the instance and
//     intentionally not profile-scoped.
export const OWNED_TABLES = [
  "activities",
  "body_metrics",
  "immunizations",
  "immunization_overrides",
  "preventive_events",
  "preventive_overrides",
  "goals",
  "medical_records",
  // Structured genomic variants (#709). Ordered BEFORE medical_documents so
  // deleteProfile clears the child rows carrying a document_id FK before it drops
  // their parent medical_documents rows (the FK carries no ON DELETE action).
  "genomic_variants",
  // Structured imaging studies (#702). Ordered BEFORE medical_documents so
  // deleteProfile clears the child rows carrying a document_id FK before it drops
  // their parent medical_documents rows (the FK carries no ON DELETE action).
  "imaging_studies",
  "medical_documents",
  "allergies",
  "conditions",
  "encounters",
  "procedures",
  "family_history",
  "care_plan_items",
  "care_goals",
  "appointments",
  "import_jobs",
  "intake_items",
  "intake_item_suggestions",
  "frequency_targets",
  "equipment",
  "hr_minutes",
  "insights",
  "narratives",
  "metric_samples",
  "starred_biomarkers",
  "integration_connections",
  "integration_sync_events",
  "profile_share_links",
  "upcoming_dismissals",
  "import_pair_decisions",
  "import_tombstones",
  "ai_usage_counters",
  "deleted_rows",
  "replayed_keys",
  "milestones",
  "protocols",
  "coverage_gaps",
  "situations",
  "food_log",
  // Day-by-day symptom log (#799). Directly owned; UNIQUE(profile_id, date, symptom)
  // keeps one row per symptom-day (worst-severity semantics).
  "symptom_logs",
  // Adopted/authored training routines (#738). Directly owned; its children
  // routine_days/routine_slots reach profile_id via JOIN (see the NOT-here note
  // above) and are cleared through this parent in deleteProfile.
  "routines",
] as const;

export type OwnedTable = (typeof OWNED_TABLES)[number];
