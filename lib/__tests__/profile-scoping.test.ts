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
  resolveSqlConsts,
  sourceFiles,
  sqlConsts,
  type SqlArg,
} from "./sql-scan";
import {
  DYNAMIC_TABLE_RENAMES,
  MIGRATION_VERSIONS_DIR,
  finalTablesDeclaring,
  migrationFileNames,
  migrationSources,
  tableRenames,
  tablesRetired,
} from "./migration-schema-scan";

// Static leak-detection for the multi-user conversion. This
// reads the repo's own source as TEXT — no DB, no network, so it stays "pure" in
// the vitest sense — extracts the first argument of every `.prepare(` call,
// substitutes the module-scope SQL consts it is composed from (#5117: hoisting a
// read into a const must not cost it the check), and
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
// global settings, canonical_result_definitions, `providers`, and — added later —
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

const VERSIONED_MIGRATION_PREFIX = "lib/migrations/versions/";

function isVersionedMigration(rel: string): boolean {
  return rel.startsWith(VERSIONED_MIGRATION_PREFIX);
}

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
    file: "app/api/activity-video/[id]/route.ts",
    includes:
      "SELECT profile_id, stored_path, poster_path, mime_type FROM activity_videos WHERE id = ?",
    why: "the activity-media serve route resolves the clip owner before gating it with canAccessProfile, matching the cross-profile activity detail page reached from Training Log multi-view; inaccessible and nonexistent rows receive the same 404",
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
      "SELECT s.id AS supply_id, i.profile_id AS profile_id FROM shared_supplies s LEFT JOIN intake_items i ON i.supply_id = s.id",
    why: "countVisiblePools (#2116): the SAME cross-by-construction membership question poolMembers above answers, asked once for the whole cabinet instead of once per bottle. It reads nothing but (supply_id, profile_id) — no name, no dose, no health data — and hands it straight to the pure isPoolVisibleTo rule against the caller's already-resolved accessible set, which is the filter. A LEFT JOIN because an ORPHANED bottle names nobody and must still be countable",
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
      "UPDATE medical_documents SET acquired_identity_id = NULL WHERE acquired_identity_id IN (SELECT id FROM portal_identities WHERE portal_id = ?)",
    why: "deletePortal (#2999): the IDENTITY half of the same acquired-by link the portal null beside it clears, for every binding the removed portal owned. Same operation, same reasoning, same posture — it writes ONLY the provenance column, across profiles by definition, and the documents themselves are untouched",
  },
  {
    file: "lib/portals.ts",
    includes:
      "UPDATE medical_documents SET acquired_identity_id = NULL WHERE acquired_identity_id IN (SELECT id FROM portal_identities WHERE account_id = ?)",
    why: "deletePortalAccount (#2999): dropping a portal LOGIN clears the acquired-by identity link on every document that names one of its bindings, regardless of profile — the same operation one level down from deletePortal's, and the same FK-cascade-plus-explicit-update posture. Writes only the provenance column",
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
      "FROM medical_records WHERE value_num IS NULL AND category = 'lab'",
    why: "boot-time qualitative flag reconcile (#549): a GLOBAL maintenance re-derivation run once per canonical-flags-signature change — a qualitative value classifies the same for every profile (blood type / immunity titer), so it is intentionally profile-agnostic; it only rewrites the row's own flag, never reads across profiles",
  },
  {
    file: "lib/cycling-stream-summary-db.ts",
    includes:
      "SELECT id FROM activity_telemetry WHERE json_extract(stream_summary_json, '$.sig') IS NOT ?",
    why: "reconcileCyclingStreamSummaries (#2292): a GLOBAL maintenance re-derivation in the shape of the boot flag reconcile — a ride's precomputed stream summary is a pure function of that row's OWN streams_json/power_zones_json, so it is the same value whoever owns the ride. Selects ids only, and never reads one profile's data on behalf of another; the two statements it drives are id-scoped (below).",
  },
  {
    file: "lib/cycling-stream-summary-db.ts",
    includes:
      "SELECT streams_json, power_zones_json FROM activity_telemetry WHERE id = ?",
    why: "reconcileCyclingStreamSummaries: the ids come from the global stale-summary SELECT in the same module, and the row is read only to re-derive its own summary",
  },
  {
    file: "lib/cycling-stream-summary-db.ts",
    includes:
      "UPDATE activity_telemetry SET stream_summary_json = ? WHERE id = ?",
    why: "reconcileCyclingStreamSummaries: rewrites only the row's own derived column, keyed by an id from the stale-summary SELECT above",
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
  // getClinicalObservations query also carries an explicit `WHERE profile_id = ?` in its
  // latest-ids CTE).
  {
    file: "lib/queries/medical.ts",
    includes: "AS is_latest FROM medical_records",
    why: "getClinicalObservations: the latest-ids CTE and ${clause} both filter profile_id = ?",
  },
  {
    file: "lib/queries/medical.ts",
    includes: "SELECT COUNT(*) AS n FROM medical_records ${clause}",
    why: "countClinicalObservations (#2116): the same ${clause} the row read above composes, from the same observationSelection — it always begins with 'profile_id = ?', and both CTEs bind it too",
  },
  {
    file: "lib/queries/medical.ts",
    includes: "FROM medical_records WHERE ${where.join(",
    why: "getObservationsForDocument: where[] always begins with 'profile_id = ?'",
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
  // ── Positional-rule (#1208 fix 1) additions ─────────────────────────────────
  // These NAME profile_id (so they passed the old "profile_id-anywhere" check) but
  // only outside a WHERE/ON predicate — a select-list column or a GROUP BY key — so
  // the tightened positional rule now flags them. Each is legitimately global or a
  // token-resolution path, verified by hand.
  {
    file: "lib/integrations/connections.ts",
    includes: "DELETE FROM integration_sync_events WHERE at < ?",
    why: "pruneSyncEvents: a GLOBAL retention prune (one call per tick clears every profile's aged sync events, keeping the newest per (profile_id, source_id)). profile_id appears only in the retained-newest GROUP BY subquery, never a predicate — deliberately profile-agnostic, mirroring sweepDeletedRows/sweepReplayedKeys.",
  },
  {
    file: "lib/integrations/connections.ts",
    includes:
      "SELECT profile_id, config FROM integration_connections WHERE source_id = 'health-connect'",
    why: "resolveHealthConnectProfile: the token→profile resolver for the UNAUTHENTICATED Health Connect push ingest. The caller has no profile context; the presented bearer token IS the identity, constant-time-compared against every stored HC token to find WHOSE data the push lands under — inherently cross-profile, the getShareLinkByToken class. Its result then scopes every downstream write.",
  },
  {
    file: "lib/integrations/connections.ts",
    includes:
      "SELECT profile_id FROM integration_connections WHERE source_id = 'health-connect' AND status != 'disconnected'",
    why: "recordUnmatchedHealthConnectPush: attributes a rotated/expired-token push to a profile ONLY when exactly one non-disconnected HC connection exists (else it skips). A cross-profile enumeration by design — the token didn't match, so there is no caller profile; profile_id is selected, not filtered.",
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
    file: "lib/db.ts",
    expr: "sql",
    why: 'preparedFor(), the compile-and-cache helper behind hoistedStatement(): it compiles whatever SQL its CALLER declared, so there is no literal to read here. Nothing is exempted by this entry — every hoistedStatement("…") site is itself a scanned literal (prepareArgs matches it), so those statements are checked where they are written, exactly as a module-scope db.prepare literal was before.',
  },
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
    why: "q(sql) helper: every DATASETS query string filters the acting profile — directly (WHERE profile_id = ?) or, for the intake dose/log child tables, through the parent JOIN (WHERE ii.profile_id = ?). Not left to that sentence: lib/__db_tests__/export.test.ts seeds two profiles and loops over DATASETS asserting rows() emits none of the OTHER profile's rows — compared by row content, so a dataset that emits no `id`, or aliases the one it has, is judged like any other. The one dataset that loop cannot judge is named in it and asserted exhaustive against the schema-derived ownership set — read that list before trusting this line, because it is where the gap is written down.",
  },
  {
    file: "lib/export.ts",
    expr: "providersSelect(ph)",
    why: "the providers dataset's read: `providers` is a GLOBAL table with no profile_id of its own, so there is no profile filter to check. It is read by an explicit `IN (…)` id list, and that list comes from referencedProviderIds(profileId) — the walk over PROVIDER_LINK_SELECTS, whose arms are the entire profile filter and which this scan cannot read, because the walk prepares a loop variable. So the walk is EXERCISED rather than cited: lib/__db_tests__/export.test.ts builds one case per arm out of the same exported array the walk iterates — seeding that arm's own table with a link to a uniquely named provider, asserting it reaches its own profile's export, and asserting it reaches no other. Loosening any arm's `profile_id = ?` reds that arm's case. The function exists so the placeholder count can vary; its SQL text is one hand-authored literal.",
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

// Statements an unresolved interpolation stands INSIDE OF rather than beside: the
// interpolation occupies a place where an entire SELECT goes, so what is left to read
// is a wrapper and not the statement. Same SHORT-and-justified discipline as the
// lists above; today there are exactly two such sites in the repo.
const ALLOW_COMPOSED: { file: string; sql: string; why: string }[] = [
  {
    file: "lib/export.ts",
    sql: "${sql} LIMIT ? OFFSET ?",
    why: "qPage(sql): the bounded twin of the q(sql) helper allowlisted above, and the same argument — it appends LIMIT/OFFSET to whatever complete SELECT its caller declared, so there is no statement of its own to read here. Every string it is called with is a dataset `select` in the same file, each filtering the acting profile directly (WHERE profile_id = ?) or through the parent JOIN (WHERE ii.profile_id = ?). What CHECKS that is lib/__db_tests__/export.test.ts, which seeds two profiles and loops over DATASETS asserting page() returns none of the other profile's rows. It is a loop over the whole list, not a hand-picked subset — but it is not silently exhaustive either: a dataset the shared fixture seeds no row for, and the one dataset over a GLOBAL table, are NAMED there in two lists, and BOTH are asserted exact — the unseeded one against what the fixture actually seeds, the global one against the property that admits it, which is read off OWNED_TABLES + ownedChildTables(db) rather than off anything lib/export.ts emits. This sentence is worth exactly what those lists leave out, which is why they are in the test rather than in this string.",
  },
  {
    file: "lib/timeline.ts",
    sql: "SELECT DISTINCT date FROM (${timelineDatesUnionSql(includeTrainingEvents)}) WHERE date IS NOT NULL AND date != ''",
    why: "getTimelineDates: the UNION arms ARE the statement, and every one is a hand-authored literal carrying its own `WHERE profile_id = @profileId` — or, for the one child read (intake_item_logs), its parent's `ii.profile_id = @profileId` through the JOIN. The bound name is the caller's profileId and nothing else reaches the arms. What ENFORCES that is structural rather than this sentence: the arms reach the statement only through `timelineDatesUnionSql`, which is also the string lib/__db_tests__/timeline.test.ts splits to build its cases, so an arm cannot enter the statement without entering the test — it seeds a dated row per arm in the arm's own table for a second profile, asserts the row reaches its own profile's calendar, and asserts it reaches no other. Stripping any arm's predicate reds that arm's own case.",
  },
];

// The positions where an unresolved `${…}` stands for an ENTIRE STATEMENT rather than
// for an identifier, a value list or a fragment of a clause. That is the property that
// makes a composed statement unreadable: `${sql} LIMIT ? OFFSET ?` and the same helper
// written `SELECT * FROM (${sql}) LIMIT ? OFFSET ?` are one statement in two
// spellings, and a rule keyed on "begins with an interpolation" reads the first and
// silently drops the second.
//
// This is a LIST of positions, not the category — the difference matters, because a
// position missing from it is dropped silently rather than refused. It refuses: the
// statement IS the interpolation; a derived table (`FROM (${…})`, `JOIN (${…})`); a
// CTE body (`AS (${…})`); a bare compound arm (`UNION`/`UNION ALL`/`INTERSECT`/
// `EXCEPT ${…}`); and an EXISTS subquery. Five places an entire SELECT can also stand
// are NOT reached: a scalar subquery in the select list (`SELECT (${sub}) AS n`),
// `INSERT INTO t (a, b) ${sel}`, `IN (${sub})` / `NOT IN (${sub})`,
// `AS [NOT] MATERIALIZED (${sub})`, and a PARENTHESISED compound arm
// (`UNION (${arm})`). Four of those five have no live instance. `IN (${…})` has many,
// and MOST are a placeholder value list — but not all, which is what this sentence
// used to claim: the representative-window subqueries `representativeIds()` builds
// (lib/representative-ids.ts) are an entire SELECT standing in that position. Widening
// the rule to `IN (${…})` would refuse none of THOSE anyway — every statement hosting
// one names an owned table, and this rule only reaches statements whose readable text
// names none — so it would land solely on value lists, as false positives.
//
// The COMPLEMENTARY class — an interpolation in an IDENTIFIER or value position,
// `DELETE FROM ${table} WHERE …` — is deliberately NOT claimed here. Those statements
// have a readable verb and shape and only a dynamic name; the scan still drops the
// ones whose remaining text names no owned table, exactly as it did before this list
// existed. They concentrate in lib/queries/visit-links.ts, lib/undo-delete-db.ts,
// lib/migrations/cascade-delete.ts and app/(app)/data/manage-actions.ts, where the
// TABLE ITSELF is inside the interpolation, so the statement's table set is genuinely
// unknowable from source. Refusing that whole class is the honest general fix and it
// is a hand-verified justification per site across files this PR does not touch — so
// it is named here rather than smuggled in as a wholesale allowlist. No count is
// written down: four rounds of this PR carried a hand-derived one and it was wrong
// every time, in a sentence nobody re-runs.
const STATEMENT_POSITION = [
  /^\$\{/, // the statement IS the interpolation
  /\b(?:FROM|JOIN)\s*\(\s*\$\{/i, // a derived table
  /\bAS\s*\(\s*\$\{/i, // a CTE body
  /\b(?:UNION(?:\s+ALL)?|INTERSECT|EXCEPT)\s*\$\{/i, // another arm of a compound
  /\bEXISTS\s*\(\s*\$\{/i, // a subquery predicate
];
const interpolatesAStatement = (sql: string) =>
  STATEMENT_POSITION.some((re) => re.test(sql));

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

// A `.prepare` site as the scan reads it: the argument as written, plus the statement
// text after the module-scope consts are substituted (#5117 — hoisting a read into a
// const must not cost it the check).
type Prepared = {
  rel: string;
  kind: "sql" | "expr";
  arg: string;
  sql: string;
  resolved: boolean;
};

function readPrepared(
  rel: string,
  arg: SqlArg,
  consts: Map<string, string>
): Prepared {
  const composed = resolveSqlConsts(
    arg.kind === "expr" ? `\${${arg.text}}` : arg.text,
    consts
  );
  return {
    rel,
    kind: arg.kind,
    arg: arg.text,
    sql: norm(composed.text),
    resolved: composed.resolved,
  };
}

// The three allowlists the decision consults, as a parameter so a caller can ask what
// the decision would be WITHOUT one entry — that is how the staleness cases prove an
// entry is load-bearing rather than merely present.
type Allowlists = {
  sql: typeof ALLOW_SQL;
  nonLiteral: typeof ALLOW_NON_LITERAL;
  composed: typeof ALLOW_COMPOSED;
};
const ALL_ALLOWLISTS: Allowlists = {
  sql: ALLOW_SQL,
  nonLiteral: ALLOW_NON_LITERAL,
  composed: ALLOW_COMPOSED,
};

// THE per-statement decision: a violation string, or null. One function, so the file
// loop and the unit cases at the bottom exercise the same code. A rule the loop
// applies but no case can reach is a rule that deletes green, which is exactly how
// the composed refusal was born toothless.
function classifyPrepared(
  p: Prepared,
  lists: Allowlists = ALL_ALLOWLISTS
): string | null {
  if (p.kind === "expr" && !p.resolved) {
    const ok = lists.nonLiteral.some(
      (a) => p.rel.endsWith(a.file) && p.arg === a.expr
    );
    return ok
      ? null
      : `${p.rel}: non-literal .prepare(${p.arg}) — cannot verify scoping; allowlist it with a justification if it is safe`;
  }
  // An interpolation standing where a whole SELECT goes leaves a WRAPPER to read, not
  // a statement, so "names no owned table" would be an answer about the wrapper.
  // Refuse it rather than drop it: silently unclassified is the state this guard
  // exists to prevent.
  if (!p.resolved && !OWNED_RE.test(p.sql) && interpolatesAStatement(p.sql)) {
    const ok = lists.composed.some(
      (a) => p.rel.endsWith(a.file) && norm(a.sql) === p.sql
    );
    return ok
      ? null
      : `${p.rel}: composed .prepare(\`${p.sql}\`) — an unresolved interpolation stands where an entire statement goes and the readable text names no owned table, so this statement cannot be classified; allowlist it with a justification if it is safe`;
  }
  if (!OWNED_RE.test(p.sql)) return null; // no owned table → nothing to enforce
  if (scopedByProfileId(p.sql)) return null; // profile_id in a scoping position
  const allowed = lists.sql.some(
    (a) => p.rel.endsWith(a.file) && p.sql.includes(a.includes)
  );
  return allowed ? null : `${p.rel}: ${p.sql}`;
}

// Every `.prepare` site on the scanned surface, read once and reused by the scan and
// by the staleness cases.
function livePrepared(): Prepared[] {
  const out: Prepared[] = [];
  for (const file of sourceFiles()) {
    const rel = relPath(file);
    // Numbered migrations are immutable, boot-time schema/data transitions. They
    // intentionally operate across every profile; runtime scoping is not their
    // authorization boundary. Keep the request/runtime surface fully scanned.
    if (isVersionedMigration(rel)) continue;
    const src = readSource(file);
    const consts = sqlConsts(src);
    for (const arg of prepareArgs(src))
      out.push(readPrepared(rel, arg, consts));
  }
  return out;
}

describe("profile scoping: every owned-table query filters by profile_id", () => {
  const files = sourceFiles();

  it("scans a meaningful number of source files", () => {
    // Guards against a broken glob silently passing the whole suite.
    expect(files.length).toBeGreaterThan(30);
  });

  it("has no owned-table .prepare() statement missing profile_id", () => {
    const violations = livePrepared()
      .map((p) => classifyPrepared(p))
      .filter((v): v is string => v !== null);

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
  // hash manifest (a shipped migration can't be edited). The .prepare scan uses the
  // same structural boundary. Every OTHER exec site — the boot-task reaps below,
  // and any future query/action db.exec —
  // is in scope; the boot reaps are legitimately global and carry allowlist entries.
  it("has no owned-table db.exec() statement missing profile_id", () => {
    const violations: string[] = [];

    for (const file of files) {
      const rel = relPath(file);
      if (isVersionedMigration(rel)) continue; // schema/one-shot DDL/data moves
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
        "SELECT MAX(id) FROM integration_sync_events GROUP BY profile_id, source_id"
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

// UNIT cases for the composed-statement rules (#5117), pinned on inline source so
// they hold independently of the live tree. The regression they exist for: hoisting
// the activities read into a const turned a statement the scan READ into a template
// whose text named no table, and the scan dropped it — no violation, no allowlist
// entry, nothing to notice. A mutant that removed `WHERE profile_id = ?` from that
// const was green here while export.test.ts still caught it behaviourally.
describe("composed-statement scanning (#5117)", () => {
  const SOURCE = [
    "const SEL = `SELECT id FROM activities WHERE profile_id = ?`;",
    "const LEAK = `SELECT id FROM activities WHERE ? IS NOT NULL`;",
    "db.prepare(`${SEL} LIMIT ? OFFSET ?`);",
    "db.prepare(SEL);",
    "db.prepare(`${LEAK} LIMIT ? OFFSET ?`);",
    "function f() {",
    "  const LOCAL = `SELECT id FROM activities WHERE profile_id = ?`;",
    "  db.prepare(`${LOCAL} LIMIT ?`);",
    "  db.prepare(`${runtime} LIMIT ?`);",
    "}",
  ].join("\n");
  const consts = sqlConsts(SOURCE);
  const read = prepareArgs(SOURCE).map((arg) =>
    resolveSqlConsts(arg.kind === "expr" ? `\${${arg.text}}` : arg.text, consts)
  );
  const sqlAt = (i: number) => norm(read[i].text);

  it("substitutes a module-scope SQL const into a template statement", () => {
    expect(sqlAt(0)).toBe(
      "SELECT id FROM activities WHERE profile_id = ? LIMIT ? OFFSET ?"
    );
    expect(OWNED_RE.test(sqlAt(0))).toBe(true);
    expect(scopedByProfileId(sqlAt(0))).toBe(true);
  });

  it("substitutes a bare-identifier .prepare argument too", () => {
    expect(sqlAt(1)).toBe("SELECT id FROM activities WHERE profile_id = ?");
    expect(scopedByProfileId(sqlAt(1))).toBe(true);
  });

  it("a composed read that lost its profile filter is a violation again", () => {
    // The mutant: `WHERE profile_id = ?` becomes `WHERE ? IS NOT NULL` inside the
    // const. Before resolution the page read named no owned table and was dropped.
    expect(OWNED_RE.test(sqlAt(2))).toBe(true);
    expect(scopedByProfileId(sqlAt(2))).toBe(false);
  });

  it("a function-local const stays unresolved (module scope is what makes it sound)", () => {
    expect(read[3].resolved).toBe(false);
    expect(sqlAt(3)).toBe("${LOCAL} LIMIT ?");
  });

  it("a statement beginning inside an unresolved interpolation is refused, not dropped", () => {
    // Neither the verb nor the table is readable, so "names no owned table" would be
    // an answer about the fragment. The DECISION is asserted, not just the text it
    // reads: a rule no case can reach is a rule that deletes green.
    expect(read[4].resolved).toBe(false);
    expect(OWNED_RE.test(sqlAt(4))).toBe(false);
    expect(refusalFor("lib/some-module.ts", sqlAt(4))).toMatch(
      /cannot be classified/
    );
  });

  it("the refusal is about WHERE the interpolation stands, not where it is written", () => {
    // qPage written the other plausible way. Valid SQLite, same semantics, and the
    // "begins with an interpolation" rule this replaced read it as classifiable and
    // dropped it silently.
    const wrapped = "SELECT * FROM (${sql}) LIMIT ? OFFSET ?";
    expect(interpolatesAStatement(wrapped)).toBe(true);
    expect(refusalFor("lib/some-module.ts", wrapped)).toMatch(
      /cannot be classified/
    );
    // A CTE body is the same case.
    expect(
      refusalFor("lib/some-module.ts", "WITH t AS (${sub}) SELECT * FROM t")
    ).toMatch(/cannot be classified/);
    // An interpolation in an IDENTIFIER or value position is NOT this rule's
    // business: the verb and the shape are readable, only a name is dynamic.
    expect(
      classifyPrepared(
        mkPrepared("lib/some-module.ts", "DELETE FROM ${table} WHERE id = ?")
      )
    ).toBeNull();
    expect(
      classifyPrepared(
        mkPrepared("lib/some-module.ts", "SELECT ${cols} FROM weather_days")
      )
    ).toBeNull();
  });

  it("an ALLOW_COMPOSED entry is what makes its own statement pass", () => {
    // Without the list the refusal fires; with it, in the file that owns the entry,
    // the same statement passes. Delete the branch and the first goes null; delete
    // the array and the second becomes a violation.
    for (const entry of ALLOW_COMPOSED) {
      const p = mkPrepared(entry.file, norm(entry.sql));
      expect(classifyPrepared(p, without({ composed: [] }))).toMatch(
        /cannot be classified/
      );
      expect(classifyPrepared(p)).toBeNull();
    }
  });

  it("every ALLOW_COMPOSED entry is justified and still matches a live statement", () => {
    for (const entry of ALLOW_COMPOSED) {
      expect(entry.why.trim().length).toBeGreaterThan(0);
      expect(interpolatesAStatement(norm(entry.sql))).toBe(true);
      const src = readSource(path.join(REPO, entry.file));
      const fileConsts = sqlConsts(src);
      const matches = prepareArgs(src).some(
        (arg) =>
          arg.kind === "sql" &&
          norm(resolveSqlConsts(arg.text, fileConsts).text) === norm(entry.sql)
      );
      expect(
        matches,
        `${entry.file}: ${entry.sql} matches no .prepare site`
      ).toBe(true);
    }
  });
});

// A statement the scan has already read, for the unit cases above: they ask what the
// DECISION is, so they need a Prepared and not a string.
function mkPrepared(rel: string, sql: string): Prepared {
  return { rel, kind: "sql", arg: sql, sql, resolved: !sql.includes("${") };
}
// The refusal a statement draws, or a readable stand-in for "none" — so a rule that
// stops firing fails with the silence it caused, rather than with a type error.
const refusalFor = (rel: string, sql: string) =>
  classifyPrepared(mkPrepared(rel, sql)) ??
  "(no violation — the statement was silently dropped)";
const without = (over: Partial<Allowlists>): Allowlists => ({
  ...ALL_ALLOWLISTS,
  ...over,
});

// WHY an ALLOW_SQL entry exempts nothing — null when it is load-bearing. THREE
// reasons, and they need DIFFERENT fixes, so each verdict says which. An entry that
// merely OVERLAPS others is one of a set and "delete them" (what this said until R4)
// named every member — follow it and requireItemWriteAccess's owner-resolution read
// becomes an unexplained violation; the message names the partners and asks for ONE
// of the set to survive, which is the n-way statement and not a two-way one. And the
// UNNECESSARY verdict is deliberately not an unqualified "delete it": see the note on
// it below. Pure in its inputs so the cases below can drive it with synthetic
// statements rather than waiting for the tree to grow one.
function staleReason(
  entry: (typeof ALLOW_SQL)[number],
  list: typeof ALLOW_SQL,
  statements: Prepared[]
): string | null {
  const lists = (sql: typeof ALLOW_SQL): Allowlists => ({
    ...ALL_ALLOWLISTS,
    sql,
  });
  const covers = (e: (typeof ALLOW_SQL)[number], p: Prepared) =>
    p.rel.endsWith(e.file) && p.sql.includes(e.includes);
  const mine = statements.filter((p) => p.rel.endsWith(entry.file));
  const rest = list.filter((e) => e !== entry);
  if (
    mine.some(
      (p) =>
        classifyPrepared(p, lists(list)) === null &&
        classifyPrepared(p, lists(rest)) !== null
    )
  )
    return null;
  const matched = mine.filter((p) => covers(entry, p));
  if (matched.length === 0)
    return "no live statement matches this entry — delete it";
  const gated = matched.filter((p) => classifyPrepared(p, lists([])) !== null);
  // NOT an unqualified "delete it". `scopedByProfileId` accepts a bare
  // `profile_id IS NOT NULL` as scoping (#5243, out of scope here), and four live
  // statements pass on nothing else — so this verdict can land on an entry that is
  // the only written record of a deliberately unscoped read, on a hollow pass. Say
  // what to check before deleting.
  if (gated.length === 0)
    return "the statement it matches passes the scan on its own — before deleting, read WHAT makes it pass: scopedByProfileId still accepts a bare `profile_id IS NOT NULL` existence check as scoping (#5243), so confirm a real filter binds the profile and not merely a NOT NULL test. If it is the existence check, the statement is unscoped and this entry is its documentation — keep it";
  const overlap = rest.filter((e) => gated.some((p) => covers(e, p)));
  if (overlap.length > 0)
    return `${overlap.length} other ${overlap.length === 1 ? "entry covers" : "entries cover"} the same statement — keep exactly ONE of this entry and ${overlap.length === 1 ? "that one" : "those"}, and delete the rest: ${overlap
      .map((e) => `${e.file}: "${e.includes}"`)
      .join(" | ")}`;
  return "exempts nothing the scan asks about — delete it";
}

// STALENESS, for all three lists (#5117 R4). An allowlist entry is a claim about the
// tree, and a claim nothing re-checks stops being true quietly: the `listPortalIdentities`
// entry this PR first added was a strict SUFFIX of one that already covered the same
// statement, and nothing was red. So each entry must be LOAD-BEARING — some live
// statement in its own file passes with the list and is a violation without that one
// entry. A redundant entry fails this, and so does an entry whose statement is gone.
describe("the scan's allowlists stay load-bearing (#5117)", () => {
  const live = livePrepared();
  const bearing = (
    file: string,
    over: (all: Allowlists) => Allowlists
  ): boolean =>
    live
      .filter((p) => p.rel.endsWith(file))
      .some(
        (p) =>
          classifyPrepared(p) === null &&
          classifyPrepared(p, over(ALL_ALLOWLISTS)) !== null
      );

  it("every ALLOW_SQL entry is justified and is the reason a live statement passes", () => {
    const dead: string[] = [];
    for (const entry of ALLOW_SQL) {
      expect(entry.why.trim().length).toBeGreaterThan(0);
      const stale = staleReason(entry, ALLOW_SQL, live);
      if (stale) dead.push(`${entry.file}: "${entry.includes}" — ${stale}`);
    }
    expect(
      dead,
      `\nALLOW_SQL entries that exempt nothing. Each line says which fix it needs — an entry that another one OVERLAPS names its partner, and deleting both would turn that statement back into an unexplained violation:\n${dead.join("\n")}\n`
    ).toEqual([]);
  });

  // The two shapes, on synthetic statements, because the tree carries neither today
  // and the instruction is the whole point: one says delete, the other says keep one.
  it("says WHICH fix a stale entry needs: gone, redundant, or unnecessary", () => {
    const file = "lib/fake-module.ts";
    const unscoped = mkPrepared(
      file,
      "SELECT id FROM metric_samples WHERE token = ?"
    );
    const entry = {
      file,
      includes: "SELECT id FROM metric_samples WHERE token = ?",
      why: "a resolve-then-gate read",
    };
    // Load-bearing: the statement passes with the entry and violates without it.
    expect(staleReason(entry, [entry], [unscoped])).toBeNull();
    // Gone: nothing in the file matches it any more.
    expect(staleReason(entry, [entry], [])).toMatch(
      /no live statement matches this entry — delete it/
    );
    // Redundant: a SUFFIX entry covering the same statement — the shape that made the
    // `listPortalIdentities` entry invisible. Both are named, and each names the other.
    const suffix = {
      file,
      includes: "FROM metric_samples WHERE token = ?",
      why: "the same statement, spelled shorter",
    };
    const pair = [entry, suffix];
    for (const [e, other] of [
      [entry, suffix],
      [suffix, entry],
    ] as const) {
      const reason = staleReason(e, pair, [unscoped]);
      expect(reason).toMatch(/1 other entry covers the same statement/);
      expect(reason).toContain(other.includes);
    }
    // THREE covering the same statement: the message has to say keep ONE of the
    // three, not "delete the other" — the singular wording read as an instruction to
    // delete two of them and was true of neither.
    const shorter = {
      file,
      includes: "metric_samples WHERE token = ?",
      why: "the same statement, shorter still",
    };
    const trio = [entry, suffix, shorter];
    const threeWay = staleReason(entry, trio, [unscoped]);
    expect(threeWay).toMatch(/2 other entries cover the same statement/);
    expect(threeWay).toMatch(/keep exactly ONE of this entry and those/);
    expect(threeWay).toContain(suffix.includes);
    expect(threeWay).toContain(shorter.includes);
    // Unnecessary: the statement it matches needs no exemption at all.
    const scopedStmt = mkPrepared(
      file,
      "SELECT id FROM metric_samples WHERE profile_id = ?"
    );
    const broad = { file, includes: "FROM metric_samples", why: "unnecessary" };
    // …and the verdict names what to verify FIRST rather than saying delete it: a
    // statement can pass on `profile_id IS NOT NULL` alone (#5243), in which case the
    // entry is the only record that the read is deliberately unscoped.
    const unnecessary = staleReason(broad, [broad], [scopedStmt])!;
    // Pinned on what the verdict ASKS FOR, not on the absence of one spelling of
    // "delete it": "…passes the scan on its own. Delete it. (#5243)" satisfied that
    // negative. It has to send the reader to check WHAT makes the statement pass
    // before deleting, and to say the entry survives when the answer is the bare
    // existence check.
    expect(unnecessary).toMatch(/passes the scan on its own/);
    expect(unnecessary).toMatch(/before deleting, read WHAT makes it pass/);
    expect(unnecessary).toMatch(/keep it$/);
    expect(unnecessary).toContain("#5243");
  });

  it("every ALLOW_NON_LITERAL entry is justified and is the reason a live statement passes", () => {
    const dead: string[] = [];
    for (const entry of ALLOW_NON_LITERAL) {
      expect(entry.why.trim().length).toBeGreaterThan(0);
      const needed = bearing(entry.file, (all) => ({
        ...all,
        nonLiteral: all.nonLiteral.filter((e) => e !== entry),
      }));
      if (!needed) dead.push(`${entry.file}: .prepare(${entry.expr})`);
    }
    expect(
      dead,
      `\nALLOW_NON_LITERAL entries matching no live non-literal .prepare site. Delete them:\n${dead.join("\n")}\n`
    ).toEqual([]);
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
      if (isVersionedMigration(rel)) continue;
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

// The corpus is read by lib/__tests__/migration-schema-scan.ts — EVERY migration file,
// both naming eras, with rebuild scratch tables and renames resolved before retirement.
// It used to be read here, filtered to `/^\d{3}-/`: the CLOSED numbered era only. That
// filter was keyed to a naming convention rather than to the schema, so the moment
// migrations became name-keyed at 185 this guard went blind to every table born after —
// which is precisely the drift it exists to catch (#2995). #2981 bought back the
// narrowest piece of it (a second, additive read of the name-keyed files, just so
// registering `fasts` had schema evidence behind it) and deferred the rest here.

// The tables whose CREATE TABLE block declares a `profile_id` column, under their
// final-schema names. Every profile-owned table is born `profile_id NOT NULL` in its
// CREATE block, so the migration source is the ground truth for "directly profile-owned"
// — adding a profile_id table to the schema WITHOUT adding it to OWNED_TABLES fails this
// test, which is the exact drift Fix 1 exists to prevent.
function tablesDeclaringProfileId(dbSrc: string): Set<string> {
  return finalTablesDeclaring(dbSrc, (body) => /\bprofile_id\b/.test(body));
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

// The one derivation: every profile_id table the schema has today, minus the two
// documented non-owned ones. Pure in its input, so the unit block below can run it over
// SYNTHETIC migration text and prove both directions — a new owned table fails the build,
// a rebuild scratch or a documented non-owned table does not.
function derivedOwnedTables(dbSrc: string): string[] {
  return [...tablesDeclaringProfileId(dbSrc)]
    .filter((t) => !NON_OWNED_PROFILE_ID_TABLES.has(t))
    .sort();
}

describe("owned-table set: single source of truth (no drift)", () => {
  it("reads every migration in the directory, in both naming eras", () => {
    // The blind spot itself (#2995), pinned. `/^\d{3}-/` matched the CLOSED numbered
    // era only, so 17 name-keyed migrations were invisible to the derivation below —
    // and a guard that cannot see a migration cannot fail on what it declares. This
    // asserts the enumeration by SUBTRACTION (every .ts but the registry), so a third
    // naming era is covered the day it starts rather than the day someone notices.
    const files = migrationFileNames();
    const onDisk = fs
      .readdirSync(path.join(REPO, MIGRATION_VERSIONS_DIR))
      .filter((f) => f.endsWith(".ts"));
    expect(files).toEqual(onDisk.filter((f) => f !== "index.ts").sort());
    expect(files.some((f) => /^\d{3}-/.test(f))).toBe(true);
    expect(files.some((f) => !/^\d{3}-/.test(f))).toBe(true);
  });

  it("OWNED_TABLES equals the schema's profile_id tables (minus documented globals)", () => {
    const dbSrc = migrationSources();
    const declared = tablesDeclaringProfileId(dbSrc);

    // Guard against a broken parse silently passing: the schema declares many
    // profile_id tables.
    expect(declared.size).toBeGreaterThan(20);

    // Tables BORN in each era must both be present, or the corpus read has silently
    // narrowed again: `metric_samples` from the numbered era, `fasts` (#2756) from the
    // name-keyed one — the first genuinely new owned table after the era changed, and
    // the one whose omission this guard failed to catch.
    expect(declared.has("metric_samples")).toBe(true);
    expect(declared.has("fasts")).toBe(true);

    // The allowlisted globals must genuinely declare profile_id (else the
    // allowlist is masking a typo rather than excluding a real global table).
    for (const t of NON_OWNED_PROFILE_ID_TABLES)
      expect(declared.has(t)).toBe(true);

    // Sanity: the retirement rule must not be swallowing live tables. Every rebuild
    // migration also emits a DROP (those names come back via RENAME TO), and
    // `substance_log`'s DROP is a RENAME in disguise — it is the case that makes the
    // rename-before-retire ordering load-bearing, since resolving it the other way
    // round retires the live `substance_daily_totals`.
    const renames = tableRenames(dbSrc);
    expect([...tablesRetired(dbSrc, renames)].sort()).toEqual([
      "starred_biomarkers",
    ]);
    for (const from of DYNAMIC_TABLE_RENAMES.keys())
      expect(renames.get(from)).toBe(DYNAMIC_TABLE_RENAMES.get(from));

    // The schema-derived owned set MUST equal OWNED_TABLES. A new profile_id table
    // added to a migration but forgotten in OWNED_TABLES lands in `derivedOwned`
    // only → this fails, catching the exact orphaned-PHI drift Fix 1 prevents.
    expect(derivedOwnedTables(dbSrc)).toEqual([...OWNED_TABLES].sort());
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

  // BOTH DIRECTIONS, on SYNTHETIC migration text (#2995). The live corpus can only ever
  // show that the derivation agrees with OWNED_TABLES today; these show what it DOES when
  // the corpus changes, which is the property the guard is actually for. Each fixture is
  // written in the name-keyed era's shape — the era the old `/^\d{3}-/` read could not
  // see at all.
  const NEW_OWNED = `
    db.exec(\`CREATE TABLE sleep_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL
    );\`);`;

  it("MUST fail the build: a new owned table born in the name-keyed era", () => {
    // The whole point. An unregistered profile_id table is a table deleteProfile's
    // per-OWNED_TABLES sweep skips — orphaned PHI, since the sweep runs with
    // foreign_keys OFF and the CASCADE above never fires (#729).
    expect(derivedOwnedTables(NEW_OWNED)).toEqual(["sleep_sessions"]);
  });

  it("MUST NOT fail the build: a rebuild scratch table", () => {
    // create scratch → copy → drop original → rename scratch into place. The scratch is
    // never a table in its own right; only `activities` is. Note the name matches NO
    // `_new` suffix rule — `…__new_2878` and `…__new011` are both real scratch shapes in
    // this corpus, which is why scratch is recognised by BEING RENAMED AWAY instead.
    const rebuild = `
      db.exec(\`CREATE TABLE activities__rebuild_2999 (
        id INTEGER PRIMARY KEY,
        profile_id INTEGER NOT NULL
      );
      INSERT INTO activities__rebuild_2999 SELECT id, profile_id FROM activities;
      DROP TABLE activities;
      ALTER TABLE activities__rebuild_2999 RENAME TO activities;\`);`;
    expect(derivedOwnedTables(rebuild)).toEqual(["activities"]);
  });

  it("MUST NOT fail the build: a documented non-owned table re-declared by a rebuild", () => {
    // The grant matrix and settings tier carry profile_id and are deleted explicitly,
    // outside the OWNED_TABLES loop. #2981's additive post-era read unioned its half in
    // RAW, so a name-keyed migration rebuilding `profile_settings` would have turned this
    // suite red demanding a table the file documents as deliberately non-owned. One
    // derivation with one filter is what closes that.
    const rebuilt = `
      db.exec(\`CREATE TABLE profile_settings__new_2999 (
        profile_id INTEGER NOT NULL,
        key TEXT NOT NULL
      );
      DROP TABLE profile_settings;
      ALTER TABLE profile_settings__new_2999 RENAME TO profile_settings;\`);`;
    expect(derivedOwnedTables(rebuilt)).toEqual([]);
  });

  it("MUST NOT fail the build: a table retired for good", () => {
    const retired = `
      db.exec(\`CREATE TABLE starred_things (id INTEGER, profile_id INTEGER);\`);
      db.exec(\`DROP TABLE starred_things;\`);`;
    expect(derivedOwnedTables(retired)).toEqual([]);
  });

  it("MUST NOT fail the build: an owned table rebuilt across eras into a NEW name", () => {
    // `substance_log` → `substance_daily_totals`, the shape that makes the ordering
    // load-bearing: the DROP lives in a name-keyed migration, the CREATE in a numbered
    // one, and the successor arrives only through the scratch's RENAME TO. Retire before
    // resolving the rename and the live table vanishes from the derived set — the guard
    // lying in the direction nobody would notice.
    const crossEra = `
      db.exec(\`CREATE TABLE substance_log (id INTEGER, profile_id INTEGER);\`);
      db.exec(\`CREATE TABLE substance_daily_totals_new (id INTEGER, profile_id INTEGER);
      INSERT INTO substance_daily_totals_new SELECT id, profile_id FROM substance_log;
      DROP TABLE substance_log;
      ALTER TABLE substance_daily_totals_new RENAME TO substance_daily_totals;\`);`;
    expect(derivedOwnedTables(crossEra)).toEqual(["substance_daily_totals"]);
  });

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
