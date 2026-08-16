// SHARED reader for the MIGRATION CORPUS as text, for the static guards that derive a
// schema fact from it and hold a hand-maintained runtime list to that fact:
//
//   • lib/__tests__/profile-scoping.test.ts — OWNED_TABLES must equal every table whose
//     CREATE block declares a profile_id column;
//   • lib/__tests__/provider-merge.test.ts — PROVIDER_LINK_COLUMNS must equal every
//     provider-link column the schema declares.
//
// Both grew their own copy of "read the migration sources, pull CREATE TABLE bodies out,
// ignore the rebuild scratch tables", and both copies were keyed to the CLOSED numbered
// era's filename shape (`/^\d{3}-/`) — so both went blind the day migrations became
// name-keyed (#2995). Reading the corpus lives here once instead.
//
// WHAT MAKES THIS CORRECT ACROSS THE ERA BOUNDARY. A migration corpus is not a set of
// CREATE statements; it is a name LIFECYCLE. The same name can be created, rebuilt under
// a scratch name, renamed away, or retired, and a guard that reads only CREATE blocks
// answers with names that no longer exist. So the corpus is read as three facts, applied
// in ONE order:
//
//   1. RENAMES first. `ALTER TABLE <from> RENAME TO <to>` says <from> is not a
//      final-schema name — its declaration belongs to <to>. This subsumes the rebuild
//      scratch tables (a scratch is exactly a name the corpus renames away), so there is
//      no `endsWith("_new")` rule anywhere here. That rule was both too narrow
//      (`…__new011`, `…__new_2876`, `portals_rebuild` are scratch and do not match) and
//      too wide (a real table named `whats_new` would have been silently dropped from
//      every derived set).
//   2. RETIREMENT second, over what the renames left. A `DROP TABLE` whose name comes
//      back as a `RENAME TO` target is a REBUILD, and a `DROP TABLE` whose name was
//      renamed away is a RENAME — neither retires anything. What remains is genuinely
//      gone from the schema.
//   3. CANONICALIZATION last: every surviving declaration is reported under its final
//      name.
//
// The order is load-bearing in one direction specifically. `substance_log` is dropped by
// a name-keyed migration AFTER being rebuilt into `substance_daily_totals`; retire before
// resolving the rename and the guard reports a live owned table as retired, which is the
// guard lying in the safe-looking direction.
//
// NOT a test file (no `.test.ts` suffix), so vitest's `lib/**/*.test.ts` include never
// collects it — the lib/__tests__/sql-scan.ts posture.

import fs from "node:fs";
import path from "node:path";
import { REPO } from "./sql-scan";

export const MIGRATION_VERSIONS_DIR = "lib/migrations/versions";

// EVERY migration file, both eras: the closed numbered series (`001-baseline.ts` …
// `185-*.ts`) and the name-keyed one that replaced it (`YYYYMMDD-slug.ts`). `index.ts` is
// the registry, not a migration — it is the one file in the directory that is edited
// rather than frozen (lib/__tests__/migration-immutability.test.ts draws the same line).
//
// Deliberately shape-agnostic: it selects by what a file IS NOT, so a third naming era
// needs no edit here. That is the whole defect this module exists to stop repeating.
export function migrationFileNames(): string[] {
  return fs
    .readdirSync(path.join(REPO, MIGRATION_VERSIONS_DIR))
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .sort();
}

/** Every migration's source, concatenated in filename order (= application order). */
export function migrationSources(): string {
  const dir = path.join(REPO, MIGRATION_VERSIONS_DIR);
  return migrationFileNames()
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

// Whole-line comments removed. Migration 006's PROSE discusses "a DROP TABLE
// intake_items", and a table must never be retired — or renamed — by a sentence about it.
function codeOnly(dbSrc: string): string {
  return dbSrc
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");
}

export interface CreatedTable {
  /** The name as written in the CREATE, before rename canonicalization. */
  name: string;
  /** The column/constraint body, from the opening paren to its balanced close. */
  body: string;
}

/**
 * Every `CREATE TABLE <name> (…)` in the source, with its body read by a balanced-paren
 * scan (so a nested `CHECK (…)` or `DEFAULT (…)` does not truncate it). A table rebuilt
 * many times appears once per CREATE; callers dedupe by final name.
 */
export function createdTables(dbSrc: string): CreatedTable[] {
  const out: CreatedTable[] = [];
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
    out.push({ name, body });
  }
  return out;
}

