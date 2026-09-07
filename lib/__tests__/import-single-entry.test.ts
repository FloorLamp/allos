import { describe, expect, it } from "vitest";
import path from "node:path";
import { IMPORT_FOOTPRINT_TABLES } from "@/lib/import-footprint";
import {
  norm,
  prepareArgs,
  readSource,
  relPath,
  REPO,
  sourceFiles,
} from "./sql-scan";

// Document-bound inserts must use the import persist core (or its delegates) and
// target tables that clear/move/count handle. Documentless imports use the same
// statements with a NULL document_id.
const FOOTPRINT_TABLE_NAMES = new Set(
  IMPORT_FOOTPRINT_TABLES.map((t) => t.table)
);

const PERSIST_FILE = "lib/import-persist.ts";

// Delegated writes and immutable migration projections, keyed by file and SQL.
const ALLOW: { file: string; includes: string; why: string }[] = [
  {
    file: "lib/intake-item-create.ts",
    includes: "INSERT INTO intake_items",
    why: "The persist core delegates to createIntakeItemCore inside its transaction; only extracted provenance binds document_id. intake_items belongs to the footprint.",
  },
  {
    file: "lib/migrations/versions/092-consolidate-imported-prescriptions.ts",
    includes:
      "INSERT INTO intake_items (name, notes, active, condition, priority, kind, as_needed",
    why: "Immutable migration: projects unpaired legacy prescriptions into document-bound intake items at upgrade time.",
  },
  {
    file: "lib/migrations/versions/101-recover-blank-name-prescriptions.ts",
    includes:
      "INSERT INTO intake_items (name, notes, active, condition, priority, kind, as_needed",
    why: "Immutable migration: recovers blank-name prescriptions as document-bound intake items at upgrade time.",
  },
];

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
    const src = readSource(path.join(REPO, PERSIST_FILE));
    const found = prepareArgs(src)
      .filter((arg) => arg.kind === "sql")
      .map((arg) => norm(arg.text))
      .map(parseInsert)
      .filter((p): p is { table: string; columns: string[] } => !!p)
      .filter((p) => p.columns.some((c) => /\bdocument_id\b/.test(c)));
    expect(found.length).toBeGreaterThanOrEqual(9);
  });

  it("has no document_id-binding INSERT outside lib/import-persist.ts", () => {
    const violations: string[] = [];

    for (const file of files) {
      const rel = relPath(file);
      for (const arg of prepareArgs(readSource(file))) {
        // Runtime-built column lists (such as undo restores) cannot be read here.
        if (arg.kind !== "sql") continue;
        const sql = norm(arg.text);
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
