// Single source of truth for the set of profile-OWNED tables (issue: PHI-delete
// integrity). Before this module, three places kept SEPARATE hand-maintained
// lists that nothing forced to agree — deleteProfile's delete loop, the
// profile-scoping test's owned set, and backfillProfileIds — so a table added to
// one and forgotten in another would either leak a deleted person's PHI (a table
// missing from deleteProfile is never cleared, because profile_id columns added
// via addColumnIfMissing carry NO ON DELETE CASCADE) or silently escape the
// profile-scoping leak check. They now all consume the constants below.
//
// This module intentionally imports NOTHING (no DB, no network), so:
//   - it can be imported by lib/db.ts without an import cycle, and
//   - it is safe to import from the PURE test suite (lib/__tests__).
//
// ── HOW TO ADD A NEW PROFILE-OWNED TABLE (do it in ONE place) ──────────────────
// Any table carrying a `profile_id` column is "directly owned". When you add one:
//   1. Add its name to OWNED_TABLES below. That single edit propagates to:
//        • deleteProfile   (app/(app)/settings/family/actions.ts) — clears its
//          rows on profile deletion,
//        • the profile-scoping leak test (lib/__tests__/profile-scoping.test.ts)
//          — enforces every `.prepare` on it names profile_id,
//        • backfillProfileIds / the addColumnIfMissing loop (lib/db.ts) — but
//          ONLY if you ALSO add it to BACKFILL_OWNED_TABLES (see below).
//   2. Decide how the table gets its profile_id on an UPGRADED database:
//        • Born `profile_id INTEGER NOT NULL` in its CREATE block, OR gains it
//          during an atomic key rebuild (rebuildForProfileScoping) → leave it OUT
//          of BACKFILL_OWNED_TABLES.
//        • Acquires profile_id as a nullable column via addColumnIfMissing (a
//          pre-#67 table) → ADD it to BACKFILL_OWNED_TABLES so its NULL rows are
//          adopted by profile 1.
// The agreement test (in lib/__tests__/profile-scoping.test.ts) DERIVES the owned
// set from lib/db.ts's schema — the tables whose CREATE TABLE block declares a
// profile_id column — and fails the build if OWNED_TABLES doesn't equal it (minus a
// documented grant-matrix/settings-tier allowlist), if BACKFILL_OWNED_TABLES drifts
// outside OWNED_TABLES, or if a consumer stops referencing these constants. So a new
// profile_id table added to db.ts but forgotten here fails the build (the exact
// orphaned-PHI drift this module prevents) — you cannot silently omit step 1 above.

// Every DIRECTLY profile-owned table: those carrying a `profile_id` column. A
// `.prepare` statement naming any of these must also name profile_id (enforced by
// the profile-scoping test), and every one of them is cleared by profile_id when a
// profile is deleted.
//
// NOT here (by design):
//   • CHILD tables (exercise_sets, intake_item_doses/_logs/_pairs,
//     medication_courses, intake_item_side_effects) — they carry no profile_id and
//     are scoped/deleted THROUGH their parent's profile_id via a JOIN/subquery.
//   • GLOBAL tables (logins, profiles, login_profiles, sessions, login_attempts,
//     settings, canonical_biomarkers, providers) — shared across the instance and
//     intentionally not profile-scoped.
export const OWNED_TABLES = [
  "activities",
  "body_metrics",
  "immunizations",
  "immunization_overrides",
  "goals",
  "medical_records",
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
  "ai_usage_counters",
  "deleted_rows",
  "replayed_keys",
  "milestones",
] as const;

export type OwnedTable = (typeof OWNED_TABLES)[number];

// The subset of OWNED_TABLES that acquired `profile_id` as a NULLABLE column via
// addColumnIfMissing on UPGRADED databases (the pre-#67 single-profile tables).
// Only these can hold NULL profile_id rows, so ONLY these are (a) the addColumnIf-
// Missing profile_id loop and (b) re-parented to profile 1 by backfillProfileIds.
// The rest of OWNED_TABLES either were born `profile_id NOT NULL` in their CREATE
// block, or gain profile_id during an atomic key rebuild (rebuildForProfileScoping
// copies rows onto profile 1), so they never present a NULL row to backfill.
export const BACKFILL_OWNED_TABLES = [
  "activities",
  "body_metrics",
  "goals",
  "medical_records",
  "medical_documents",
  "import_jobs",
  "intake_items",
  "intake_item_suggestions",
  "frequency_targets",
  "equipment",
] as const;