// Renames the source performs through a VARIABLE, so no regex over the text can see
// them. Declared by hand, and held to the corpus by
// lib/__tests__/migration-schema-scan.test.ts: each `from` must be a table some migration
// really created, and no `to` may itself be renamed away.
//
// All three are #2740's aggregate renames in 20260814-persisted-vocabulary.ts. Two are
// `ALTER TABLE ${from} RENAME TO ${to}` inside a shared helper; the third rebuilds
// `substance_log` into `substance_daily_totals` through a scratch table and drops the old
// name, which is a rename by any honest reading of what happened to the rows.
export const DYNAMIC_TABLE_RENAMES: ReadonlyMap<string, string> = new Map([
  ["food_log", "food_daily_totals"],
  ["protein_log", "protein_daily_totals"],
  ["substance_log", "substance_daily_totals"],
]);

/**
 * `from → to` for every table the corpus renames away: the literal
 * `ALTER TABLE <from> RENAME TO <to>` statements plus DYNAMIC_TABLE_RENAMES. A rebuild's
 * scratch table is in here by construction — that is what makes it scratch.
 */
export function tableRenames(dbSrc: string): Map<string, string> {
  const renames = new Map(DYNAMIC_TABLE_RENAMES);
  for (const m of codeOnly(dbSrc).matchAll(
    /ALTER TABLE\s+(\w+)\s+RENAME TO\s+(\w+)/g
  )) {
    if (m[1] !== m[2]) renames.set(m[1], m[2]);
  }
  return renames;
}

/** Follow the rename chain to the name a table ends up under. Throws on a cycle. */
export function finalTableName(
  name: string,
  renames: ReadonlyMap<string, string>
): string {
  const seen = new Set([name]);
  let current = name;
  while (renames.has(current)) {
    const next = renames.get(current) as string;
    if (seen.has(next))
      throw new Error(`table rename cycle reached from ${name} at ${next}`);
    seen.add(next);
    current = next;
  }
  return current;
}

/**
 * Tables a migration DROPS and the corpus never brings back — no longer part of the
 * schema, so they must not be expected in any derived set even though their (frozen,
 * un-editable) CREATE block still sits in an earlier migration.
 *
 * Two subtractions, and both are the ordering this module exists for:
 *   • a name that comes back as a `RENAME TO` target was REBUILT (create scratch → copy →
 *     drop original → rename scratch into place), which is ~20 numbered migrations and
 *     every name-keyed rebuild;
 *   • a name in `renames` was RENAMED AWAY, so its rows live on under the new name.
 *     Without this, `substance_log` — dropped by 20260814-persisted-vocabulary.ts after
 *     its rows became `substance_daily_totals` — would retire a live owned table.
 */
export function tablesRetired(
  dbSrc: string,
  renames: ReadonlyMap<string, string>
): Set<string> {
  const code = codeOnly(dbSrc);
  const dropped = new Set<string>();
  for (const m of code.matchAll(/DROP TABLE (?:IF EXISTS )?(\w+)/g))
    dropped.add(m[1]);
  for (const m of code.matchAll(/RENAME TO\s+(\w+)/g)) dropped.delete(m[1]);
  for (const from of renames.keys()) dropped.delete(from);
  return dropped;
}

/**
 * The final-schema tables whose CREATE body satisfies `declares` — reported under their
 * post-rename names, with retired tables and rename scratch removed. This is the one
 * shape both guards want: "which tables in the schema today have <property>".
 */
export function finalTablesDeclaring(
  dbSrc: string,
  declares: (body: string, name: string) => boolean
): Set<string> {
  const renames = tableRenames(dbSrc);
  const retired = tablesRetired(dbSrc, renames);
  const out = new Set<string>();
  for (const { name, body } of createdTables(dbSrc)) {
    if (!declares(body, name)) continue;
    // Retirement is asked of the FINAL name: a name that was renamed away is never in
    // `retired` (tablesRetired subtracts it), so this also covers the raw name, and it
    // catches a scratch rebuilt onto a table the corpus later retires for good.
    const final = finalTableName(name, renames);
    if (retired.has(final)) continue;
    out.add(final);
  }
  return out;
}
