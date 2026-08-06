import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { OWNED_TABLES } from "@/lib/owned-tables";
import {
  isCrossProfileSqlModule,
  usesProfileIdInList,
} from "@/lib/cross-profile";
import {
  REPO,
  execArgs,
  norm,
  prepareArgs,
  readSource,
  relPath,
  sourceFiles,
} from "./sql-scan";

// Static leak-detection for the multi-user conversion. This
// reads the repo's own source as TEXT — no DB, no network, so it stays "pure" in
// the vitest sense — extracts the first argument of every `.prepare(` call, and
// fails if a statement touches a profile-OWNED table without `profile_id`
// appearing in it (child tables reach profile_id via a JOIN to their parent, so a
// statement that joins the parent naturally mentions the parent table + its
// profile_id). It is a coarse guard, not a proof: the SHORT allowlist below
// carves out the handful of statements that are safe for reasons text can't see
// (an id already fetched by a profile-scoped query, or SQL composed at runtime).
//
// The source enumeration and the `.prepare`/`.exec` argument extraction live in
// ./sql-scan.ts, shared with the #1893 gated-table write scan — one scanner, two
// questions asked of the same statements.

// The directly profile-owned tables (those carrying a profile_id column). A
// `.prepare` statement naming any of these must also name profile_id. This is now
// imported from the SHARED source of truth (lib/owned-tables.ts, OWNED_TABLES) so
// this test, deleteProfile, and backfillProfileIds can't drift apart; the
// agreement test below fails the build if they do.
//
// CHILD tables are intentionally absent: they carry no profile_id of their own and
// are scoped through a JOIN to their parent (which IS owned, so a query that joins
// the parent necessarily mentions profile_id). The intake_items children —
// intake_item_doses / _logs / _pairs and, added later, the medication history
// tables `medication_courses` + `intake_item_side_effects` — are reached this way:
// their READ queries JOIN intake_items and filter ii.profile_id = ?, and their
// child-only writes (WHERE item_id = ?) are guarded by a prior profile-scoped
// ownership check on the parent intake_items row. Both of those tables FK item_id →
// intake_items(id) ON DELETE CASCADE, so deleteProfile (and the document
// delete) clear them via the parent.
//
// GLOBAL tables are intentionally absent, so a statement touching only one of them
// is never flagged: logins, profiles, login_profiles, sessions, login_attempts,
// global settings, canonical_biomarkers, `providers`, and — added later —
// `shared_supplies`.
// The providers registry is shared across the whole family/instance (a family sees
// one "Quest Diagnostics"), modeled like logins/profiles: the per-record LINK
// (immunizations/medical_records/intake_items.provider_id) lives on a profile-owned
// row and is therefore covered by the rule via those tables, but the shared
// `providers` row it points at is global and its data layer (lib/providers-db) is
// deliberately not profile-scoped.
// `shared_supplies` (#1374) is the same shape one domain over — the household medicine
// cabinet. A family owns ONE bottle of ibuprofen, so the bottle row is instance-shared,
// carries no profile_id, and stays out of OWNED_TABLES; the per-record LINK
// (`intake_items.supply_id`) lives on a profile-owned row and IS covered through that
// table, while its data layer (lib/queries/intake/supply-pool) is deliberately not
// profile-scoped.
const OWNED_RE = new RegExp(`\\b(${OWNED_TABLES.join("|")})\\b`);

