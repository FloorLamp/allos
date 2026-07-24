import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OWNED_TABLES } from "@/lib/owned-tables";
import {
  isCrossProfileSqlModule,
  usesProfileIdInList,
} from "@/lib/cross-profile";

// Static leak-detection for the multi-user conversion. This
// reads the repo's own source as TEXT — no DB, no network, so it stays "pure" in
// the vitest sense — extracts the first argument of every `.prepare(` call, and
// fails if a statement touches a profile-OWNED table without `profile_id`
// appearing in it (child tables reach profile_id via a JOIN to their parent, so a
// statement that joins the parent naturally mentions the parent table + its
// profile_id). It is a coarse guard, not a proof: the SHORT allowlist below
// carves out the handful of statements that are safe for reasons text can't see
// (an id already fetched by a profile-scoped query, or SQL composed at runtime).

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

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
// global settings, canonical_biomarkers, and — added later — `providers`.
// The providers registry is shared across the whole family/instance (a family sees
// one "Quest Diagnostics"), modeled like logins/profiles: the per-record LINK
// (immunizations/medical_records/intake_items.provider_id) lives on a profile-owned
// row and is therefore covered by the rule via those tables, but the shared
// `providers` row it points at is global and its data layer (lib/providers-db) is
// deliberately not profile-scoped.
const OWNED_RE = new RegExp(`\\b(${OWNED_TABLES.join("|")})\\b`);

