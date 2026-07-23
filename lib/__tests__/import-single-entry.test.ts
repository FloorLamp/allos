import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IMPORT_FOOTPRINT_TABLES } from "@/lib/import-footprint";

// Single-entry enforcement for the document-import write path (#453 item 1, folding
// in #422 item 1). The import pipeline's abstraction is sound — persistDocumentImport
// is the ONE write core and IMPORT_FOOTPRINT_TABLES derives clear/reassign/count off
// one list — but every recent import bug was an ESCAPE HATCH, a write that bypassed
// the core (the paste path #418, unbound inserts #422), not a flaw in the core. This
// test converts the last prose rule of the pipeline into CI: it reads the repo's own
// source as TEXT (no DB, no network — pure in the vitest sense), finds every
// `.prepare(...)` INSERT that binds a `document_id` column, and fails if one lives
// anywhere but lib/import-persist.ts. A future insert added to a footprint table
// without going through the persist core is invisible to clear/move/count; this makes
// that impossible rather than merely tested-today.
//
// The DOCUMENTLESS paste path (#439) is covered by construction, not by exemption:
// it shares insertImportRows (in lib/import-persist.ts) and binds a NULL document_id
// through the SAME prepared statement, so the location rule already accounts for it —
// there is no separate insert to allowlist. A documentless import is deliberately
// exempt from the clear/reassign/tally FOOTPRINT contract (no document to delete or
// reassign), but that is a runtime consequence of the NULL id, not a source-scan
// escape: the write still originates in the persist core.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// The tables the footprint contract owns, so the scan can additionally assert that
// a document_id-binding INSERT targets a table clear/move/count actually handle — a
// document_id written into an UNLISTED table would be a footprint blind spot.
const FOOTPRINT_TABLE_NAMES = new Set(
  IMPORT_FOOTPRINT_TABLES.map((t) => t.table)
);

// The ONE file allowed to bind a document_id on insert: the persist core.
const PERSIST_FILE = "lib/import-persist.ts";

// document_id-binding INSERTs that legitimately live OUTSIDE the persist core, keyed
// by file + a normalized-SQL substring (mirrors profile-scoping.test.ts's ALLOW_SQL).
// Empty today — every import write goes through the core. Keep it SHORT and justified.
const ALLOW: { file: string; includes: string; why: string }[] = [
  {
    file: "lib/migrations/versions/092-consolidate-imported-prescriptions.ts",
    includes:
      "INSERT INTO intake_items (name, notes, active, condition, priority, kind, as_needed",
    why: "migration 092 (#1178) one-shot consolidation: projects each UNPAIRED legacy prescription record into a footprint-scoped extracted med (source='extracted' + document_id) — the exact projection the persist core does, applied once at upgrade time. intake_items is a footprint table, so clear/reassign/count already handle these rows; a migration is a schema/data converge run once behind the user_version gate, not a runtime import bypass.",
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

// The same source surfaces the profile-scoping guard scans: all of lib (minus
// tests), every server-action file, and every route handler.
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

// Extract the STRING-LITERAL argument of every `.prepare(` call (the same balanced
// scan profile-scoping.test.ts uses). Non-literal (runtime-built) prepare arguments
// are ignored: the import write path is authored as literal SQL, so a `${cols.join}`
// insert (e.g. the undo-restore path) is a different operation, not an import bypass,
// and inspecting its column list from source is impossible anyway.
function preparedLiterals(src: string): string[] {
  const out: string[] = [];
  const re = /\.prepare\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i++;
    const q = src[i];
    if (q === "`" || q === '"' || q === "'") {
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
      out.push(buf);
      re.lastIndex = j + 1;
    }
  }
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

// Parse an INSERT statement's target table + parenthesized column list. Returns null
// for anything that isn't a column-list INSERT (UPDATE/SELECT/DELETE, or an INSERT …
// SELECT with no explicit column list). Column names are matched as bare words.
function parseInsert(sql: string): { table: string; columns: string[] } | null {
  const m = /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^)]*)\)/i.exec(sql);
  if (!m) return null;
  const columns = m[2]
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  return { table: m[1], columns };
}

describe("import single-entry: every document_id-binding INSERT lives in the persist core", () => {
  const files = sourceFiles();

  it("scans a meaningful number of source files", () => {
    // Guards against a broken glob silently passing the whole suite.
    expect(files.length).toBeGreaterThan(30);
  });

  it("finds the persist core's document_id-binding inserts (parser sanity)", () => {
    // The core writes 9 document_id-keyed footprint tables (medical_records,
    // allergies, conditions, encounters, procedures, family_history,
    // care_plan_items, care_goals, and the auto-structured intake_items). If the
    // parser stops seeing them, the "must live in the core" assertion below would
    // pass vacuously — so pin a floor.
    const src = fs.readFileSync(path.join(REPO, PERSIST_FILE), "utf8");
    const found = preparedLiterals(src)
      .map(norm)
      .map(parseInsert)
      .filter((p): p is { table: string; columns: string[] } => !!p)
      .filter((p) => p.columns.some((c) => /\bdocument_id\b/.test(c)));
    expect(found.length).toBeGreaterThanOrEqual(9);
  });

  it("has no document_id-binding INSERT outside lib/import-persist.ts", () => {
    const violations: string[] = [];

    for (const file of files) {
      const rel = path.relative(REPO, file).split(path.sep).join("/");
      const src = fs.readFileSync(file, "utf8");
      for (const raw of preparedLiterals(src)) {
        const sql = norm(raw);
        const parsed = parseInsert(sql);
        if (!parsed) continue;
        if (!parsed.columns.some((c) => /\bdocument_id\b/.test(c))) continue;

        // A document_id-binding INSERT must target a footprint table — otherwise
        // clear/move/count would never touch its rows (a footprint blind spot).
        if (!FOOTPRINT_TABLE_NAMES.has(parsed.table)) {
          violations.push(
            `${rel}: INSERT binds document_id into '${parsed.table}', which is NOT in IMPORT_FOOTPRINT_TABLES — add it to the footprint list or drop the document link`
          );
          continue;
        }

        if (rel === PERSIST_FILE) continue; // the one allowed home
        const allowed = ALLOW.some(
          (a) => rel.endsWith(a.file) && sql.includes(a.includes)
        );
        if (!allowed) {
          violations.push(
            `${rel}: a document_id-binding INSERT must live in ${PERSIST_FILE} (the persist core), not here — route it through persistDocumentImport / insertImportRows. SQL: ${sql}`
          );
        }
      }
    }

    expect(violations, `\n${violations.join("\n")}\n`).toEqual([]);
  });
});