// Statements that legitimately touch an owned table without profile_id, keyed by
// the file they live in (so an unrelated file can't ride the exemption). Each is
// matched as a normalized-SQL substring. Keep this list SHORT and justified.
const ALLOW_SQL: { file: string; includes: string; why: string }[] = [
  {
    file: "lib/migrations/boot-tasks.ts",
    includes:
      "UPDATE integration_backfill_jobs SET status = 'paused', retry_after_at = ?, updated_at = ?",
    why: "boot recovery for integration backfills: a GLOBAL lease reaper pauses queued/running jobs abandoned by a dead process; each job remains profile-owned and the next profile-scoped hourly pass resumes only its own due rows. Moved here from ALLOW_EXEC by #2205 — the sweep now BINDS its instants instead of interpolating SQLite's bare-shaped clock into a column that stores ISO-8601 UTC with a Z suffix. Same statement, same global reach.",
  },
  {
    file: "app/(app)/supplies/actions.ts",
    includes: "SELECT profile_id FROM intake_items WHERE id = ?",
    why: "requireItemWriteAccess (#1374): the ONE lookup that RESOLVES which profile an item belongs to so the action can gate on it — filtering by profile_id here would presuppose the answer. Reads only the id→profile_id mapping and immediately feeds it to requireProfileWriteAccess; the gate is the protection, not the filter (the app/(app)/gate-item.ts shape)",
  },
  {
    file: "app/api/symptom-video/[id]/route.ts",
    includes:
      "SELECT profile_id, stored_path, poster_path, mime_type FROM symptom_videos WHERE id = ?",
    why: "the symptom-clip serve route (#1696): the ONE lookup that RESOLVES which profile a clip belongs to so the handler can gate on THAT profile (canAccessProfile — the grants set), matching the episode page that renders the strip and resolves it across ACCESSIBLE profiles (#879). Filtering by profile_id here would presuppose the answer, and pinning it to the ACTIVE profile is the bug: a caregiver's clips 404'd. The gate is the protection, not the filter (the app/(app)/gate-item.ts shape) — nothing about the row is observable before it, and an inaccessible profile's clip is refused identically to a nonexistent id",
  },
  {
    file: "app/api/symptom-photo/[id]/route.ts",
    includes:
      "SELECT profile_id, stored_path, mime_type FROM symptom_photos WHERE id = ?",
    why: "the symptom-photo serve route (#1696): the same resolve-the-owner-then-gate lookup as the clip route above, for the photo strip that renders on the SAME cross-profile episode page",
  },
  {
    file: "lib/queries/intake/supply-pool.ts",
    includes:
      "FROM intake_items i LEFT JOIN intake_item_doses d ON d.item_id = i.id AND d.retired = 0 WHERE i.supply_id = ?",
    why: "poolMembers (#1374): a shared bottle's takers are DIFFERENT PEOPLE by construction, so membership and its child dose labels are cross-profile on purpose. It is an ACCOUNTING read (who draws from this bottle → the pooled decrement/projection/alert), with dose amounts carried only to disambiguate actionable member labels; the id is a household-shared shared_supplies row, and every surface that NAMES members filters this through the caller's ProfileScope before rendering",
  },
  {
    file: "lib/queries/intake/supply-pool.ts",
    includes:
      "UPDATE intake_items SET supply_id = NULL, quantity_on_hand = ? WHERE id = ? AND profile_id = ?",
    why: "deleteSharedSupply (#1374): unlinks each member row it just read from poolMembers — the statement itself IS profile-scoped (id AND profile_id); listed only because the surrounding function's membership read is the cross-profile one above",
  },
  {
    file: "lib/portals.ts",
    includes:
      "SELECT pi.profile_id AS profileId, pi.portal_id AS portalId, pi.account_id AS accountId FROM portal_identities pi WHERE pi.account_id = ? AND pi.patient_label = ? AND pi.ignored = 0 AND pi.profile_id IS NOT NULL",
    why: "resolvePortalIdentity (#1739): the ONE lookup that RESOLVES which profile to gate on; the gate is the protection, the resolved id is immediately intersected with the token's write set. Filtering by profile_id here would presuppose the answer the acquirer is asking for. An identity that resolves to a profile the pushing token cannot write is refused exactly as loudly as an unbound one",
  },
  {
    file: "lib/portals.ts",
    includes:
      "FROM portal_identities pi JOIN portals p ON p.id = pi.portal_id JOIN portal_accounts a ON a.id = pi.account_id",
    why: "listPortalIdentities (#1739): the administrative 'which patient goes where' view is cross-profile BY NATURE — its whole job is to show bindings across the household so a misfiled one is visible. It carries identifiers and labels only (no health data), and the rendering surface filters to the viewer's accessible set before display. IGNORED rows carry no profile_id at all (the migration-131 CHECK), so there is nothing to filter them by",
  },
  {
    file: "lib/portals.ts",
    includes:
      "SELECT id FROM portal_identities WHERE account_id = ? AND patient_label = ?",
    why: "writeBinding (#1739): re-reads the id of the row the adjacent ON CONFLICT upsert just wrote, keyed on the UNIQUE(portal_id, account_id, patient_label) index. The INSERT itself names profile_id and the caller authorized it; this reads back only the surrogate key",
  },
  {
    file: "lib/portals.ts",
    includes:
      "SELECT 1 FROM portal_identities WHERE account_id = ? AND patient_label = ?",
    why: "recordPendingForAccount (#1739): asks only whether this (login, label) has ALREADY BEEN ANSWERED — bound or ignored — so an identity a run rediscovers every hour is not re-offered as pending. It is an existence probe on the external identity key; it reads no profile_id and returns no row data, and the pending table it guards carries no profile at all",
  },
  {
    file: "lib/portals.ts",
    includes:
      "SELECT id, profile_id AS profileId FROM portal_identities WHERE account_id = ? AND patient_label = ?",
    why: "applyIdentityOutcomes / clearIdentityDeclined (#1889): the same resolve-the-owner lookup as portalIdentityProfile, keyed on the EXTERNAL identity a run report names rather than on a surrogate id the client could not know. It asks 'whose binding is this, so I can check the reporting token may write it' — filtering by profile_id would presuppose that answer. BOTH functions intersect against the token's write set inside the core (#1960 moved clearIdentityDeclined onto that footing after its one caller was calling it before its own write gate), and the UPDATE that follows IS profile-scoped (id AND profile_id, a compare-and-swap)",
  },
  {
    file: "lib/portals.ts",
    includes:
      "SELECT profile_id AS profileId FROM portal_identities WHERE id = ?",
    why: "portalIdentityProfile (#1747): the ONE lookup that RESOLVES which profile a binding points at so the unbind action can gate on THAT profile rather than on a profile id the same client post supplied — filtering by profile_id here would presuppose the answer. It reads the id→profile_id mapping and nothing else, feeds it straight to requireProfileWriteAccess, and the delete that follows IS profile-scoped (id AND profile_id, a compare-and-swap). The gate is the protection, not the filter (the app/(app)/gate-item.ts shape)",
  },
  {
    file: "lib/portals.ts",
    includes:
      "SELECT profile_id AS profileId, ignored FROM portal_identities WHERE id = ?",
    why: "portalIdentityState (#1739): the same resolve-the-owner lookup as portalIdentityProfile, plus whether the row is IGNORED — an ignored binding has no profile by CHECK, so the action must be able to tell 'gone' from 'has no profile to authorize against' before choosing its gate. Reads only those two fields and immediately feeds the profile to requireProfileWriteAccess",
  },
  {
    file: "lib/portals.ts",
    includes:
      "SELECT id, profile_id AS profileId, ignored FROM portal_identities WHERE account_id = ? AND patient_label = ?",
    why: "boundIdentityState (#2103): the bind action's resolve-the-current-owner lookup, keyed on the EXTERNAL (login, label) identity the caller typed — the same resolve-then-gate shape as portalIdentityState, one row earlier in the flow. It exists because the bind upsert would otherwise silently RE-POINT a live binding under a caller that authorized only the target side; the action gates BOTH resolved profiles (remapIdentityAction's discipline) and writeBinding re-checks inside its transaction. Filtering by profile_id would presuppose the answer",
  },
  {
    file: "lib/portals.ts",
    includes: "DELETE FROM portal_identities WHERE id = ? AND ignored = 1",
    why: "unignorePortalIdentity (#1739): removes an IGNORED binding, which by the migration-131 CHECK carries NO profile_id — there is literally nothing to scope by, which is why the statement scopes by `ignored = 1` instead. That predicate is the protection: this path can never touch a live binding, so it cannot become a back door around the profile gate the normal unbind takes",
  },
  {
    file: "lib/portals.ts",
    includes: "DELETE FROM portal_identities WHERE portal_id = ?",
    why: "deletePortal (#1739): dropping a PORTAL removes every binding on it regardless of profile — that is the operation. The FK cascade would also fire; this runs explicitly so the teardown holds with foreign_keys off",
  },
  {
    file: "lib/portals.ts",
    includes: "DELETE FROM portal_identities WHERE account_id = ?",
    why: "deletePortalAccount (#1739): dropping a portal LOGIN removes every binding keyed to it regardless of profile — the same operation one level down, and the same FK-cascade-plus-explicit-delete posture as deletePortal",
  },
  {
    file: "lib/portals.ts",
    includes:
      "UPDATE medical_documents SET acquired_portal_id = NULL WHERE acquired_portal_id = ?",
    why: "deletePortal (#1748): dropping a PORTAL clears the acquired-by link on every document that names it, regardless of profile — that is the operation, exactly like the portal_identities cleanup beside it. The FK's ON DELETE SET NULL would also fire; this runs explicitly so the teardown holds with foreign_keys off. It writes ONLY the provenance column (never profile_id, never content), and the documents themselves are untouched",
  },
  {
    file: "lib/portals.ts",
    includes:
      "UPDATE integration_sync_events SET portal_id = NULL, account_id = NULL WHERE portal_id = ?",
    why: "deletePortal (#1739): clears the identity stamp on every sync event that named the removed portal, across profiles — same operation and same reasoning as the document provenance null above. It writes only the two identity columns; the event history itself (counts, ok, timestamps) is untouched",
  },
  {
    file: "lib/portals.ts",
    includes:
      "UPDATE integration_sync_events SET account_id = NULL WHERE account_id = ?",
    why: "deletePortalAccount (#1739): the same identity-stamp clear one level down, for a removed portal LOGIN",
  },
  {
    file: "lib/queries/medical/flags.ts",
    includes: "UPDATE medical_records SET flag = ? WHERE id = ?",
    why: "reconcileFlags: the ids are produced by a profile-scoped SELECT in the same function",
  },
  {
    file: "lib/queries/medical/flags.ts",
    includes: "UPDATE medical_records SET flag = NULL WHERE id = ?",
    why: "reconcileFlags: ids come from a profile-scoped SELECT",
  },
  {
    file: "lib/migrations/boot-tasks.ts",
    includes: "UPDATE medical_records SET flag = ? WHERE id = ?",
    why: "boot-time reconcile: ids come from a per-profile SELECT (rowsStmt)",
  },
  {
    file: "lib/migrations/boot-tasks.ts",
    includes: "UPDATE medical_records SET flag = NULL WHERE id = ?",
    why: "boot-time reconcile: ids come from a per-profile SELECT (rowsStmt)",
  },
  {
    file: "lib/migrations/boot-tasks.ts",
    includes:
      "FROM medical_records WHERE value_num IS NULL AND category IN ('lab','biomarker')",
    why: "boot-time qualitative flag reconcile (#549): a GLOBAL maintenance re-derivation run once per canonical-flags-signature change — a qualitative value classifies the same for every profile (blood type / immunity titer), so it is intentionally profile-agnostic; it only rewrites the row's own flag, never reads across profiles",
  },
  {
    file: "lib/migrations/boot-tasks.ts",
    includes: "PRAGMA table_info(medical_records)",
    why: "schema introspection (#684): checks whether the migration-034 loinc column exists so the version-agnostic boot reconcile can run against an earlier schema — not a data query, reads no rows",
  },
  {
    file: "lib/integrations/normalize.ts",
    includes: "UPDATE medical_records SET date = ?",
    why: "upsertVitals: the id comes from a profile-scoped find() just above",
  },
  {
    file: "lib/integrations/normalize.ts",
    includes: "UPDATE activities SET date = ?",
    why: "upsertActivities: the id comes from a profile-scoped find() just above",
  },
  // queries.ts statements whose profile_id lives inside an interpolated fragment
  // (`${clause}` / `${where.join(...)}` always start with `profile_id = ?`; the
  // getMedicalRecords query also carries an explicit `WHERE profile_id = ?` in its
  // latest-ids CTE).
  {
    file: "lib/queries/medical.ts",
    includes: "AS is_latest FROM medical_records",
    why: "getMedicalRecords: the latest-ids CTE and ${clause} both filter profile_id = ?",
  },
  {
    file: "lib/queries/medical.ts",
    includes: "FROM medical_records WHERE ${where.join(",
    why: "getRecordsForDocument: where[] always begins with 'profile_id = ?'",
  },
  {
    file: "lib/queries/clinical.ts",
    includes: "FROM conditions WHERE ${where.join(",
    why: "getConditions: where[] always begins with 'profile_id = ?'",
  },
  {
    file: "lib/undo-delete-db.ts",
    includes: "SELECT profile_id AS profileId FROM deleted_rows WHERE id = ?",
    why: "deletedRowProfile (#2104): the ONE lookup that RESOLVES which profile a capture belongs to, so the undo action can gate on the CAPTURED row's profile rather than the acting one — a multi-view delete stamps the row's subject, and filtering by profile_id here would presuppose the answer. It reads the id→profile_id mapping and nothing else, feeds it straight to requireProfileWriteAccess, and the restore that follows IS profile-scoped (id AND profile_id, the anti-replay compare) — portalIdentityProfile's shape (#1747)",
  },
  {
    file: "lib/undo-delete-db.ts",
    includes: "DELETE FROM deleted_rows WHERE deleted_at < datetime('now', ?)",
    why: "sweepDeletedRows: the undo/Trash retention purge (window admin-configured since #2013, 30-day default) is GLOBAL by design — one call per hourly tick clears every profile's EXPIRED rows — so it is intentionally profile-agnostic. The user-invoked purges next door (purgeDeletedRow / emptyTrash, #2013) are a different operation and DO filter on profile_id",
  },
  {
    file: "lib/undo-delete-db.ts",
    includes:
      "SELECT payload FROM deleted_rows WHERE deleted_at < datetime('now', ?)",
    why: "sweepDeletedRows video-file cleanup (#1290): reads the SAME expiring rows the GLOBAL retention purge DELETE (above) is about to remove, to unlink their orphaned clip files — profile-agnostic for the identical reason, and each captured path is then re-contained under its domain root before any unlink",
  },
  {
    file: "lib/offline/writes.ts",
    includes: "DELETE FROM replayed_keys WHERE created_at < datetime('now', ?)",
    why: "sweepReplayedKeys (#98): the offline-replay idempotency-ledger retention purge is GLOBAL by design (one call per hourly tick prunes every profile's expired keys by age, once past the replay-race window), so it is intentionally profile-agnostic — mirrors sweepDeletedRows",
  },
  {
    file: "lib/extraction-reaper.ts",
    includes:
      "UPDATE medical_documents SET extraction_status = 'failed', extraction_error = ? WHERE extraction_status = 'processing'",
    why: "reapStuckExtractions (#135 item 4): the stuck-'processing' lease reaper is GLOBAL maintenance run once per hourly tick (mirrors the boot reset in boot-tasks.ts), so it is intentionally profile-agnostic — it only fails rows a hung in-process extraction left mid-flight, keyed by the lease timestamp, never a profile's data",
  },
  {
    file: "lib/share-links-db.ts",
    includes: "FROM profile_share_links WHERE token_hash = ?",
    why: "getShareLinkByToken: the ONLY entry point for the unauthenticated public share route — the caller has no profile context yet; the lookup is by the unguessable 256-bit token's SHA-256, and the returned row's profile_id then scopes every downstream read",
  },
  {
    file: "lib/migrations/versions/014-hr-minutes-per-source.ts",
    includes: "PRAGMA table_info(hr_minutes)",
    why: "migration 013 replay sentinel: a schema-shape PRAGMA (is `source` already in the PRIMARY KEY?) that reads column metadata, never rows",
  },
  {
    file: "lib/migrations/versions/038-food-habit-unique.ts",
    includes:
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'frequency_targets'",
    why: "migration 038 partial-handle guard: a sqlite_master metadata probe (does the table exist yet?) that reads schema, not rows — its de-dupe/UPDATE/DELETE statements below are all profile_id-scoped",
  },
  {
    file: "lib/migrations/versions/123-practice-target-unique.ts",
    includes:
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'frequency_targets'",
    why: "migration 123 partial-handle guard: a sqlite_master metadata probe (does the table exist yet?) that reads schema, not rows — mirrors migration 038",
  },
  {
    file: "lib/migrations/versions/042-symptom-logs.ts",
    includes: "UPDATE situations SET illness_type = 1 WHERE name = 'Illness'",
    why: "migration 042 (#799) one-shot backfill: defaults the illness_type flag ON for the SHARED built-in 'Illness' situation across ALL profiles by canonical name — a vocabulary default, not a per-profile read; every runtime situations statement stays profile_id-scoped",
  },
  {
    file: "lib/migrations/versions/071-imaging-dose.ts",
    includes: "PRAGMA table_info(imaging_studies)",
    why: "migration 071 (#703) ADD COLUMN guard: a schema-shape PRAGMA (does dose_msv already exist?) so the non-version-gated migrate() replay no-ops — reads column metadata, never rows",
  },
  {
    file: "lib/migrations/versions/139-notify-message-title.ts",
    includes: "PRAGMA table_info(notify_messages)",
    why: "migration 139 (#1822) ADD COLUMN guard: a schema-shape PRAGMA (does `title` already exist?) so a replay no-ops — reads column metadata, never rows (mirrors migration 071's guard)",
  },
  {
    file: "lib/migrations/versions/140-prn-max-daily-mg.ts",
    includes: "PRAGMA table_info(intake_items)",
    why: "migration 140 (#1854) ADD COLUMN guard: a schema-shape PRAGMA (does `max_daily_amount_mg` already exist?) so a replay no-ops — reads column metadata, never rows (mirrors migration 071's guard)",
  },
  {
    file: "lib/migrations/versions/141-followup-settle.ts",
    includes: "PRAGMA table_info(care_plan_items)",
    why: "migration 141 (#1866) ADD COLUMN guard: a schema-shape PRAGMA (do the settled_* columns already exist?) so a replay no-ops — reads column metadata, never rows (mirrors migration 071's guard)",
  },
  {
    file: "lib/migrations/versions/144-condition-laterality-severity.ts",
    includes: "PRAGMA table_info(conditions)",
    why: "migration 144 (#1403) ADD COLUMN guard: a schema-shape PRAGMA (do laterality/severity/stage already exist?) so a replay no-ops — reads column metadata, never rows (mirrors migration 071's guard)",
  },
  {
    file: "lib/migrations/versions/161-condition-edit-lock.ts",
    includes: "PRAGMA table_info(conditions)",
    why: "migration 161 (#2137) ADD COLUMN guard: a schema-shape PRAGMA (does `edited` already exist?) so the non-version-gated migrate() replay no-ops — reads column metadata, never rows; mirrors migration 115's guard",
  },
  {
    file: "lib/migrations/versions/145-family-history-death-lineage.ts",
    includes: "PRAGMA table_info(family_history)",
    why: "migration 145 (#1407) ADD COLUMN guard: a schema-shape PRAGMA (do age_at_death/cause_of_death/relation_type/lineage already exist?) so a replay no-ops — reads column metadata, never rows (mirrors migration 071's guard)",
  },
  {
    file: "lib/migrations/versions/076-encounter-type-code.ts",
    includes: "PRAGMA table_info(encounters)",
    why: "migration 075 (#1035) ADD COLUMN guard: a schema-shape PRAGMA (do code/code_system already exist?) so the non-version-gated migrate() replay no-ops — reads column metadata, never rows (mirrors migration 071's guard)",
  },
  {
    file: "lib/migrations/versions/074-imported-temperature-degf.ts",
    includes:
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'medical_records'",
    why: "migration 074 partial-handle guard: a sqlite_master metadata probe (does the table exist yet?) that reads schema, not rows — mirrors migration 038's guard",
  },
  {
    file: "lib/migrations/versions/074-imported-temperature-degf.ts",
    includes: "SELECT id, value_num, unit, edited FROM medical_records",
    why: "migration 074 (#1018) one-shot data converge: rewrites mis-stored imported Body Temperature rows to canonical °F across ALL profiles, keyed by canonical name + unit spelling — a vocabulary-level unit fix, never reading one profile's data into another's; its UPDATEs below key on the ids this SELECT returned",
  },
  {
    file: "lib/migrations/versions/074-imported-temperature-degf.ts",
    includes:
      "UPDATE medical_records SET value = ?, value_num = ?, unit = 'degF'",
    why: "migration 074 (#1018): the per-row converge UPDATE, keyed by the id the migration's own canonical-name-scoped SELECT produced (ids never recycle — AUTOINCREMENT)",
  },
  {
    file: "lib/migrations/versions/074-imported-temperature-degf.ts",
    includes: "UPDATE medical_records SET unit = 'degF' WHERE id = ?",
    why: "migration 074 (#1018): the unit-respell UPDATE ([degF]/°F → degF, value untouched), keyed the same way",
  },
  {
    file: "lib/migrations/versions/115-metric-sample-edit-lock.ts",
    includes: "PRAGMA table_info(metric_samples)",
    why: "migration 115 (#1488) ADD COLUMN guard: a schema-shape PRAGMA (does `edited` already exist?) so the non-version-gated migrate() replay no-ops — reads column metadata, never rows; mirrors migration 071's guard",
  },
  {
    file: "lib/migrations/versions/155-fitbit-sleep-instants.ts",
    includes: "PRAGMA table_info(metric_samples)",
    why: "migration 155 (#2096) shape guard: a schema-shape PRAGMA (do `edited` and `origin` exist yet?) so the migration no-ops against an older at-rest shape — reads column metadata, never rows; mirrors migration 115's guard on this table",
  },
  {
    file: "lib/migrations/versions/155-fitbit-sleep-instants.ts",
    includes:
      "SELECT id, profile_id, metric, origin, start_time, end_time FROM metric_samples WHERE source = ? AND edited = 0 AND metric IN (${placeholders})",
    why: "migration 155 (#2096) one-shot converge: reinterprets Fitbit Takeout's ZONELESS sleep boundaries as absolute instants across ALL profiles. Deliberately unscoped because the defect is a property of the SOURCE, not of a profile — every Takeout row ever written carries it. It never reads one profile's data into another's: profile_id is SELECTED so each row is converted in ITS OWN profile's timezone, and the UPDATE below keys on the row's own id.",
  },
  {
    file: "lib/migrations/versions/155-fitbit-sleep-instants.ts",
    includes:
      "SELECT id FROM metric_samples WHERE profile_id = ? AND metric = ? AND source = ? AND origin IS ? AND start_time = ?",
    why: "migration 155 (#2096) collision probe: profile_id-scoped by construction — it asks whether the converted natural key is already occupied WITHIN the row's own profile before updating",
  },
  {
    file: "lib/migrations/versions/155-fitbit-sleep-instants.ts",
    includes:
      "UPDATE metric_samples SET start_time = ?, end_time = ? WHERE id = ?",
    why: "migration 155 (#2096): the per-row converge UPDATE, keyed by the id its own SELECT produced (ids never recycle — AUTOINCREMENT), with the instant computed from that row's profile timezone",
  },
  {
    file: "lib/migrations/versions/155-fitbit-sleep-instants.ts",
    includes:
      "SELECT id, profile_id, natural_key FROM import_tombstones WHERE target_table = 'metric_samples'",
    why: "migration 155 (#2096): the delete tombstones must move with the rows they suppress or a deleted Takeout night resurrects on the next import. Unscoped for the same reason as the row converge, and profile_id is SELECTED so each key is re-derived in its own profile's timezone — the identical shape migration 083 used when it last re-keyed this table.",
  },
  {
    file: "lib/migrations/versions/155-fitbit-sleep-instants.ts",
    includes:
      "SELECT id FROM import_tombstones WHERE profile_id = ? AND target_table = 'metric_samples' AND natural_key = ?",
    why: "migration 155 (#2096) tombstone collision probe: profile_id-scoped by construction — asks whether the converted key already exists within the row's own profile",
  },
  {
    file: "lib/migrations/versions/155-fitbit-sleep-instants.ts",
    includes: "UPDATE import_tombstones SET natural_key = ? WHERE id = ?",
    why: "migration 155 (#2096): the per-tombstone re-key, keyed by the id its own SELECT produced",
  },
  {
    file: "lib/migrations/versions/155-fitbit-sleep-instants.ts",
    includes: "DELETE FROM import_tombstones WHERE id = ?",
    why: "migration 155 (#2096): drops a re-keyed tombstone that would duplicate one already present in the SAME profile (the set-membership dedupe), keyed by the id its own SELECT produced",
  },
  {
    file: "lib/migrations/versions/075-extraction-completed-at.ts",
    includes: "PRAGMA table_info(medical_documents)",
    why: "migration 075 (#1022) ADD COLUMN guard: a schema-shape PRAGMA (does extraction_completed_at already exist?) so the non-version-gated migrate() replay no-ops — reads column metadata, never rows; mirrors migration 071's guard",
  },
  {
    file: "lib/migrations/versions/116-food-event-meal-slot.ts",
    includes: "PRAGMA table_info(food_log_events)",
    why: "migration 116 ADD COLUMN guard: schema-shape introspection so the non-version-gated migrate() replay no-ops — reads column metadata, never food events",
  },
  {
    file: "lib/migrations/versions/154-food-eating-time.ts",
    includes: "PRAGMA table_info(food_log_events)",
    why: "migration 154 (#2019) ADD COLUMN guard for eaten_at/time_source: the same schema-shape introspection migration 116 uses on this table — reads column metadata, never food events",
  },
  {
    file: "lib/migrations/versions/090-medical-record-category-classes.ts",
    includes:
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'medical_records'",
    why: "migration 090 (#1076) replay/partial-handle guard: a sqlite_master metadata probe (does the table carry the grown CHECK yet?) that reads schema, not rows — mirrors migration 074's guard",
  },
  {
    file: "lib/migrations/versions/090-medical-record-category-classes.ts",
    includes:
      "UPDATE medical_records SET category = ? WHERE canonical_name = ? COLLATE NOCASE AND category != ?",
    why: "migration 090 (#1076) one-shot category converge: re-derives category from canonical name for a fixed set of known analytes (Glucose→lab, PHQ-9…→instrument, PhenoAge/Biological Age→derived, Blood Type…→reference) across ALL profiles — a vocabulary-level classification fix, never reading one profile's data into another's",
  },
  {
    file: "lib/migrations/versions/106-medical-record-report-category.ts",
    includes:
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'medical_records'",
    why: "migration 106 (#708) replay/partial-handle guard: a sqlite_master metadata probe (does the table carry the 'report' CHECK yet?) that reads schema, not rows — identical to migration 090's guard",
  },
  {
    file: "lib/migrations/versions/092-consolidate-imported-prescriptions.ts",
    includes: "JOIN medical_records r ON r.id = ii.source_record_id",
    why: "migration 092 (#1178) one-shot consolidation: enumerates each PAIRED (med, prescription-record) twin BY the source_record_id back-link the import wrote — the join key itself is the med↔record identity, and both rows share the same profile_id by construction (a med is projected within one profile's import). The per-row re-key/UPDATE it drives all carry the row's own profile_id; this SELECT never reads one profile's data into another's.",
  },
  {
    file: "lib/migrations/versions/103-canonical-name-abbreviation-consolidation.ts",
    includes:
      "UPDATE medical_records SET canonical_name = ? WHERE canonical_name = ? COLLATE NOCASE",
    why: "migration 103 one-shot canonical-name rename: a bare-abbreviation biomarker name (e.g. 'RDW') is a GLOBAL vocabulary identity, not per-profile data, so the acronym→'Full Name (ABBR)' rewrite applies to every profile's rows by value — profile_id is deliberately absent. Pure value substitution (same analyte keeps its identity); reads no row across profiles.",
  },
  // ── Positional-rule (#1208 fix 1) additions ─────────────────────────────────
  // These NAME profile_id (so they passed the old "profile_id-anywhere" check) but
  // only outside a WHERE/ON predicate — a select-list column or a GROUP BY key — so
  // the tightened positional rule now flags them. Each is legitimately global or a
  // token-resolution path, verified by hand.
  {
    file: "lib/integrations/connections.ts",
    includes: "DELETE FROM integration_sync_events WHERE at < ?",
    why: "pruneSyncEvents: a GLOBAL retention prune (one call per tick clears every profile's aged sync events, keeping the newest per (profile_id, provider)). profile_id appears only in the retained-newest GROUP BY subquery, never a predicate — deliberately profile-agnostic, mirroring sweepDeletedRows/sweepReplayedKeys.",
  },
  {
    file: "lib/integrations/connections.ts",
    includes:
      "SELECT profile_id, config FROM integration_connections WHERE provider = 'health-connect'",
    why: "resolveHealthConnectProfile: the token→profile resolver for the UNAUTHENTICATED Health Connect push ingest. The caller has no profile context; the presented bearer token IS the identity, constant-time-compared against every stored HC token to find WHOSE data the push lands under — inherently cross-profile, the getShareLinkByToken class. Its result then scopes every downstream write.",
  },
  {
    file: "lib/integrations/connections.ts",
    includes:
      "SELECT profile_id FROM integration_connections WHERE provider = 'health-connect' AND status != 'disconnected'",
    why: "recordUnmatchedHealthConnectPush: attributes a rotated/expired-token push to a profile ONLY when exactly one non-disconnected HC connection exists (else it skips). A cross-profile enumeration by design — the token didn't match, so there is no caller profile; profile_id is selected, not filtered.",
  },
  {
    file: "lib/migrations/versions/038-food-habit-unique.ts",
    includes:
      "SELECT id, profile_id, scope_value FROM frequency_targets WHERE scope_kind = 'food_group'",
    why: "migration 038 one-shot GLOBAL dedupe read: enumerates every profile's food-group frequency targets to collapse duplicates before adding the UNIQUE index — profile_id is carried in the select-list to re-key the dedupe per owner; the UPDATE/DELETE it drives are profile_id-scoped (already allowlisted above).",
  },
  {
    file: "lib/migrations/versions/123-practice-target-unique.ts",
    includes:
      "SELECT id, profile_id, scope_value FROM frequency_targets WHERE scope_kind = 'practice'",
    why: "migration 123 one-shot GLOBAL dedupe read: enumerates every profile's practice targets to collapse normalized-identity duplicates before adding the UNIQUE index — profile_id is carried into the per-owner keeper map, and every mutation it drives is profile-scoped.",
  },
  {
    file: "lib/migrations/versions/148-retire-run-milestones.ts",
    includes: "DELETE FROM milestones",
    why: "migration 148 (#1939) one-shot GLOBAL retirement: the `streak:` and `adherence:` milestone families were retired for EVERY profile at once, so the delete is deliberately unscoped — a per-profile version would leave the ruling half-applied on whichever profiles the loop missed. It can only remove rows the engine no longer mints, and it names the retired discriminators explicitly, so no other profile's milestone (workouts:, goal:, endurance-plan:) is reachable by it.",
  },
  {
    file: "lib/migrations/versions/123-practice-target-unique.ts",
    includes: "SELECT id, profile_id, practice FROM practice_logs ORDER BY id",
    why: "migration 123 one-shot GLOBAL log reconciliation: enumerates practice logs with their profile_id, resolves each against that profile's keeper map, and re-keys each mutation by id AND profile_id; histories never cross profiles.",
  },
  {
    file: "lib/migrations/versions/109-health-connect-token-hash.ts",
    includes:
      "SELECT profile_id, config FROM integration_connections WHERE provider = 'health-connect' AND config IS NOT NULL",
    why: "migration 109 one-shot GLOBAL hash-in-place read (#1209): enumerates every profile's raw-stored Health Connect token to replace it with its SHA-256 — profile_id is carried in the select-list to re-key the UPDATE to each row's owner (the UPDATE is provider + profile_id scoped), never reading one profile's data into another's.",
  },
  {
    file: "lib/migrations/versions/083-metric-sample-origin.ts",
    includes:
      "SELECT profile_id, natural_key FROM import_tombstones WHERE target_table = 'metric_samples'",
    why: "migration 083 one-shot GLOBAL backfill read: reads every profile's metric-sample tombstones to stamp the new origin column — profile_id is carried in the select-list to re-key each row to its owner, never read across profiles.",
  },
  {
    file: "lib/migrations/versions/092-consolidate-imported-prescriptions.ts",
    includes: "FROM medical_records r WHERE r.category = 'prescription'",
    why: "migration 092 one-shot GLOBAL consolidation read: enumerates every profile's imported prescription records; r.profile_id rides in the select-list so the per-row consolidation UPDATEs it drives stay keyed to each record's own owner (a med is projected within one profile's import).",
  },
  {
    file: "lib/migrations/versions/101-recover-blank-name-prescriptions.ts",
    includes: "FROM medical_records r WHERE r.${BLANK_RX_PRED}",
    why: "migration 101 one-shot GLOBAL recovery read: enumerates every profile's blank-name prescription records to recover a name from their linked med; r.profile_id rides in the select-list so the recovery UPDATEs stay keyed to each record's own owner, never read across profiles.",
  },
];

