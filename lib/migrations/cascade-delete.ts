import type Database from "better-sqlite3";

// Issue #2680 — the OTHER half of migration delete-safety.
//
// THE TWO HALVES. A migration that deletes rows has two obligations toward the
// tables that point at them, and they are not the same obligation:
//
//   1. NON-CASCADING parents (`ON DELETE NO ACTION`, the default) must BLOCK the
//      delete. That is the `CHILD_LINKS` half — a (table, column) registry each
//      row-deleting migration declares and probes with `PRAGMA table_info`, so a
//      row a child still references is skipped rather than orphaned. Migration 180
//      shipped three of four entries naming columns that have never existed, which
//      is #2444, and lib/__db_tests__/migration-child-links.test.ts is the guard
//      that makes such a typo visible against the FINAL migrated schema.
//
//   2. CASCADING children (`ON DELETE CASCADE` / `ON DELETE SET NULL`) must be
//      CLEANED UP. At runtime SQLite does that itself. Inside a migration it does
//      NOT: `runMigrations` applies every migration with `foreign_keys = OFF`
//      (lib/migrations/runner.ts, issue #95) — deliberately, because SQLite's own
//      table-rebuild procedure requires it — and a disabled foreign-key subsystem
//      fires no actions. So a bare `DELETE FROM parent` in a migration leaves the
//      cascading children behind, in a state `PRAGMA foreign_key_check` reports as
//      a violation, while the same delete at runtime removes them.
//
// `CHILD_LINKS` covers ONLY half 1. Its silence used to read as coverage; this
// module is half 2, and it exists so a migration's delete MATCHES the runtime
// delete instead of approximating it.
//
// DERIVED, NEVER TRANSCRIBED. Every link here is read out of
// `PRAGMA foreign_key_list` at APPLY time. That is deliberate on two counts. It
// cannot carry a #2444 typo, because nothing is spelled twice. And apply-time is
// the right time: a fresh database reaches the current schema by replaying every
// migration in order, so when migration N runs, the FK graph is the graph as of N
// — the child tables a LATER migration adds do not exist yet and must not be
// considered. A frozen literal would answer for the wrong moment in the sequence.
// This is the opposite call from a recognizer VOCABULARY (which rows to touch),
// which stays frozen; here the question is "what would the runtime delete have
// done to this row, in this database, right now", and only the schema can answer.
//
// Migration 118 solved this by hand for one link — see its inline comment nulling
// `fitness_assessments.activity_id` before deleting activities. It was right, and
// it was the only place the knowledge existed.

/** How SQLite would treat an inbound reference when its parent row is deleted. */
export type InboundDeleteAction = "cascade" | "set-null";

/**
 * One inbound foreign key a runtime DELETE on `parent` would act on. Column lists
 * are parallel and may hold more than one entry: this schema carries composite
 * keys — `portal_identities (portal_id, account_id) → portal_accounts (portal_id,
 * id)`, and three siblings on the same shape (`pending_portal_identities`,
 * `portal_run_reports`, `portal_sync_requests`) — and a guard that quietly ignored
 * them would be the #2444 shape one level down. The parent columns are NOT the
 * child's: `account_id` references `portal_accounts.id`.
 */
export interface InboundDeleteLink {
  /** The referencing (child) table. */
  table: string;
  /** The child's referencing columns, in key order. */
  columns: readonly string[];
  /** The referenced (parent) table. */
  parent: string;
  /** The parent's referenced columns, in the same key order. */
  parentColumns: readonly string[];
  action: InboundDeleteAction;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_delete: string;
}

// A DFS deep enough for any plausible ownership chain; a self-referencing cascade
// would need row-level recursion instead of predicate nesting, so it is refused
// loudly rather than looped over (the schema has none — the DB tier pins that).
const MAX_DEPTH = 12;