// Statements that legitimately touch an owned table without profile_id, keyed by
// the file they live in (so an unrelated file can't ride the exemption). Each is
// matched as a normalized-SQL substring. Keep this list SHORT and justified.
const ALLOW_SQL: { file: string; includes: string; why: string }[] = [
  {
    file: "lib/queries/medical.ts",
    includes: "UPDATE medical_records SET flag = ? WHERE id = ?",
    why: "reconcileFlags: the ids are produced by a profile-scoped SELECT in the same function",
  },
  {
    file: "lib/queries/medical.ts",
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
    includes: "DELETE FROM deleted_rows WHERE deleted_at < datetime('now', ?)",
    why: "sweepDeletedRows: the 24h undo-holding purge is GLOBAL by design (one call per hourly tick clears every profile's expired rows), so it is intentionally profile-agnostic",
  },
  {
    file: "lib/undo-delete-db.ts",
    includes:
      "SELECT payload FROM deleted_rows WHERE deleted_at < datetime('now', ?)",
    why: "sweepDeletedRows video-file cleanup (#1290): reads the SAME expiring rows the GLOBAL purge DELETE (above) is about to remove, to unlink their orphaned clip files — profile-agnostic for the identical reason, and each captured path is then re-contained under its domain root before any unlink",
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
    file: "lib/migrations/versions/075-extraction-completed-at.ts",
    includes: "PRAGMA table_info(medical_documents)",
    why: "migration 075 (#1022) ADD COLUMN guard: a schema-shape PRAGMA (does extraction_completed_at already exist?) so the non-version-gated migrate() replay no-ops — reads column metadata, never rows; mirrors migration 071's guard",
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
  {
    file: "lib/migrations/versions/103-canonical-name-abbreviation-consolidation.ts",
    includes:
      "UPDATE OR IGNORE starred_biomarkers SET canonical_name = ? WHERE canonical_name = ? COLLATE NOCASE",
    why: "migration 103 (see above): the same global rename applied to the passport pins, again by vocabulary value across all profiles; OR IGNORE guards the (profile_id, canonical_name) PK against a pre-existing new-name pin.",
  },
  {
    file: "lib/migrations/versions/103-canonical-name-abbreviation-consolidation.ts",
    includes:
      "DELETE FROM starred_biomarkers WHERE canonical_name = ? COLLATE NOCASE",
    why: "migration 103 (see above): drops the now-redundant OLD-name pin left after an OR IGNORE collision — a global vocabulary cleanup by canonical name, not a per-profile read.",
  },
  // ── Positional-rule (#1208 fix 1) additions ─────────────────────────────────
  // These NAME profile_id (so they passed the old "profile_id-anywhere" check) but
  // only outside a WHERE/ON predicate — a select-list column or a GROUP BY key — so
  // the tightened positional rule now flags them. Each is legitimately global or a
  // token-resolution path, verified by hand.
  {
    file: "lib/integrations/connections.ts",
    includes:
      "DELETE FROM integration_sync_events WHERE at < datetime('now', ?)",
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
    file: "lib/queries/medical.ts",
    expr: "sql",
    why: "reconcileFlags: `sql` starts from a base string that includes WHERE profile_id = ?",
  },
  {
    file: "lib/queries/medical.ts",
    expr: "qsql",
    why: "reconcileFlags qualitative pass (#549): `qsql` starts from a base string that includes WHERE profile_id = ?",
  },
  {
    file: "lib/export.ts",
    expr: "sql",
    why: "q(sql) helper: every DATASETS query string filters the acting profile — directly (WHERE profile_id = ?) or, for the intake dose/log child tables, through the parent JOIN (WHERE ii.profile_id = ?)",
  },
  {
    file: "lib/providers-db.ts",
    expr: "profileSql",
    why: "getProviderMergeImpact profiles-touched aggregate (#275): a GLOBAL, deliberately profile-AGNOSTIC count across every profile (the admin-only merge shows 'N across M profiles'). `profileSql` is one of two hand-authored strings over the bound PROVIDER_LINK_COLUMNS — the plain SELECT DISTINCT profile_id, or, for the child medication_courses (no own profile_id, #1204), a JOIN to intake_items resolving the parent's profile_id. Neither reads one profile's data into another's — it is the count itself that spans profiles by design.",
  },
];

function walk(dir: string, out: string[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      walk(p, out);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
}

// The source surfaces to scan: all of lib (minus tests), every server-action
// file, and every route handler.
function sourceFiles(): string[] {
  const all: string[] = [];
  walk(path.join(REPO, "lib"), all);
  walk(path.join(REPO, "app"), all);
  return all.filter((f) => {
    const rel = path.relative(REPO, f);
    if (!f.endsWith(".ts") && !f.endsWith(".tsx")) return false;
    if (rel.includes("__tests__") || f.endsWith(".test.ts")) return false;
    if (rel.startsWith("lib/")) return true;
    return (
      f.endsWith("actions.ts") ||
      f.endsWith("route.ts") ||
      f.endsWith("route.tsx")
    );
  });
}

// Extract the first argument of every call matching `opener` (a global RegExp that
// ends at the call's opening paren, e.g. /\.prepare\s*\(/g or /\.exec\s*\(/g).
// Returns either the string literal's contents (kind "sql") or the raw expression
// text (kind "expr").
function firstStringArgs(
  src: string,
  opener: RegExp
): { kind: "sql" | "expr"; text: string }[] {
  const out: { kind: "sql" | "expr"; text: string }[] = [];
  const re = new RegExp(opener.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i++;
    const q = src[i];
    if (q === "`" || q === '"' || q === "'") {
      // Read to the matching, unescaped closing quote/backtick. Template
      // interpolations in this codebase never contain a backtick, so a naive
      // scan to the next backtick is safe.
      let j = i + 1;
      let buf = "";
      while (j < src.length) {
        const c = src[j];
        if (c === "\\") {
          buf += src[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (c === q) break;
        buf += c;
        j++;
      }
      out.push({ kind: "sql", text: buf });
      re.lastIndex = j + 1;
    } else {
      // Non-literal expression argument: capture up to the matching ')'.
      let depth = 1;
      let j = i;
      let buf = "";
      while (j < src.length && depth > 0) {
        const c = src[j];
        if (c === "(") depth++;
        else if (c === ")") {
          depth--;
          if (depth === 0) break;
        }
        buf += c;
        j++;
      }
      out.push({ kind: "expr", text: buf.trim() });
      re.lastIndex = j;
    }
  }
  return out;
}

// The `.prepare(` and `.exec(` argument extractors (both parametrize firstStringArgs).
const prepareArgs = (src: string) => firstStringArgs(src, /\.prepare\s*\(/g);
const execArgs = (src: string) => firstStringArgs(src, /\.exec\s*\(/g);

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

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
      const rel = path.relative(REPO, file).split(path.sep).join("/");
      const src = fs.readFileSync(file, "utf8");
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
      const rel = path.relative(REPO, file).split(path.sep).join("/");
      if (rel.startsWith("lib/migrations/versions/")) continue; // schema/one-shot DDL
      const src = fs.readFileSync(file, "utf8");
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
      const rel = path.relative(REPO, file).split(path.sep).join("/");
      const src = fs.readFileSync(file, "utf8");
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

    const derivedOwned = [...declared]
      .filter((t) => !NON_OWNED_PROFILE_ID_TABLES.has(t))
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

  it("deleteProfile consumes OWNED_TABLES (no private list)", () => {
    const src = read("app/(app)/settings/family/actions.ts");
    expect(src).toContain("OWNED_TABLES");
    for (const s of LIST_SENTINELS) expect(src.includes(s)).toBe(false);
  });
});