// db.exec() statements that legitimately touch an owned table without a profile_id
// predicate (issue #1208 fix 2), keyed by file. Same SHORT-and-justified discipline
// as ALLOW_SQL. Today this is only the three boot-task reset reaps.
const ALLOW_EXEC: { file: string; includes: string; why: string }[] = [
  {
    file: "lib/migrations/boot-tasks.ts",
    includes:
      "UPDATE medical_documents SET extraction_status = 'failed', extraction_error = 'Extraction was interrupted (server restarted). Delete and re-upload to retry.' WHERE extraction_status IN ('processing','pending')",
    why: "reapStuckExtractions boot reset: a GLOBAL maintenance reaper run once per boot that fails any document a dead process left mid-'processing'/'pending' past its lease — keyed by processing_started_at, never a profile's data (the runtime twin in lib/extraction-reaper.ts is likewise allowlisted).",
  },
  {
    file: "lib/migrations/boot-tasks.ts",
    includes:
      "UPDATE import_jobs SET status = 'failed', error = 'Extraction was interrupted (server restarted). Discard and try again.', updated_at = datetime('now') WHERE status = 'processing'",
    why: "boot reset of import jobs stranded in 'processing' by a restart/crash — GLOBAL maintenance keyed by the stale updated_at lease, deliberately profile-agnostic.",
  },
  {
    file: "lib/migrations/boot-tasks.ts",
    includes:
      "UPDATE import_jobs SET status = 'failed', error = 'Saving this import was interrupted (server restarted).",
    why: "boot reset of import jobs stranded mid-commit in 'committing' (#323) — GLOBAL maintenance keyed by the stale updated_at lease, deliberately profile-agnostic.",
  },
];

