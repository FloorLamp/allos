import type Database from "better-sqlite3";
import { OWNED_TABLES } from "./owned-tables";

// The profile-delete SUBTREE, derived from the live schema (issue #2126).
//
// deleteProfile removes a person's ENTIRE health record with `foreign_keys = OFF`
// (#729), so `ON DELETE CASCADE` never fires there and every child table must be
// deleted explicitly. That child list used to be hand-maintained inline in the
// action — which is exactly how `allergy_reactions`, `medication_courses`, and
// `intake_item_side_effects` were silently left behind as the schema grew: the
// parent rows died, the orphaned child rows (real PHI) survived invisibly.
//
// This module replaces the hand list with a DERIVATION that cannot go stale:
// starting from OWNED_TABLES (the directly profile-owned tables, themselves
// schema-derived — see lib/__tests__/profile-scoping.test.ts), it walks
// `PRAGMA foreign_key_list` to a fixpoint and generates one DELETE per non-owned
// table reachable through any FK path, nesting subqueries along that path. A child
// table added by migration N+1 joins the sweep the moment its FK exists.
//
// The correctness invariant the OR-across-FK-columns delete rests on is PROFILE
// ISOLATION: no row of one profile's subtree ever references another profile's
// subtree (the profile-scoping test enforces the discipline that maintains this).
// So any row with an FK value landing anywhere in the deleted profile's subtree is
// itself part of that subtree, and deleting it is exact — never over-broad. A
// GLOBAL table must never reference an owned table (it would dangle after the
// sweep); lib/__db_tests__/profile-delete-fk-scan.test.ts fails the build the day
// one does, alongside the generator's own assumption checks below.
//
// The same traversal is the read-side obligation for export completeness (#2129):
// lib/__db_tests__/export-completeness.test.ts consumes ownedChildTables() so every
// table swept here is also exported, passport-reached, or argued-excluded.

// One FK edge from a child table INTO the profile subtree (single column → parent id).
export interface SubtreeFkEdge {
  column: string;
  parent: string;
}

// A non-owned table reachable from OWNED_TABLES via FK, with every edge that makes
// it reachable and its depth (max FK hops above an owned root; direct child = 1).
export interface OwnedChildTable {
  table: string;
  edges: SubtreeFkEdge[];
  depth: number;
}

interface PragmaFkRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_delete: string;
}

