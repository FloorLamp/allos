import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 006 (issue #95): converge every database on the baseline's real
// FOREIGN KEY shape for the nullable link columns.
//
// `foreign_keys = ON` is a global connection pragma, but the *definitions* it
// enforces are per-column and diverged between DB populations. Freshly built DBs
// (migration 001 "baseline") declare real `REFERENCES` clauses on link columns —
// but a column that a `REFERENCES`-carrying baseline now declares inline was, on a
// DB predating that column, added by the pre-runner `ALTER TABLE ... ADD COLUMN`
// as a bare `INTEGER` (SQLite cannot attach a FK additively). Because the baseline
// replays as a pure `CREATE ... IF NOT EXISTS` no-op on an existing DB, those bare
// columns survive. The same write path was therefore constraint-checked on one
// population and silently unchecked on the other.
//
// The chosen posture is ENFORCE EVERYWHERE: rebuild each affected table to its
// final baseline shape so every nullable link column carries its real FK on ALL
// populations. Per-table this is the standard create-new → copy → drop → rename
// with every index recreated. Notes:
//
//   • Some columns are bare in the baseline ITSELF (e.g. every `document_id` on the
//     clinical tables, `medical_records.provider_id`, `immunizations.provider_id`,
//     `intake_items.provider_id`, `exercise_sets.equipment_id`) — fresh and legacy
//     already AGREED there (both bare). We add the FK anyway, for consistency, so a
//     document/provider/equipment link can never dangle on any table.
//   • Some columns are FK in the baseline but bare on an upgraded DB
//     (`intake_items.document_id`, and the `provider_id`/`location_provider_id`
//     links on `encounters`/`procedures`/`care_plan_items`/`appointments`) — those
//     are the true fresh-vs-legacy divergence this issue reports; the rebuild is
//     what makes the upgraded DB match the fresh one.
//
// DATA SAFETY: adding a FK to a populated table fails at commit if a value dangles
// (points at a since-deleted parent). Before each rebuild we NULL any dangling link
// value (`SET col = NULL WHERE col NOT IN (SELECT id FROM parent)`) — nullable links,
// so a broken pointer becomes "unlinked", never a crash.
//
// CASCADE SAFETY: `intake_items` is the one affected table that is itself a FK
// PARENT (intake_item_doses / _logs / _pairs / medication_courses / _side_effects
// all `REFERENCES intake_items(id) ON DELETE CASCADE`). A `DROP TABLE intake_items`
// under `foreign_keys = ON` fires an implicit DELETE that would cascade-wipe those
// children — so the migration runner (and the migrate() test wrapper) apply every
// migration with foreign_keys DISABLED, per SQLite's documented table-rebuild
// procedure. Each rebuild then creates the converged table under a scratch name,
// copies the rows, DROPS the old table, and RENAMES the scratch onto the canonical
// name: a child FK references that canonical name, so it follows the rename onto the
// new table (verified with `foreign_key_check`), and the drop — with enforcement off
// — leaves the children intact.
//
// REPLAY SAFETY: the non-version-gated `migrate()` test wrapper replays every
// migration's up() unconditionally, so this must be a no-op once a table is already
// converged. Each table carries a `sentinel` — a REFERENCES clause present ONLY in
// the converged shape — and its rebuild is skipped when the live `sqlite_master`
// sql already contains it. Production runs it exactly once behind the user_version
// gate.

interface LinkColumn {
  column: string;
  parent: string;
}

interface TableRebuild {
  table: string;
  /**
   * The canonical CREATE TABLE — final columns (including any added by earlier
   * migrations, e.g. medical_records.edited from 002) plus every link column's
   * REFERENCES clause. Every DB converges byte-for-byte to this.
   */
  create: string;
  /** All of the table's indexes, copied from 001-baseline, recreated after the swap. */
  indexes: string[];
  /** Nullable link columns → their parent table; dangling values are nulled pre-copy. */
  links: LinkColumn[];
  /** Substring present ONLY in the converged shape; its presence short-circuits a replay. */
  sentinel: string;
}

const REBUILDS: TableRebuild[] = [
  {
    table: "exercise_sets",
    create: `
      CREATE TABLE exercise_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        exercise TEXT NOT NULL,
        set_number INTEGER NOT NULL,
        weight_kg REAL,
        reps INTEGER,
        weight_kg_right REAL,
        reps_right INTEGER,
        duration_sec INTEGER,
        duration_sec_right INTEGER,
        target_reps INTEGER,
        to_failure INTEGER,
        equipment_id INTEGER REFERENCES equipment(id)
      );`,
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_sets_activity ON exercise_sets(activity_id);",
    ],
    links: [{ column: "equipment_id", parent: "equipment" }],
    sentinel: "equipment_id INTEGER REFERENCES equipment(id)",
  },
  {
    table: "immunizations",
    create: `
      CREATE TABLE immunizations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        date TEXT NOT NULL,
        vaccine TEXT NOT NULL,
        dose_label TEXT,
        notes TEXT,
        source TEXT,
        external_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        provider_id INTEGER REFERENCES providers(id)
      );`,
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_immunizations_profile ON immunizations(profile_id, vaccine, date);",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_immunizations_external ON immunizations(profile_id, external_id) WHERE external_id IS NOT NULL;",
    ],
    links: [{ column: "provider_id", parent: "providers" }],
    sentinel: "provider_id INTEGER REFERENCES providers(id)",
  },
  {
    table: "medical_records",
    create: `
      CREATE TABLE medical_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        date TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('vitals','lab','genomics','biomarker','scan','prescription')),
        name TEXT NOT NULL,
        value TEXT,
        unit TEXT,
        reference_range TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        source TEXT,
        external_id TEXT,
        provider_id INTEGER REFERENCES providers(id),
        document_id INTEGER REFERENCES medical_documents(id),
        panel TEXT,
        flag TEXT,
        value_num REAL,
        canonical_name TEXT,
        edited INTEGER NOT NULL DEFAULT 0
      );`,
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_medical_document ON medical_records(document_id);",
      "CREATE INDEX IF NOT EXISTS idx_medical_canonical_ci ON medical_records(profile_id, canonical_name COLLATE NOCASE, date);",
      "CREATE INDEX IF NOT EXISTS idx_medical_profile_date ON medical_records(profile_id, date);",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_medical_external ON medical_records(profile_id, external_id) WHERE external_id IS NOT NULL;",
    ],
    links: [
      { column: "provider_id", parent: "providers" },
      { column: "document_id", parent: "medical_documents" },
    ],
    sentinel: "document_id INTEGER REFERENCES medical_documents(id)",
  },
  {
    table: "allergies",
    create: `
      CREATE TABLE allergies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        substance TEXT NOT NULL,
        substance_code TEXT,
        substance_code_system TEXT,
        reaction TEXT,
        severity TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','resolved')),
        onset_date TEXT,
        notes TEXT,
        source TEXT,
        document_id INTEGER REFERENCES medical_documents(id),
        external_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`,
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_allergies_external ON allergies(profile_id, external_id) WHERE external_id IS NOT NULL;",
    ],
    links: [{ column: "document_id", parent: "medical_documents" }],
    sentinel: "document_id INTEGER REFERENCES medical_documents(id)",
  },
  {
    table: "conditions",
    create: `
      CREATE TABLE conditions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        name TEXT NOT NULL,
        code TEXT,
        code_system TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','resolved')),
        onset_date TEXT,
        resolved_date TEXT,
        notes TEXT,
        source TEXT,
        document_id INTEGER REFERENCES medical_documents(id),
        external_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`,
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_conditions_external ON conditions(profile_id, external_id) WHERE external_id IS NOT NULL;",
    ],
    links: [{ column: "document_id", parent: "medical_documents" }],
    sentinel: "document_id INTEGER REFERENCES medical_documents(id)",
  },
  {
    table: "encounters",
    create: `
      CREATE TABLE encounters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        date TEXT NOT NULL,
        end_date TEXT,
        type TEXT,
        class_code TEXT,
        reason TEXT,
        diagnoses TEXT,
        provider_id INTEGER REFERENCES providers(id),
        location_provider_id INTEGER REFERENCES providers(id),
        notes TEXT,
        source TEXT,
        document_id INTEGER REFERENCES medical_documents(id),
        external_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`,
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_encounters_external ON encounters(profile_id, external_id) WHERE external_id IS NOT NULL;",
    ],
    links: [
      { column: "provider_id", parent: "providers" },
      { column: "location_provider_id", parent: "providers" },
      { column: "document_id", parent: "medical_documents" },
    ],
    sentinel: "document_id INTEGER REFERENCES medical_documents(id)",
  },
  {
    table: "procedures",
    create: `
      CREATE TABLE procedures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        name TEXT NOT NULL,
        code TEXT,
        code_system TEXT,
        date TEXT,
        provider_id INTEGER REFERENCES providers(id),
        notes TEXT,
        source TEXT,
        document_id INTEGER REFERENCES medical_documents(id),
        external_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`,
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_procedures_external ON procedures(profile_id, external_id) WHERE external_id IS NOT NULL;",
    ],
    links: [
      { column: "provider_id", parent: "providers" },
      { column: "document_id", parent: "medical_documents" },
    ],
    sentinel: "document_id INTEGER REFERENCES medical_documents(id)",
  },
  {
    table: "family_history",
    create: `
      CREATE TABLE family_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        relation TEXT,
        condition TEXT NOT NULL,
        code TEXT,
        code_system TEXT,
        onset_age INTEGER,
        deceased INTEGER,
        notes TEXT,
        source TEXT,
        document_id INTEGER REFERENCES medical_documents(id),
        external_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`,
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_family_history_external ON family_history(profile_id, external_id) WHERE external_id IS NOT NULL;",
    ],
    links: [{ column: "document_id", parent: "medical_documents" }],
    sentinel: "document_id INTEGER REFERENCES medical_documents(id)",
  },
  {
    table: "care_plan_items",
    create: `
      CREATE TABLE care_plan_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        description TEXT NOT NULL,
        code TEXT,
        code_system TEXT,
        category TEXT,
        planned_date TEXT,
        status TEXT,
        provider_id INTEGER REFERENCES providers(id),
        notes TEXT,
        source TEXT,
        document_id INTEGER REFERENCES medical_documents(id),
        external_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`,
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_care_plan_items_external ON care_plan_items(profile_id, external_id) WHERE external_id IS NOT NULL;",
    ],
    links: [
      { column: "provider_id", parent: "providers" },
      { column: "document_id", parent: "medical_documents" },
    ],
    sentinel: "document_id INTEGER REFERENCES medical_documents(id)",
  },
  {
    table: "care_goals",
    create: `
      CREATE TABLE care_goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        description TEXT NOT NULL,
        code TEXT,
        code_system TEXT,
        target_date TEXT,
        status TEXT,
        notes TEXT,
        source TEXT,
        document_id INTEGER REFERENCES medical_documents(id),
        external_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`,
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_care_goals_external ON care_goals(profile_id, external_id) WHERE external_id IS NOT NULL;",
    ],
    links: [{ column: "document_id", parent: "medical_documents" }],
    sentinel: "document_id INTEGER REFERENCES medical_documents(id)",
  },
  {
    table: "appointments",
    create: `
      CREATE TABLE appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        scheduled_at TEXT NOT NULL,
        provider_id INTEGER REFERENCES providers(id),
        title TEXT,
        location TEXT,
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`,
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_appointments_profile ON appointments(profile_id, scheduled_at);",
    ],
    links: [{ column: "provider_id", parent: "providers" }],
    sentinel: "provider_id INTEGER REFERENCES providers(id)",
  },
  {
    // The one affected table that is itself a FK PARENT (see CASCADE SAFETY above).
    table: "intake_items",
    create: `
      CREATE TABLE intake_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        name TEXT NOT NULL,
        notes TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        critical INTEGER NOT NULL DEFAULT 0,
        escalate_after_min INTEGER,
        escalate_chat_id TEXT,
        quantity_on_hand REAL,
        qty_per_dose REAL NOT NULL DEFAULT 1,
        kind TEXT NOT NULL DEFAULT 'supplement',
        prescriber TEXT,
        pharmacy TEXT,
        rx_number TEXT,
        as_needed INTEGER NOT NULL DEFAULT 0,
        document_id INTEGER REFERENCES medical_documents(id),
        source TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        provider_id INTEGER REFERENCES providers(id),
        condition TEXT NOT NULL DEFAULT 'daily',
        priority TEXT NOT NULL DEFAULT 'high',
        brand TEXT,
        product TEXT,
        situation TEXT,
        stack TEXT
      );`,
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_intake_items_document ON intake_items(profile_id, document_id);",
    ],
    links: [
      { column: "provider_id", parent: "providers" },
      { column: "document_id", parent: "medical_documents" },
    ],
    // provider_id is bare in the baseline, so this is absent on a fresh DB too —
    // guaranteeing the rebuild also converges the legacy-bare document_id link.
    sentinel: "provider_id INTEGER REFERENCES providers(id)",
  },
];