// `.prepare(sql)` sites whose argument is a runtime expression (not a string
// literal), so the SQL can't be inspected here. Each is verified by hand to be
// profile-scoped and listed with a justification.
const ALLOW_NON_LITERAL: { file: string; expr: string; why: string }[] = [
  {
    file: "lib/queries/medical/flags.ts",
    expr: "sql",
    why: "reconcileFlags: `sql` starts from a base string that includes WHERE profile_id = ?",
  },
  {
    file: "lib/queries/medical/flags.ts",
    expr: "qsql",
    why: "reconcileFlags qualitative pass (#549): `qsql` starts from a base string that includes WHERE profile_id = ?",
  },
  {
    file: "lib/export.ts",
    expr: "sql",
    why: "q(sql) helper: every DATASETS query string filters the acting profile — directly (WHERE profile_id = ?) or, for the intake dose/log child tables, through the parent JOIN (WHERE ii.profile_id = ?)",
  },
  {
    file: "lib/export-full.ts",
    expr: "MEDIA_ROW_SELECTS[domain]",
    why: "the opt-in media bundle (#1846): five hand-authored literals in one Record keyed by MEDIA_DOMAINS, indexed by the loop variable so the scan sees an expression instead of the strings. Every one opens its WHERE with the exporting profile's own `profile_id = ?` — including the two that JOIN (lesion_photos, activity_videos), where the child row carries its OWN profile_id and the join matches the parent's profile_id too, so a tampered FK cannot pull another profile's label or title into the bundled index. lib/__db_tests__/export-media.test.ts asserts that per declared domain AND proves end-to-end that neither another profile's files nor its parent-row words ever enter the bundle, which is stronger than this scan's per-literal read.",
  },
  {
    file: "lib/providers-db.ts",
    expr: "profileSql",
    why: "getProviderMergeImpact profiles-touched aggregate (#275): a GLOBAL, deliberately profile-AGNOSTIC count across every profile (the admin-only merge shows 'N across M profiles'). `profileSql` is one of two hand-authored strings over the bound PROVIDER_LINK_COLUMNS — the plain SELECT DISTINCT profile_id, or, for the child medication_courses (no own profile_id, #1204), a JOIN to intake_items resolving the parent's profile_id. Neither reads one profile's data into another's — it is the count itself that spans profiles by design.",
  },
  {
    file: "lib/notifications/digest-deps.ts",
    expr: "digestStampSql()",
    why: "the digest reconciler's dependency stamp (#2069): one UNION ALL composed by `digestStampSql` from the declared DIGEST_DEPENDENCIES, whose every arm opens its WHERE with `profile_id = ?` — or, for the child intake_item_logs, with its parent's `i.profile_id = ?` through the JOIN (the child-table convention). Read-only aggregates, no DML. lib/__db_tests__/message-reconcile.test.ts asserts that per declared entry, and that one profile's write cannot move another's stamp, which is stronger than this scan's per-literal read.",
  },
  ...(
    ["upsert", "decrement", "drop", "select", "incrementExisting"] as const
  ).map((expr) => ({
    file: "lib/day-counter-ledger-db.ts",
    expr: `sql.${expr}`,
    why: "the day-counter ledger (#2037): all five statements are compiled by the pure `dayCounterSql` from CONSTANT table/column names, and every one of them is born or filtered profile-scoped — the upsert names profile_id in its column list, the other four open their WHERE with `profile_id = ?`. lib/__tests__/day-counter-ledger.test.ts asserts exactly that, per declared counter, which is a stronger guarantee than this scan's per-literal read.",
  })),
  {
    file: "lib/profile-delete.ts",
    expr: "step.sql",
    why: "the schema-derived profile-delete sweep (#2126): each statement is a DELETE on a CHILD table (no profile_id of its own) whose WHERE reaches profile_id through nested subqueries along its FK path to an OWNED_TABLES parent (table/column names come from sqlite_master, never user input). lib/__db_tests__/profile-delete-fk-scan.test.ts pins the plan's coverage and ordering.",
  },
];