function userTables(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

// Every FK each table declares, grouped by the pragma's constraint id so a
// composite (multi-column) FK is visible as one unit.
function tableForeignKeys(db: Database.Database): Map<string, PragmaFkRow[][]> {
  const out = new Map<string, PragmaFkRow[][]>();
  for (const t of userTables(db)) {
    const rows = db
      .prepare(`PRAGMA foreign_key_list("${t}")`)
      .all() as PragmaFkRow[];
    const byId = new Map<number, PragmaFkRow[]>();
    for (const row of rows) {
      const group = byId.get(row.id);
      if (group) group.push(row);
      else byId.set(row.id, [row]);
    }
    out.set(t, [...byId.values()]);
  }
  return out;
}

// Every non-owned table transitively reachable from OWNED_TABLES via FK, keyed by
// name. Throws when a reachable FK is a shape the DELETE generator cannot express
// (composite, or referencing a column other than the parent's `id`) — that failure
// is the decision point: such a schema needs an explicit new plan here, not a
// silent omission from the sweep.
export function ownedChildTables(
  db: Database.Database
): Map<string, OwnedChildTable> {
  const owned = new Set<string>(OWNED_TABLES);
  const fks = tableForeignKeys(db);

  // Fixpoint: the subtree is the owned tables plus everything referencing it.
  const subtree = new Set(owned);
  for (let changed = true; changed;) {
    changed = false;
    for (const [table, groups] of fks) {
      if (subtree.has(table)) continue;
      if (groups.some((g) => g.some((row) => subtree.has(row.table)))) {
        subtree.add(table);
        changed = true;
      }
    }
  }

  const children = new Map<string, OwnedChildTable>();
  for (const [table, groups] of fks) {
    if (owned.has(table) || !subtree.has(table)) continue;
    const edges: SubtreeFkEdge[] = [];
    for (const group of groups) {
      if (!group.some((row) => subtree.has(row.table))) continue;
      if (group.length !== 1) {
        throw new Error(
          `profile-delete: composite FK on ${table} into the profile subtree (` +
            group.map((r) => `${r.from} -> ${r.table}`).join(", ") +
            `) — the derived sweep only handles single-column id FKs; add explicit handling`
        );
      }
      const row = group[0];
      // PRAGMA reports `to` as NULL when the FK references the parent's PK.
      if (row.to != null && row.to !== "id") {
        throw new Error(
          `profile-delete: FK ${table}.${row.from} references ${row.table}.${row.to} — ` +
            `the derived sweep only handles references to the parent's id; add explicit handling`
        );
      }
      edges.push({ column: row.from, parent: row.table });
    }
    children.set(table, { table, edges, depth: 0 });
  }

  // Depth = max FK hops above an owned root, for deepest-first delete ordering
  // (a deeper table's subquery selects from its parent, so it must go first).
  const visiting = new Set<string>();
  const depthOf = (table: string): number => {
    if (owned.has(table)) return 0;
    const child = children.get(table)!;
    if (child.depth > 0) return child.depth;
    if (visiting.has(table)) {
      throw new Error(
        `profile-delete: FK cycle through ${table} — the derived sweep needs an acyclic subtree; add explicit handling`
      );
    }
    visiting.add(table);
    child.depth = 1 + Math.max(...child.edges.map((e) => depthOf(e.parent)));
    visiting.delete(table);
    return child.depth;
  };
  for (const table of children.keys()) depthOf(table);

  return children;
}

// One generated child-delete statement. `binds` is how many times the profile id
// is bound (once per owned-root leaf in the nested subqueries).
export interface ProfileChildDelete {
  table: string;
  sql: string;
  binds: number;
}

// The ordered child-delete plan: deepest tables first, so every subquery still
// finds its parent rows, then alphabetical for stable output. Table names come
// from sqlite_master, never from user input.
export function profileChildDeletePlan(
  db: Database.Database
): ProfileChildDelete[] {
  const owned = new Set<string>(OWNED_TABLES);
  const children = ownedChildTables(db);

  // WHERE fragment selecting a table's subtree rows, with its profile-id bind count.
  const condition = (table: string): { sql: string; binds: number } => {
    if (owned.has(table)) return { sql: "profile_id = ?", binds: 1 };
    const child = children.get(table)!;
    const parts = child.edges.map((e) => {
      const parent = condition(e.parent);
      return {
        sql: `${e.column} IN (SELECT id FROM ${e.parent} WHERE ${parent.sql})`,
        binds: parent.binds,
      };
    });
    return {
      sql: parts.map((p) => p.sql).join(" OR "),
      binds: parts.reduce((n, p) => n + p.binds, 0),
    };
  };

  return [...children.values()]
    .sort((a, b) => b.depth - a.depth || a.table.localeCompare(b.table))
    .map((child) => {
      const cond = condition(child.table);
      return {
        table: child.table,
        sql: `DELETE FROM ${child.table} WHERE ${cond.sql}`,
        binds: cond.binds,
      };
    });
}

// Delete a profile's ENTIRE data subtree: every derived child table (deepest
// first), then every directly owned table by profile_id. Auth-blind — the caller
// (deleteProfile in app/(app)/settings/family/actions.ts) authorizes, wraps this in
// writeTx, toggles `foreign_keys = OFF` around it (#729 — the pragma is a no-op
// inside a transaction, so it must be toggled outside), and handles the global
// tables (profile_settings, login_profiles, sessions, logins, profiles) plus
// on-disk files itself.
export function deleteProfileData(
  db: Database.Database,
  profileId: number
): void {
  for (const step of profileChildDeletePlan(db)) {
    db.prepare(step.sql).run(...Array(step.binds).fill(profileId));
  }
  // Every directly profile-owned table, deleted by profile_id. (No FK cascade —
  // upgraded DBs got profile_id via addColumnIfMissing, which can't attach an ON
  // DELETE action.) OWNED_TABLES is the shared source of truth (lib/owned-tables.ts).
  for (const t of OWNED_TABLES) {
    db.prepare(`DELETE FROM ${t} WHERE profile_id = ?`).run(profileId);
  }
}