function tableSql(db: Database.Database, table: string): string | null {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((r) => r.name);
}

function rebuildTable(db: Database.Database, r: TableRebuild): void {
  const existing = tableSql(db, r.table);
  // Absent table: nothing to converge (baseline creates every table, so this only
  // guards a partially-built handle). Already converged: replay no-op.
  if (existing === null || existing.includes(r.sentinel)) return;

  // DATA SAFETY: null any dangling link before the FK'd copy so the deferred check
  // at commit can't fail on a broken pointer.
  for (const { column, parent } of r.links) {
    db.exec(
      `UPDATE ${r.table} SET ${column} = NULL
         WHERE ${column} IS NOT NULL
           AND ${column} NOT IN (SELECT id FROM ${parent});`
    );
  }

  const oldCols = new Set(columnNames(db, r.table));
  const scratch = `${r.table}__new006`;

  // Build the converged table under a scratch name, then swap it onto the canonical
  // name by DROPping the old table and RENAMEing the scratch into place. Any child FK
  // references the canonical name, so it follows the rename onto the new table — but
  // ONLY because migrations run with foreign_keys disabled (see up()); otherwise the
  // DROP would cascade-delete the children.
  db.exec(
    r.create.replace(`CREATE TABLE ${r.table} (`, `CREATE TABLE ${scratch} (`)
  );

  // Copy by the intersection of old/new columns (they match — the rebuild only adds
  // FK clauses, never columns), preserving ids so any child FK stays resolved.
  const copyCols = columnNames(db, scratch).filter((c) => oldCols.has(c));
  const colList = copyCols.join(", ");
  db.exec(
    `INSERT INTO ${scratch} (${colList}) SELECT ${colList} FROM ${r.table};`
  );

  // DROP first (freeing the old index names before we recreate them), then rename the
  // scratch onto the canonical name.
  db.exec(`DROP TABLE ${r.table};`);
  db.exec(`ALTER TABLE ${scratch} RENAME TO ${r.table};`);

  for (const idx of r.indexes) db.exec(idx);
}

export function up(db: Database.Database): void {
  // MUST be applied with foreign_keys disabled — the runner and the migrate() test
  // wrapper both toggle it off around migration application (issue #95) so a FK-parent
  // rebuild (intake_items) can drop its table without its ON DELETE CASCADE children
  // being wiped. Wrapped in one (possibly nested) transaction for atomicity: the
  // runner already wraps up() in an IMMEDIATE transaction (this nests as a SAVEPOINT),
  // while migrate() calls up() in autocommit (this becomes the transaction).
  const run = db.transaction(() => {
    for (const r of REBUILDS) rebuildTable(db, r);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 6,
  name: "006-fk-link-integrity",
  up,
};
