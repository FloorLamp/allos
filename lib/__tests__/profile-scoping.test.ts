import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OWNED_TABLES, BACKFILL_OWNED_TABLES } from "@/lib/owned-tables";

// Static leak-detection for the multi-user conversion (issue #67, Phase 2). This
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
// intake_item_doses / _logs / _pairs and, added in #209, the medication history
// tables `medication_courses` + `intake_item_side_effects` — are reached this way:
// their READ queries JOIN intake_items and filter ii.profile_id = ?, and their
// child-only writes (WHERE item_id = ?) are guarded by a prior profile-scoped
// ownership check on the parent intake_items row. Both #209 tables FK item_id →
// intake_items(id) ON DELETE CASCADE, so deleteProfile (and the #203 document
// delete) clear them via the parent.
//
// GLOBAL tables are intentionally absent, so a statement touching only one of them
// is never flagged: logins, profiles, login_profiles, sessions, login_attempts,
// global settings, canonical_biomarkers, and — added in issue #178 — `providers`.
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
    file: "lib/db.ts",
    includes: "UPDATE medical_records SET flag = ? WHERE id = ?",
    why: "boot-time reconcile: ids come from a per-profile SELECT (rowsStmt)",
  },
  {
    file: "lib/db.ts",
    includes: "UPDATE medical_records SET flag = NULL WHERE id = ?",
    why: "boot-time reconcile: ids come from a per-profile SELECT (rowsStmt)",
  },
  {
    file: "lib/integrations/normalize.ts",
    includes: "UPDATE body_metrics SET weight_kg",
    why: "upsertBodyMetrics: the id comes from a profile-scoped find() just above",
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
  // db.ts one-time, pre-profile-scoping data migrations that intentionally rewrite
  // EVERY profile's rows (vocabulary/file-hash/legacy-dose migrations run once at
  // boot and are profile-agnostic by design).
  {
    file: "lib/db.ts",
    includes:
      "SELECT id, stored_path FROM medical_documents WHERE content_hash IS NULL",
    why: "backfillDocumentHashes: hashes files on disk for all documents (global, one-time)",
  },
  {
    file: "lib/db.ts",
    includes: "UPDATE medical_documents SET content_hash = ? WHERE id = ?",
    why: "backfillDocumentHashes: id from the global SELECT above",
  },
  {
    file: "lib/db.ts",
    includes:
      "SELECT id, components FROM activities WHERE components IS NOT NULL",
    why: "migrateLiftMerges: renames legacy lift names across all rows (global, one-time)",
  },
  {
    file: "lib/db.ts",
    includes: "UPDATE activities SET components = ? WHERE id = ?",
    why: "migrateLiftMerges: id from the global SELECT above",
  },
  {
    file: "lib/db.ts",
    includes: "${dosageSel}",
    why: "migrateSupplementDoses: reads legacy dosage/time off all supplements once (global)",
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
    file: "lib/share-links-db.ts",
    includes: "FROM profile_share_links WHERE token_hash = ?",
    why: "getShareLinkByToken: the ONLY entry point for the unauthenticated public share route — the caller has no profile context yet; the lookup is by the unguessable 256-bit token's SHA-256, and the returned row's profile_id then scopes every downstream read",
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

// The tables whose CREATE TABLE block in lib/db.ts declares a `profile_id` column.
// Every profile-owned table is born `profile_id NOT NULL` in its CREATE block on a
// fresh DB (upgraded DBs additionally get it via addColumnIfMissing), so the schema
// itself is the ground truth for "directly profile-owned" — deriving from it means
// adding a profile_id table to db.ts WITHOUT adding it to OWNED_TABLES fails this
// test, which is the exact drift Fix 1 exists to prevent. `_new` rebuild scratch
// tables are ignored. Uses a balanced-paren scan of each CREATE body.
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
  it("OWNED_TABLES equals db.ts's profile_id tables (minus documented globals)", () => {
    const dbSrc = fs.readFileSync(path.join(REPO, "lib/db.ts"), "utf8");
    const declared = tablesDeclaringProfileId(dbSrc);

    // Guard against a broken parse silently passing: db.ts declares many
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
    // added to db.ts but forgotten in OWNED_TABLES lands in `derivedOwned` only →
    // this fails, catching the exact orphaned-PHI drift Fix 1 prevents.
    expect(derivedOwned).toEqual([...OWNED_TABLES].sort());
    expect(new Set(OWNED_TABLES).size).toBe(OWNED_TABLES.length);
  });

  it("BACKFILL_OWNED_TABLES is a duplicate-free subset of OWNED_TABLES", () => {
    expect(new Set(BACKFILL_OWNED_TABLES).size).toBe(
      BACKFILL_OWNED_TABLES.length
    );
    const owned = new Set<string>(OWNED_TABLES);
    for (const t of BACKFILL_OWNED_TABLES) expect(owned.has(t)).toBe(true);
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

  it("db.ts consumes BACKFILL_OWNED_TABLES for the profile_id backfill", () => {
    const src = read("lib/db.ts");
    expect(src).toContain("BACKFILL_OWNED_TABLES");
  });
});
