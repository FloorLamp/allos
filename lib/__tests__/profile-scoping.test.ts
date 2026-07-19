import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OWNED_TABLES } from "@/lib/owned-tables";

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

// Extract the first argument of every `.prepare(` call. Returns either the string
// literal's contents (kind "sql") or the raw expression text (kind "expr").
function prepareArgs(src: string): { kind: "sql" | "expr"; text: string }[] {
  const out: { kind: "sql" | "expr"; text: string }[] = [];
  const re = /\.prepare\s*\(/g;
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

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

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
        if (/profile_id/.test(sql)) continue; // scoped
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