function q(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function userTables(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

/** The single-column key a row of `table` can be named by. */
function rowKeyOf(db: Database.Database, table: string): string {
  const cols = db.prepare(`PRAGMA table_info(${q(table)})`).all() as {
    name: string;
    pk: number;
  }[];
  const pk = cols.filter((c) => c.pk > 0);
  // A composite or absent primary key still has an implicit rowid in this schema
  // (nothing is WITHOUT ROWID — the DB tier pins that, because this comment is an
  // assertion about the schema and an unpinned assertion is the #2444 shape), and
  // rowid names the row just as well.
  return pk.length === 1 ? pk[0].name : "rowid";
}

/**
 * Every inbound reference to `parent` that a runtime DELETE would act on —
 * CASCADE and SET NULL. NO ACTION links are deliberately absent: those are the
 * `CHILD_LINKS` half, which BLOCKS a delete rather than cleaning up after it.
 *
 * The two remaining SQLite actions — `SET DEFAULT` and `RESTRICT` — fall through
 * the same skip, and that skip is only safe because the schema declares NEITHER.
 * It is a WORSE unhandled case than the self-referencing cycle this module refuses
 * loudly: on a `SET DEFAULT` link the helper does not refuse at all, it deletes the
 * parent and leaves the child pointing at nothing, where the runtime delete would
 * have ABORTED. So the absence is pinned in the DB tier rather than asserted here —
 * a `SET DEFAULT` link added to the schema must fail the suite and force this
 * branch to be written, not discover it in a migration.
 */
export function inboundDeleteLinks(
  db: Database.Database,
  parent: string
): InboundDeleteLink[] {
  const wanted = parent.toLowerCase();
  const out: InboundDeleteLink[] = [];
  for (const table of userTables(db)) {
    const rows = db
      .prepare(`PRAGMA foreign_key_list(${q(table)})`)
      .all() as ForeignKeyRow[];
    // PRAGMA emits one row per COLUMN; rows sharing an `id` are one composite key.
    const byKey = new Map<number, ForeignKeyRow[]>();
    for (const row of rows) {
      const group = byKey.get(row.id) ?? [];
      group.push(row);
      byKey.set(row.id, group);
    }
    for (const group of byKey.values()) {
      const head = group[0];
      if (head.table.toLowerCase() !== wanted) continue;
      const action: InboundDeleteAction | null =
        head.on_delete === "CASCADE"
          ? "cascade"
          : head.on_delete === "SET NULL"
            ? "set-null"
            : null;
      if (action === null) continue;
      const ordered = [...group].sort((a, b) => a.seq - b.seq);
      out.push({
        table,
        columns: ordered.map((r) => r.from),
        // `to` is null only for a reference to the parent's implicit rowid alias;
        // resolve it the same way SQLite does rather than leaving a null in a
        // predicate that would then match nothing.
        parentColumns: ordered.map((r) => r.to ?? rowKeyOf(db, head.table)),
        parent: head.table,
        action,
      });
    }
  }
  return out;
}

/** What `deleteRowsWithCascade` actually did, per affected table. */
export interface CascadeDeleteEffect {
  table: string;
  action: InboundDeleteAction | "parent";
  rows: number;
}

interface Predicate {
  sql: string;
  params: unknown[];
}

// A correlated predicate over `childAlias`, true for exactly the child rows whose
// parent is in the doomed set. `parentPredicate` is written over `parentAlias`, and
// the EXISTS re-binds that same alias to the parent table inside its own scope — so
// nesting a level deeper shadows cleanly instead of leaving an unbound alias behind.
function doomedChild(
  link: InboundDeleteLink,
  childAlias: string,
  parentAlias: string,
  parentPredicate: Predicate
): Predicate {
  const join = link.columns
    .map(
      (c, i) =>
        `${parentAlias}.${q(link.parentColumns[i])} = ${childAlias}.${q(c)}`
    )
    .join(" AND ");
  return {
    sql:
      `EXISTS (SELECT 1 FROM ${q(link.parent)} ${parentAlias} ` +
      `WHERE ${join} AND (${parentPredicate.sql}))`,
    params: parentPredicate.params,
  };
}

/**
 * Delete `ids` from `table` the way a RUNTIME delete would: cascading children go
 * first (depth-first, so a grandchild never outlives its parent), SET NULL
 * references are nulled, and only then do the named rows go.
 *
 * `ids` are values of `table`'s single-column primary key. A migration calls this
 * INSTEAD of a bare `DELETE FROM table`, so the row it removes leaves the same
 * graph behind that the app's own delete path would (issue #2680). It does NOT
 * decide WHICH rows to delete, and it does not consider the non-cascading parents
 * a delete must be blocked ON — that is still the migration's own `CHILD_LINKS`
 * probe, and the two halves are independent.
 */
export function deleteRowsWithCascade(
  db: Database.Database,
  table: string,
  ids: readonly number[]
): CascadeDeleteEffect[] {
  if (ids.length === 0) return [];
  const key = rowKeyOf(db, table);
  const effects: CascadeDeleteEffect[] = [];
  const tally = (
    t: string,
    action: CascadeDeleteEffect["action"],
    n: number
  ) => {
    if (n === 0) return;
    const seen = effects.find((e) => e.table === t && e.action === action);
    if (seen) seen.rows += n;
    else effects.push({ table: t, action, rows: n });
  };

  // Chunked so a large id set cannot exceed SQLite's bound-parameter ceiling.
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const root: Predicate = {
      sql: `t0.${q(key)} IN (${chunk.map(() => "?").join(",")})`,
      params: [...chunk],
    };

    // Depth-first, deepest table first, so every statement runs while the rows it
    // correlates against are still present.
    const walk = (
      parentTable: string,
      parentAlias: string,
      predicate: Predicate,
      depth: number,
      path: readonly string[]
    ): void => {
      if (depth > MAX_DEPTH) {
        throw new Error(
          `cascade delete from ${table} exceeded depth ${MAX_DEPTH} at ${parentTable}`
        );
      }
      for (const link of inboundDeleteLinks(db, parentTable)) {
        if (path.some((t) => t.toLowerCase() === link.table.toLowerCase())) {
          throw new Error(
            `cascade delete from ${table} met a foreign-key cycle at ` +
              `${link.table} — resolve it in the migration by hand`
          );
        }
        const alias = `t${depth + 1}`;
        const childPredicate = doomedChild(link, alias, parentAlias, predicate);
        if (link.action === "set-null") {
          const sets = link.columns.map((c) => `${q(c)} = NULL`).join(", ");
          const res = db
            .prepare(
              `UPDATE ${q(link.table)} AS ${alias} SET ${sets} ` +
                `WHERE ${childPredicate.sql}`
            )
            .run(...childPredicate.params);
          tally(link.table, "set-null", res.changes);
          continue;
        }
        walk(link.table, alias, childPredicate, depth + 1, [
          ...path,
          link.table,
        ]);
        const res = db
          .prepare(
            `DELETE FROM ${q(link.table)} AS ${alias} WHERE ${childPredicate.sql}`
          )
          .run(...childPredicate.params);
        tally(link.table, "cascade", res.changes);
      }
    };

    walk(table, "t0", root, 0, [table]);
    const res = db
      .prepare(`DELETE FROM ${q(table)} AS t0 WHERE ${root.sql}`)
      .run(...root.params);
    tally(table, "parent", res.changes);
  }
  return effects;
}

/** One table's worth of orphan removal, as `sweepOrphanedCascadeRows` reports it. */
export interface OrphanSweepEffect {
  table: string;
  columns: readonly string[];
  parent: string;
  rows: number;
}

/**
 * Remove every row whose `ON DELETE CASCADE` parent is GONE — the state a
 * migration's FK-off delete leaves behind (#2680).
 *
 * This is NOT everything `PRAGMA foreign_key_check` reports. That pragma flags any
 * dangling non-null reference whatever its `ON DELETE` clause, so a `SET NULL`
 * dangler (`intake_item_logs.notify_message_id` → `notify_messages`) is reported
 * before this sweep and still reported after it. The sweep clears one KIND of
 * violation, deliberately; see the SET NULL note below for why the rest are left.
 *
 * The blast radius is exactly what the schema already declares must not exist: a
 * row whose cascading reference is non-null and matches no parent row. A healthy
 * database loses nothing. Runs to a fixed point, because removing an orphan can
 * orphan its own cascading children — and it RETURNS only once it has proven that
 * fixed point, throwing otherwise, the same way `deleteRowsWithCascade` throws at
 * its own depth cap. Returning normally on an exhausted budget would be a function
 * reporting success over a database it left inconsistent, which is the shape this
 * whole module exists to remove.
 *
 * SET NULL links are deliberately NOT swept. Nulling a column on a SURVIVING row
 * rewrites live data — `intake_item_logs.notify_message_id` is provenance a
 * feature reads (#170's tap-provenance work) — and "clean up a row the schema
 * says cannot exist" is a smaller claim than "rewrite a row that can".
 */
export function sweepOrphanedCascadeRows(
  db: Database.Database
): OrphanSweepEffect[] {
  const effects: OrphanSweepEffect[] = [];
  const tables = new Set(userTables(db).map((t) => t.toLowerCase()));
  // One pass beyond the depth budget, because the pass that PROVES the fixed point
  // is the one that removes nothing: a chain of depth MAX_DEPTH needs MAX_DEPTH
  // clearing passes and then one quiet pass to confirm it is done.
  for (let pass = 0; pass <= MAX_DEPTH; pass++) {
    let removed = 0;
    for (const table of userTables(db)) {
      for (const link of allInboundCascades(db, table)) {
        if (!tables.has(link.parent.toLowerCase())) continue;
        const notNull = link.columns
          .map((c) => `${q(table)}.${q(c)} IS NOT NULL`)
          .join(" AND ");
        const join = link.columns
          .map((c, i) => `p.${q(link.parentColumns[i])} = ${q(table)}.${q(c)}`)
          .join(" AND ");
        const res = db
          .prepare(
            `DELETE FROM ${q(table)} WHERE ${notNull} AND NOT EXISTS ` +
              `(SELECT 1 FROM ${q(link.parent)} p WHERE ${join})`
          )
          .run();
        removed += res.changes;
        if (res.changes === 0) continue;
        // Keyed per LINK, not per (table, parent): `intake_item_pairs.a_id` and
        // `.b_id` both cascade off `intake_items`, and merging them would report
        // one link's columns carrying both links' rows — a wrong line in a report
        // the migration logs.
        const key = link.columns.join(",");
        const seen = effects.find(
          (e) =>
            e.table === table &&
            e.parent === link.parent &&
            e.columns.join(",") === key
        );
        if (seen) seen.rows += res.changes;
        else
          effects.push({
            table,
            columns: link.columns,
            parent: link.parent,
            rows: res.changes,
          });
      }
    }
    if (removed === 0) return effects;
  }
  throw new Error(
    `orphan sweep did not reach a fixed point in ${MAX_DEPTH} passes — ` +
      `the cascade graph is deeper than the budget; resolve it in the migration by hand`
  );
}

/** The CASCADE links `table` declares OUTWARD, in `InboundDeleteLink` shape. */
function allInboundCascades(
  db: Database.Database,
  table: string
): InboundDeleteLink[] {
  const rows = db
    .prepare(`PRAGMA foreign_key_list(${q(table)})`)
    .all() as ForeignKeyRow[];
  const byKey = new Map<number, ForeignKeyRow[]>();
  for (const row of rows) {
    const group = byKey.get(row.id) ?? [];
    group.push(row);
    byKey.set(row.id, group);
  }
  const out: InboundDeleteLink[] = [];
  for (const group of byKey.values()) {
    const head = group[0];
    if (head.on_delete !== "CASCADE") continue;
    const ordered = [...group].sort((a, b) => a.seq - b.seq);
    out.push({
      table,
      columns: ordered.map((r) => r.from),
      parent: head.table,
      parentColumns: ordered.map((r) => r.to ?? rowKeyOf(db, head.table)),
      action: "cascade",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Issue #2703 — the shape a SOURCE SCAN cannot see.
//
// The #2680 ratchet in lib/__db_tests__/migration-child-links.test.ts reads
// `DELETE FROM <table>` out of every migration's AST and fails one naming a table
// with cascading children. A table REBUILD that copies a FILTERED subset of rows
// into `<t>_new` and renames it into place drops the rest with no `DELETE` token
// anywhere, and orphans identically:
//
//   INSERT INTO t_new SELECT * FROM t WHERE <keeps only some rows>;
//   DROP TABLE t;  ALTER TABLE t_new RENAME TO t;
//
// NO LEXICAL RULE IS COMPLETE OVER THAT CLASS, and #2696 was right to decline one.
// A `WHERE`-sniffing rule catches the shape above and still misses
// `INSERT INTO t_new SELECT * FROM t` followed by a filtering DELETE on the NEW
// table — which has no inbound foreign keys yet, so the DELETE guard is blind to it
// too. A partial guard that reads like a total one is the #2444 defect one level up,
// which is the whole reason #2680 exists.
//
// So this half is BEHAVIOURAL, and it asks the only thing that can answer
// completely: the database, right after the migration ran. `PRAGMA
// foreign_key_check` sees an orphan however it was made — a bare delete, a filtered
// rebuild, a CTAS, a delete on the new table, or a shape nobody has thought of yet.
// Nothing is spelled twice, so nothing can be misspelled.
//
// AND IT IS A DELTA, NOT AN ASSERTION OF CLEANLINESS. A healthy database can carry
// findings this pragma reports and this project deliberately leaves alone: a
// `SET NULL` dangler (`intake_item_logs.notify_message_id` → `notify_messages`) is
// live provenance, and `sweepOrphanedCascadeRows` explains at length why it stays.
// A boot that complained about those would be complaining about the default posture
// forever, which is the standing-alarm shape AGENTS.md rules out for the health
// endpoint and is no better here. Only what a migration ADDED is reported.
//
// COST, measured, because a check on the boot path has to earn its place. The
// pragma is O(rows): 0.23ms on the empty migrated schema, ~1ms at 2.6k rows
// (`npm run seed`), ~50ms at 500k. The two cases that matter are both cheap. A
// FRESH install replays all 190 migrations against a database with no rows —
// worst single check 0.45ms anywhere in the sequence, ~60ms for the whole boot. An
// ESTABLISHED install has rows but applies only the migrations its release added,
// so it pays one check per NEW migration. The pathological case is a long-dormant
// install replaying many migrations over a large database, and it pays a few
// seconds on a boot already spending minutes rewriting those same rows.

/** `PRAGMA foreign_key_check`, tallied per inbound key so two links to the same
 * parent stay distinct (`intake_item_pairs.a_id` and `.b_id` are not one link). */
export type ForeignKeyViolationTally = ReadonlyMap<string, number>;

interface ForeignKeyCheckRow {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

/**
 * Every dangling reference the database currently carries, counted per
 * (child table, foreign key). Cheap on a healthy database — the pragma walks the
 * indexes and normally returns nothing.
 *
 * Never throws: this runs on the boot path, and a boot must not fail because an
 * integrity PROBE could not be taken. (It does not throw anywhere in the current
 * 190-migration sequence; the guard is for a shape a future migration invents —
 * a foreign key to a table that does not exist yet, say.) An unreadable probe
 * answers `null`, and the caller treats that as "no comparison available".
 */
export function foreignKeyViolationTally(
  db: Database.Database
): ForeignKeyViolationTally | null {
  let rows: ForeignKeyCheckRow[];
  try {
    rows = db.pragma("foreign_key_check") as ForeignKeyCheckRow[];
  } catch {
    return null;
  }
  const tally = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.table}#${r.fkid}#${r.parent}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return tally;
}

/** One inbound key that gained dangling rows, named for a log line. */
export interface IntroducedViolation {
  /** `child_table.col1+col2 → parent_table`, resolved from the schema. */
  link: string;
  /** How many MORE rows dangle than before. */
  rows: number;
}

/**
 * What `after` carries that `before` did not — the orphans one migration made.
 * A key that shrank or held steady is not reported: a repair migration is allowed
 * to clear violations, and a pre-existing one is not this migration's doing.
 */
export function introducedViolations(
  db: Database.Database,
  before: ForeignKeyViolationTally | null,
  after: ForeignKeyViolationTally | null
): IntroducedViolation[] {
  if (before === null || after === null) return [];
  const out: IntroducedViolation[] = [];
  for (const [key, count] of after) {
    const grew = count - (before.get(key) ?? 0);
    if (grew > 0) out.push({ link: describeViolationKey(db, key), rows: grew });
  }
  return out.sort((a, b) => a.link.localeCompare(b.link));
}

/** Resolve a tally key back to the columns it is about. Only ever called when
 * something IS wrong, so the extra pragma costs a healthy boot nothing. */
function describeViolationKey(db: Database.Database, key: string): string {
  const [table, fkid, parent] = key.split("#");
  let columns: string[] = [];
  try {
    columns = (
      db
        .prepare(`PRAGMA foreign_key_list(${q(table)})`)
        .all() as ForeignKeyRow[]
    )
      .filter((r) => String(r.id) === fkid)
      .sort((a, b) => a.seq - b.seq)
      .map((r) => r.from);
  } catch {
    /* the table may itself be gone; the key still names the link usefully */
  }
  const cols = columns.length > 0 ? `.${columns.join("+")}` : `#${fkid}`;
  return `${table}${cols} → ${parent}`;
}
