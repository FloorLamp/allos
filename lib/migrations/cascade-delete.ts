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
