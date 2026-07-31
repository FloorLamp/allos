// Thin-data census shape (#1544). Run AFTER scripts/seed.ts against a scratch DB:
// it trims the seeded observation streams down to the last ~7 days, producing the
// data shape a real phone has in its first week.
//
//   ALLOS_DB_PATH=/tmp/ux-walkthrough.db npx tsx scripts/ux-thin-data.ts
//
// Why a third shape exists. The census used to pair two poles — a fresh DB (every
// card an empty state) and `UX_SEED=1` (~3 weeks of history) — and a whole class
// of degradation lives in neither. #1541 is the worked example: a period-stats
// card whose trailing 7/30/90-day windows all COINCIDE at about one week of
// history, so it shows the same number three times. On a fresh DB it reads "No
// data" three times; on the seeded DB the 7d window separates and it looks fine.
// Only the week-old shape reproduces the phone.
//
// What gets trimmed. Every table carrying a plain `date` column is an observation
// stream by this repo's conventions (see AGENTS.md, "Observation-shaped data"), so
// the trim set is DERIVED from the schema rather than hand-listed — a new dated
// store joins the thin shape automatically instead of quietly keeping 3 weeks of
// history. The exception is the clinical passport (KEEP below): records of care
// are not self-tracked cadence, a real week-old install can hold years of them
// from one document import, and keeping them leaves the detail-page census
// (#1544 part 1) able to resolve its representative ids on this shape too.
//
// Synthetic data throughout — this only deletes rows the seed just wrote, so it
// carries no PHI considerations beyond the seed's own.

import "./load-env";

import { db, today, writeTx } from "../lib/db";
import { shiftDateStr } from "../lib/date";

// Days of history the thin shape keeps, inclusive of today. Seven is the #1541
// coincidence point: the 7d, 30d and 90d trailing windows all cover the same rows.
const KEEP_DAYS = Number(process.env.UX_THIN_DAYS || 7);

// Records of care, deliberately NOT trimmed — see the header note.
const KEEP_TABLES = new Set([
  "encounters",
  "medical_records",
  "medical_record_revisions",
  "immunizations",
  "procedures",
  "preventive_events",
]);

interface TableInfoRow {
  name: string;
  notnull: number;
}
interface ForeignKeyRow {
  table: string;
  from: string;
  to: string | null;
  on_delete: string;
}

const allTables = (
  db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all() as { name: string }[]
).map((t) => t.name);

const columns = new Map<string, TableInfoRow[]>();
for (const t of allTables)
  columns.set(
    t,
    db.prepare(`PRAGMA table_info("${t}")`).all() as TableInfoRow[]
  );

// child → parent edges that SQLite will not clean up for us. CASCADE/SET NULL
// children need no help; a NO ACTION/RESTRICT child would abort the delete.
const blockingChildren = new Map<
  string,
  { child: string; column: string; parentKey: string; nullable: boolean }[]
>();
for (const child of allTables) {
  const fks = db
    .prepare(`PRAGMA foreign_key_list("${child}")`)
    .all() as ForeignKeyRow[];
  for (const fk of fks) {
    const action = (fk.on_delete || "NO ACTION").toUpperCase();
    if (action === "CASCADE" || action === "SET NULL") continue;
    const col = columns.get(child)?.find((c) => c.name === fk.from);
    const list = blockingChildren.get(fk.table) ?? [];
    list.push({
      child,
      column: fk.from,
      parentKey: fk.to || "id",
      nullable: !col || col.notnull === 0,
    });
    blockingChildren.set(fk.table, list);
  }
}

// The thin shape targets the scratch DB the walkthrough seeds, which is
// single-profile; profile 1's calendar day is the reference "today".
const cutoff = shiftDateStr(today(1), -(KEEP_DAYS - 1));

const trimmed = allTables.filter(
  (t) => !KEEP_TABLES.has(t) && columns.get(t)?.some((c) => c.name === "date")
);

// Trim one table, clearing the references that would otherwise block the delete.
// Recursive because a blocking child can itself have blocking children; `seen`
// keeps a cyclic schema from looping.
function purge(table: string, where: string, seen: Set<string>): number {
  if (seen.has(table)) return 0;
  seen.add(table);
  for (const link of blockingChildren.get(table) ?? []) {
    const doomed = `SELECT "${link.parentKey}" FROM "${table}" WHERE ${where}`;
    if (link.nullable)
      db.prepare(
        `UPDATE "${link.child}" SET "${link.column}" = NULL WHERE "${link.column}" IN (${doomed})`
      ).run();
    else
      purge(
        link.child,
        `"${link.column}" IN (${doomed})`,
        new Set([...seen].filter((t) => t !== link.child))
      );
  }
  return db.prepare(`DELETE FROM "${table}" WHERE ${where}`).run().changes;
}

const removed: { table: string; rows: number; kept: number }[] = [];
writeTx(() => {
  for (const table of trimmed) {
    const before = (
      db.prepare(`SELECT COUNT(*) c FROM "${table}"`).get() as { c: number }
    ).c;
    const rows = purge(table, `"date" < '${cutoff}'`, new Set());
    if (rows > 0) removed.push({ table, rows, kept: before - rows });
  }
});

const violations = db.pragma("foreign_key_check") as unknown[];
if (violations.length)
  console.log(
    `[thin] WARNING: ${violations.length} dangling foreign-key rows after the trim — a page may render its error boundary.`
  );

console.log(
  `[thin] kept the last ${KEEP_DAYS} days (on or after ${cutoff}); scanned ${trimmed.length} dated tables, ${KEEP_TABLES.size} passport tables untouched.`
);
for (const r of removed)
  console.log(`[thin]   ${r.table}: -${r.rows} rows, ${r.kept} kept`);
if (!removed.length)
  console.log("[thin]   nothing to trim — was the DB seeded first?");