// POSITIONAL profile_id check (issue #1208 fix 1). The old guard passed any
// owned-table statement that merely MENTIONED `profile_id` anywhere — including as a
// bare SELECT column (`SELECT profile_id FROM t WHERE id = ?` is an id-only lookup
// across every profile) or a SET target or a GROUP BY key. This requires `profile_id`
// to appear in a SCOPING position instead: either
//   (a) an INSERT whose target column list names profile_id (the row is born scoped
//       to a profile), or
//   (b) a predicate — `[qualifier.]profile_id` immediately followed by a comparison /
//       set-membership operator (`=`, `IN`, `IS`, `<`, `>`, `BETWEEN`, `LIKE`, …),
//       located AFTER the statement's first WHERE/ON/USING keyword (so a SET-clause
//       `profile_id = ?` before the WHERE, or a select-list/GROUP BY mention, does not
//       count).
// A statement that names an owned table but fails this must be allowlisted with a
// justification, exactly like a statement that omits profile_id entirely.
function scopedByProfileId(sql: string): boolean {
  if (!/\bprofile_id\b/i.test(sql)) return false;
  // (a) INSERT INTO <table> ( … profile_id … ) — born profile-scoped.
  const ins = /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+\w+\s*\(([^)]*)\)/i.exec(sql);
  if (ins && /\bprofile_id\b/i.test(ins[1])) return true;
  // (b) a predicate at/after the first WHERE/ON/USING.
  const predIdx = sql.search(/\b(?:WHERE|ON|USING)\b/i);
  if (predIdx >= 0) {
    const tail = sql.slice(predIdx);
    if (
      /(?:^|[\s.(])profile_id\s*(?:=|<|>|!=|<>|IN\b|IS\b|BETWEEN\b|LIKE\b|GLOB\b)/i.test(
        tail
      )
    )
      return true;
  }
  return false;
}

