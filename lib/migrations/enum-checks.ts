import type Database from "better-sqlite3";

// Boot-time reconciliation of inline enum CHECK constraints (issue #91).
//
// The schema is (re)applied on every boot via `CREATE TABLE IF NOT EXISTS`,
// which no-ops on an existing database. So an inline `CHECK (col IN (...))`
// enum constraint is frozen at whatever set of values that particular DB was
// born with. Growing an enum in the source CREATE block works on fresh DBs, but
// upgraded DBs keep the old CHECK and their INSERTs of the new value fail at
// runtime with a constraint violation — a trap that no fresh-boot test tier can
// catch.
//
// The fix: keep a curated registry (`ENUM_CHECKS`) of every inline enum CHECK in
// the schema as the source of truth, and on boot compare each table's LIVE CHECK
// clause (parsed from `sqlite_master.sql`) against it. When a table has drifted,
// rebuild it the SQLite-recommended way (CREATE new → INSERT SELECT → DROP old →
// RENAME) with only the CHECK clause replaced, preserving every column, index,
// trigger, and row byte-for-byte. Normal boots — where nothing has drifted —
// touch no rows and open no transaction, so they stay fast.
//
// The registry is guarded by `lib/__db_tests__/enum-check-drift.test.ts`, which
// diffs it against a freshly-migrated schema: editing a CHECK in a CREATE block
// (or adding/removing one) without updating this list fails CI, instead of
// failing a self-hoster's upgrade at runtime.

export interface EnumCheck {
  table: string;
  column: string;
  /** The current source-of-truth allowed set (order-insensitive). */
  values: string[];
}

// Every inline `col IN (...)` enum CHECK in the schema (see lib/db.ts's CREATE
// blocks). Genuinely-closed sets (logins.role, providers.type) are listed too:
// they simply never drift, so reconciliation is a no-op for them, but including
// them keeps the drift guard's "registry == schema" invariant total. When you
// grow (or otherwise edit) an enum CHECK in a CREATE block, update the matching
// entry here in the same change — the drift guard test enforces it.
export const ENUM_CHECKS: EnumCheck[] = [
  {
    table: "activities",
    column: "type",
    values: ["strength", "cardio", "sport"],
  },
  {
    table: "immunization_overrides",
    column: "kind",
    values: ["immune", "declined"],
  },
  {
    table: "goals",
    column: "status",
    values: ["active", "achieved", "archived"],
  },
  {
    table: "medical_records",
    column: "category",
    values: ["vitals", "lab", "genomics", "biomarker", "scan", "prescription"],
  },
  {
    table: "medical_documents",
    column: "extraction_status",
    values: ["pending", "processing", "done", "failed", "skipped"],
  },
  {
    table: "allergies",
    column: "status",
    values: ["active", "inactive", "resolved"],
  },
  {
    table: "conditions",
    column: "status",
    values: ["active", "inactive", "resolved"],
  },
  {
    table: "appointments",
    column: "status",
    values: ["scheduled", "completed", "cancelled"],
  },
  { table: "import_jobs", column: "type", values: ["workouts", "biomarkers"] },
  {
    table: "import_jobs",
    column: "status",
    values: ["processing", "ready", "failed", "skipped"],
  },
  {
    table: "providers",
    column: "type",
    values: ["organization", "individual"],
  },
  { table: "logins", column: "role", values: ["admin", "member"] },
  {
    table: "import_pair_decisions",
    column: "decision",
    values: ["merged", "kept-both", "dismissed"],
  },
  {
    table: "frequency_targets",
    column: "scope_kind",
    values: ["region", "group", "type"],
  },
  {
    table: "intake_item_suggestions",
    column: "status",
    values: ["pending", "accepted", "dismissed"],
  },
  {
    table: "intake_item_pairs",
    column: "relation",
    values: ["with", "separate"],
  },
];

// A `CHECK ( <col> IN ( '...', '...' ) )` clause, tolerant of whitespace and an
// optionally-quoted column name. The value list is captured for parsing. The
// pattern deliberately matches only the simple `col IN (...)` form (no trailing
// `OR ... IS NULL` etc.) — every schema enum CHECK is written that way, and the
// drift guard keeps it so.
function checkClauseRegex(column: string): RegExp {
  return new RegExp(
    `CHECK\\s*\\(\\s*"?${column}"?\\s+IN\\s*\\(([^)]*)\\)\\s*\\)`,
    "i"
  );
}

// The string literals inside a captured `IN (...)` list, un-escaping SQL's
// doubled-quote (`''` → `'`).
function parseValues(list: string): string[] {
  return [...list.matchAll(/'((?:[^']|'')*)'/g)].map((m) =>
    m[1].replace(/''/g, "'")
  );
}

function tableSql(db: Database.Database, table: string): string | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql?: string } | undefined;
  return row?.sql ?? null;
}

// The live allowed-value set for a column's enum CHECK, or null when the live
// schema has no `col IN (...)` clause for it (a DB born before the CHECK
// existed — out of scope for enum-growth reconciliation).
export function liveCheckValues(
  db: Database.Database,
  table: string,
  column: string
): string[] | null {
  const sql = tableSql(db, table);
  if (!sql) return null;
  const m = sql.match(checkClauseRegex(column));
  return m ? parseValues(m[1]) : null;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every((v) => bs.has(v));
}