describe("profile scoping: every owned-table query filters by profile_id", () => {
  const files = sourceFiles();

  it("scans a meaningful number of source files", () => {
    // Guards against a broken glob silently passing the whole suite.
    expect(files.length).toBeGreaterThan(30);
  });

  it("has no owned-table .prepare() statement missing profile_id", () => {
    const violations: string[] = [];

    for (const file of files) {
      const rel = relPath(file);
      const src = readSource(file);
      for (const arg of prepareArgs(src)) {
        if (arg.kind === "expr") {
          const ok = ALLOW_NON_LITERAL.some(
            (a) => rel.endsWith(a.file) && arg.text === a.expr
          );
          if (!ok) {
            violations.push(
              `${rel}: non-literal .prepare(${arg.text}) — cannot verify scoping; allowlist it with a justification if it is safe`
            );
          }
          continue;
        }
        const sql = norm(arg.text);
        if (!OWNED_RE.test(sql)) continue; // no owned table → nothing to enforce
        if (scopedByProfileId(sql)) continue; // profile_id in a scoping position
        const allowed = ALLOW_SQL.some(
          (a) => rel.endsWith(a.file) && sql.includes(a.includes)
        );
        if (!allowed) {
          violations.push(`${rel}: ${sql}`);
        }
      }
    }

    expect(violations, `\n${violations.join("\n")}\n`).toEqual([]);
  });

  // db.exec() blind spot (issue #1208 fix 2). The scanner above only inspects
  // `.prepare(` first-arguments; a `db.exec("…owned-table DML…")` was invisible to
  // it. Extend the SAME owned-table + positional rule to `.exec(` string literals so a
  // future owned-table db.exec write can't evade the guard.
  //
  // SCOPE: the numbered migrations in lib/migrations/versions/ are EXCLUDED from the
  // exec scan. Their db.exec is schema DDL (CREATE/ALTER/DROP/INDEX) and one-shot
  // GLOBAL data moves (copy-rebuilds, vocabulary backfills) by construction — a
  // distinct, reviewed risk class from the runtime query/action surface where a
  // cross-profile leak actually matters, and one already frozen by the immutable
  // hash manifest (a shipped migration can't be edited). The .prepare scan above
  // still covers those files' DML (their id-scoped one-shots are allowlisted). Every
  // OTHER exec site — the boot-task reaps below, and any future query/action db.exec —
  // is in scope; the boot reaps are legitimately global and carry allowlist entries.
  it("has no owned-table db.exec() statement missing profile_id", () => {
    const violations: string[] = [];

    for (const file of files) {
      const rel = relPath(file);
      if (rel.startsWith("lib/migrations/versions/")) continue; // schema/one-shot DDL
      const src = readSource(file);
      for (const arg of execArgs(src)) {
        if (arg.kind !== "sql") continue; // a computed exec arg can't be inspected
        const sql = norm(arg.text);
        if (!OWNED_RE.test(sql)) continue; // no owned table → nothing to enforce
        if (scopedByProfileId(sql)) continue; // profile_id in a scoping position
        const allowed = ALLOW_EXEC.some(
          (a) => rel.endsWith(a.file) && sql.includes(a.includes)
        );
        if (!allowed) {
          violations.push(`${rel}: ${sql}`);
        }
      }
    }

    expect(violations, `\n${violations.join("\n")}\n`).toEqual([]);
  });
});