// Discover every inline `col IN (...)` enum CHECK actually present in the live
// schema (used by both the boot check and the drift-guard test, so the test
// verifies the exact parser production relies on).
export function discoverEnumChecks(db: Database.Database): EnumCheck[] {
  const tables = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL"
    )
    .all() as { name: string; sql: string }[];
  const re = /CHECK\s*\(\s*"?(\w+)"?\s+IN\s*\(([^)]*)\)\s*\)/gi;
  const found: EnumCheck[] = [];
  for (const t of tables) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(t.sql))) {
      found.push({ table: t.name, column: m[1], values: parseValues(m[2]) });
    }
  }
  return found;
}

function hasDrift(db: Database.Database, spec: EnumCheck): boolean {
  const live = liveCheckValues(db, spec.table, spec.column);
  if (live === null) return false; // no live enum CHECK to reconcile
  return !sameSet(live, spec.values);
}

function quoteValues(values: string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
}

// Rebuild `table` in place, replacing each drifted column's CHECK clause with the
// registry's current allowed set. Follows the SQLite-recommended procedure
// (CREATE new → INSERT SELECT → DROP old → RENAME) and the repo's existing
// rebuilds (ensureCanonicalSexColumns, rebuildForProfileScoping): the new table
// is derived from the LIVE `sqlite_master.sql` with only the CHECK text patched,
// so every other column, default, and constraint — including additive columns
// added since the DB was born — is preserved exactly, and `SELECT *` copies all
// rows byte-for-byte. Runs inside the caller's transaction (with foreign_keys
// off) so a crash mid-rebuild rolls back cleanly.
function rebuildTableChecks(
  db: Database.Database,
  table: string,
  specs: EnumCheck[]
): void {
  let sql = tableSql(db, table);
  if (!sql) return;
  for (const spec of specs) {
    const re = checkClauseRegex(spec.column);
    if (!re.test(sql)) continue; // no live clause to patch (out of scope)
    sql = sql.replace(
      re,
      `CHECK (${spec.column} IN (${quoteValues(spec.values)}))`
    );
  }

  // Point the CREATE at a temp name. sqlite_master stores the statement without
  // "IF NOT EXISTS", but tolerate it (and an optionally-quoted name) anyway.
  const tempName = `${table}_enumfix`;
  const createRe = new RegExp(
    `^\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${table}"?`,
    "i"
  );
  const createSql = sql.replace(createRe, `CREATE TABLE ${tempName}`);

  // Remember user-defined indexes and triggers; DROP TABLE takes them with it, so
  // we recreate them verbatim after the rename. Auto-indexes (NULL sql, backing
  // PRIMARY KEY / UNIQUE) come back with the rebuilt table's own constraints.
  const aux = db
    .prepare(
      `SELECT sql FROM sqlite_master
         WHERE tbl_name = ? AND type IN ('index', 'trigger')
           AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`
    )
    .all(table) as { sql: string }[];

  db.exec(`DROP TABLE IF EXISTS ${tempName}`);
  db.exec(createSql);
  db.exec(`INSERT INTO ${tempName} SELECT * FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${tempName} RENAME TO ${table}`);
  for (const a of aux) db.exec(a.sql);
}

// Reconcile every drifted enum CHECK on boot. See the module header. Fast path:
// when nothing has drifted (the normal boot), this opens no transaction and
// writes nothing.
export function reconcileEnumChecks(db: Database.Database): void {
  const drifted = ENUM_CHECKS.filter((spec) => hasDrift(db, spec));
  if (drifted.length === 0) return;

  // Group drifted checks by table so a table with two drifted columns (e.g.
  // import_jobs.type + .status) is rebuilt once.
  const byTable = new Map<string, EnumCheck[]>();
  for (const spec of drifted) {
    const list = byTable.get(spec.table) ?? [];
    list.push(spec);
    byTable.set(spec.table, list);
  }

  const noDriftLeft = () => ENUM_CHECKS.every((s) => !hasDrift(db, s));

  // The SQLite-recommended rebuild procedure runs with foreign_keys OFF so
  // DROP TABLE on a table with children doesn't trigger the implicit-DELETE
  // cascade. The pragma is a no-op inside a transaction, so toggle it OUTSIDE
  // BEGIN and restore it in `finally`. After the rename the table has the same
  // name and key columns, so existing child FK references stay valid.
  const fkWasOn = (db.pragma("foreign_keys", { simple: true }) as number) === 1;
  if (fkWasOn) db.pragma("foreign_keys = OFF");
  try {
    const tx = db.transaction(() => {
      // Re-check inside the txn: a parallel `next build` worker may have already
      // rebuilt these while we waited for the write lock.
      if (noDriftLeft()) return;
      for (const [table, specs] of byTable) {
        const stillDrifted = specs.filter((s) => hasDrift(db, s));
        if (stillDrifted.length > 0)
          rebuildTableChecks(db, table, stillDrifted);
      }
    });
    // IMMEDIATE takes the write lock at BEGIN (see runBootTx in lib/db.ts); the
    // bounded retry is the SQLITE_BUSY backstop, and the in-txn re-check makes a
    // lost race a clean no-op.
    for (let attempt = 0; ; attempt++) {
      try {
        tx.immediate();
        break;
      } catch (err) {
        if (noDriftLeft()) break; // a peer worker won the race
        if (attempt < 5 && /SQLITE_BUSY/i.test(String(err))) continue;
        throw err;
      }
    }
  } finally {
    if (fkWasOn) db.pragma("foreign_keys = ON");
  }
}