// UNIT cases for the two #1208 rules, pinned on inline source (no files) so the
// tightened behavior is proven independently of the live tree.
describe("profile-scoping scanner rules (issue #1208)", () => {
  it("positional check: profile_id in the select-list is NOT scoped", () => {
    // The motivating leak — an id-only lookup that happens to select profile_id.
    expect(
      scopedByProfileId("SELECT profile_id FROM medical_records WHERE id = ?")
    ).toBe(false);
    // A SET-clause profile_id (a cross-profile UPDATE filtered only by id) is NOT
    // scoped — the WHERE carries no profile_id predicate.
    expect(
      scopedByProfileId("UPDATE metric_samples SET profile_id = ? WHERE id = ?")
    ).toBe(false);
    // A GROUP BY / ORDER BY mention is not a predicate.
    expect(
      scopedByProfileId(
        "SELECT MAX(id) FROM integration_sync_events GROUP BY profile_id, provider"
      )
    ).toBe(false);
  });

  it("positional check: profile_id in a WHERE/ON predicate or INSERT column list IS scoped", () => {
    expect(
      scopedByProfileId(
        "SELECT * FROM medical_records WHERE profile_id = ? AND id = ?"
      )
    ).toBe(true);
    expect(scopedByProfileId("SELECT * FROM t WHERE profile_id IN (?,?)")).toBe(
      true
    );
    // A JOIN-scoped child read reaches profile_id through the parent's ON condition.
    expect(
      scopedByProfileId(
        "SELECT s.* FROM exercise_sets s JOIN activities a ON a.id = s.activity_id AND a.profile_id = ?"
      )
    ).toBe(true);
    // An INSERT whose target column list names profile_id is born scoped.
    expect(
      scopedByProfileId(
        "INSERT INTO metric_samples (profile_id, metric, value) VALUES (?, ?, ?)"
      )
    ).toBe(true);
    // A cross-profile REASSIGN filters the source profile in its WHERE.
    expect(
      scopedByProfileId(
        "UPDATE medical_records SET profile_id = ? WHERE profile_id = ? AND id = ?"
      )
    ).toBe(true);
  });

  it("db.exec scan: an owned-table exec without an allowlist entry is flagged", () => {
    // Simulate the scan's per-statement decision the way the file loop applies it.
    const flag = (sql: string) =>
      OWNED_RE.test(norm(sql)) && !scopedByProfileId(norm(sql));
    // An owned-table exec DML lacking a profile_id predicate is flagged (would need
    // an ALLOW_EXEC entry or a profile_id WHERE to pass).
    expect(
      flag(
        "UPDATE medical_documents SET extraction_status = 'failed' WHERE id = ?"
      )
    ).toBe(true);
    // A scoped exec passes without any allowlist entry.
    expect(
      flag("DELETE FROM metric_samples WHERE profile_id = ? AND date = ?")
    ).toBe(false);
  });
});

// COMPANION RULE — set-based cross-profile SQL is confined to registered modules
// (issue #1095 §3). The scanner above requires `profile_id` in every owned-table
// query; a set-based `WHERE profile_id IN (…)` statement NAMES profile_id, so it
// already PASSES that rule — nothing there keeps the set-based shape from silently
// spreading to a module that never validated its id list against the caller's grants.
// This rule closes that gap: any `.prepare` matching `profile_id IN` must live in a
// registered cross-profile module (lib/cross-profile.ts → CROSS_PROFILE_SQL_MODULES).
// Everywhere else it fails the scan. The registry is EMPTY today (no set-based reader
// has landed); the pure detector + registry membership are fixture-pinned in
// lib/__tests__/cross-profile.test.ts, so the rule is proven to fire before any real
// consumer exists.
describe("cross-profile scoping: profile_id IN only in registered modules", () => {
  const files = sourceFiles();

  it("has no profile_id IN statement outside a registered cross-profile module", () => {
    const violations: string[] = [];

    for (const file of files) {
      const rel = relPath(file);
      const src = readSource(file);
      for (const arg of prepareArgs(src)) {
        if (arg.kind !== "sql") continue; // non-literal args handled by the rule above
        const sql = norm(arg.text);
        if (!usesProfileIdInList(sql)) continue;
        if (isCrossProfileSqlModule(rel)) continue;
        violations.push(
          `${rel}: uses "profile_id IN" but is not a registered cross-profile module — register it in lib/cross-profile.ts (CROSS_PROFILE_SQL_MODULES) only if it feeds the IN-list from a resolved ProfileScope's ids. SQL: ${sql}`
        );
      }
    }

    expect(violations, `\n${violations.join("\n")}\n`).toEqual([]);
  });
});

// PHI-delete integrity: the owned-table set is defined ONCE in lib/owned-tables.ts
// and consumed by (a) this scoping test, (b) deleteProfile's DELETE loop, and (c)
// backfillProfileIds. Before the shared constant, those were three hand-maintained
// lists nothing forced to agree, and a table forgotten from deleteProfile silently
// leaves a deleted person's PHI behind (profile_id added via addColumnIfMissing
// carries no ON DELETE CASCADE). This block fails the build if the shared const or
// its consumers drift.

const MIGRATION_VERSIONS_DIR = "lib/migrations/versions";

function migrationSources(): string {
  const dir = path.join(REPO, MIGRATION_VERSIONS_DIR);
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{3}-.*\.ts$/.test(f))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

// The tables whose CREATE TABLE block in any numbered migration declares a
// `profile_id` column. Every profile-owned table should be born `profile_id NOT
// NULL` in its CREATE block, so the migration source is the ground truth for
// "directly profile-owned" — adding a profile_id table to the schema WITHOUT
// adding it to OWNED_TABLES fails this test, which is the exact drift Fix 1 exists
// to prevent. `_new` rebuild scratch tables are ignored. Uses a balanced-paren
// scan of each CREATE body.
function tablesDeclaringProfileId(dbSrc: string): Set<string> {
  const out = new Set<string>();
  const re = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(dbSrc))) {
    const name = m[1];
    let i = re.lastIndex;
    let depth = 1;
    let body = "";
    while (i < dbSrc.length && depth > 0) {
      const c = dbSrc[i];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) break;
      }
      body += c;
      i++;
    }
    re.lastIndex = i;
    if (name.endsWith("_new")) continue; // rebuild scratch tables
    if (/\bprofile_id\b/.test(body)) out.add(name);
  }
  return out;
}

// Tables a later migration DROPS and never recreates — they are no longer part of the
// schema, so they must not be expected in OWNED_TABLES even though their (frozen,
// un-editable) CREATE block still sits in an earlier migration's source. The first
// case is `starred_biomarkers`, folded into `saved_items` by migration 113 (#1456).
//
// A table-REBUILD (create scratch → copy → DROP original → RENAME scratch into place)
// also emits a DROP, so a dropped name that is later RENAMEd back into existence is
// NOT retired — that subtraction is what keeps the ~20 rebuild migrations from
// silently emptying the derived set.
function tablesDroppedForGood(dbSrc: string): Set<string> {
  // Comment lines are skipped: migration 006's PROSE discusses "a DROP TABLE
  // intake_items", and a table must never be retired by a sentence about it.
  const code = dbSrc
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");
  const dropped = new Set<string>();
  for (const m of code.matchAll(/DROP TABLE (?:IF EXISTS )?(\w+)/g))
    dropped.add(m[1]);
  for (const m of code.matchAll(/RENAME TO (\w+)/g)) dropped.delete(m[1]);
  return dropped;
}

// profile_id-bearing tables that are intentionally NOT per-profile-OWNED data
// subjects: the login×profile GRANT MATRIX and the per-profile SETTINGS TIER. They
// carry a profile_id FK but hold no health data and are deleted EXPLICITLY by
// deleteProfile (outside the OWNED_TABLES loop — see deleteProfile), so they are
// excluded from OWNED_TABLES by design. Any OTHER profile_id table not in
// OWNED_TABLES is a real omission and must fail the test, not be added here.
const NON_OWNED_PROFILE_ID_TABLES = new Set([
  "login_profiles",
  "profile_settings",
]);

describe("owned-table set: single source of truth (no drift)", () => {
  it("OWNED_TABLES equals the schema's profile_id tables (minus documented globals)", () => {
    const dbSrc = migrationSources();
    const declared = tablesDeclaringProfileId(dbSrc);

    // Guard against a broken parse silently passing: the schema declares many
    // profile_id tables.
    expect(declared.size).toBeGreaterThan(20);

    // The allowlisted globals must genuinely declare profile_id (else the
    // allowlist is masking a typo rather than excluding a real global table).
    for (const t of NON_OWNED_PROFILE_ID_TABLES)
      expect(declared.has(t)).toBe(true);

    const retired = tablesDroppedForGood(dbSrc);
    // Sanity: the retirement rule must not be swallowing live tables (every rebuild
    // migration also emits a DROP, and those names come back via RENAME TO).
    expect([...retired].sort()).toEqual(["starred_biomarkers"]);

    const derivedOwned = [...declared]
      .filter((t) => !NON_OWNED_PROFILE_ID_TABLES.has(t) && !retired.has(t))
      .sort();
    // The schema-derived owned set MUST equal OWNED_TABLES. A new profile_id table
    // added to a migration but forgotten in OWNED_TABLES lands in `derivedOwned`
    // only → this fails, catching the exact orphaned-PHI drift Fix 1 prevents.
    expect(derivedOwned).toEqual([...OWNED_TABLES].sort());
    expect(new Set(OWNED_TABLES).size).toBe(OWNED_TABLES.length);
  });

  // The three consumers must reference the shared constants by NAME (they consume
  // them at runtime, verified by typecheck/build), and must not re-introduce a
  // private hand-maintained owned-table list. `"metric_samples"` /
  // `"upcoming_dismissals"` as standalone quoted tokens only appear inside such a
  // list — never in these files' SQL (which names tables bare inside a larger
  // string), so their presence flags a re-introduced literal.
  const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
  const LIST_SENTINELS = ['"metric_samples"', '"upcoming_dismissals"'];

  it("deleteProfile consumes the derived sweep, which consumes OWNED_TABLES (no private list)", () => {
    // The sweep itself moved to lib/profile-delete.ts (#2126): the child-table set
    // is DERIVED from PRAGMA foreign_key_list over OWNED_TABLES, so neither file
    // may re-introduce a hand-maintained table list.
    const action = read("app/(app)/settings/family/actions.ts");
    expect(action).toContain("deleteProfileData");
    const sweep = read("lib/profile-delete.ts");
    expect(sweep).toContain("OWNED_TABLES");
    for (const s of LIST_SENTINELS) {
      expect(action.includes(s)).toBe(false);
      expect(sweep.includes(s)).toBe(false);
    }
  });
});
