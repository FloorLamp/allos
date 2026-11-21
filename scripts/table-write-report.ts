// Usage: node --import tsx scripts/table-write-report.ts /path/to/allos.db
// Counts surviving rows with a recent record or bookkeeping timestamp once each.
// A null count means the table or its write-time columns are absent from the DB.
import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";
import { OWNED_TABLES } from "../lib/owned-tables";
import { ownedChildTables } from "../lib/profile-delete";
import { TIME_COLUMNS, type TimeColumn } from "../lib/time-columns";

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const timestampRegistry: Record<string, readonly TimeColumn[]> = TIME_COLUMNS;

function identifier(name: string): string {
  return '"' + name.replaceAll('"', '""') + '"';
}

export function tableWriteReport(db: Database.Database, now = new Date()) {
  const since = new Date(now.getTime() - WINDOW_MS).toISOString();
  const until = now.toISOString();
  const tableColumns = db.prepare<[string], { name: string }>(
    "SELECT name FROM pragma_table_info(?)"
  );

  const tables = db.transaction(() => {
    const owned = [...OWNED_TABLES, ...ownedChildTables(db).keys()];
    return owned.map((table) => {
      const columns = new Set(tableColumns.all(table).map(({ name }) => name));
      const timestamps = (timestampRegistry[table] ?? []).filter(
        ({ column, grain, semantic }) =>
          columns.has(column) &&
          grain === "instant" &&
          (semantic === "record" || semantic === "bookkeeping")
      );
      if (timestamps.length === 0) return { table, recentRows: null };

      const inWindow = timestamps
        .map(
          ({ column }) =>
            `julianday(${identifier(column)}) BETWEEN julianday(@since) AND julianday(@until)`
        )
        .join(" OR ");
      const { count } = db
        .prepare<{ since: string; until: string }, { count: number }>(
          `SELECT COUNT(*) AS count FROM ${identifier(table)} WHERE ${inWindow}`
        )
        .get({ since, until })!;
      return { table, recentRows: count };
    });
  })();

  tables.sort(
    (a, b) =>
      (b.recentRows ?? -1) - (a.recentRows ?? -1) ||
      a.table.localeCompare(b.table, "en")
  );

  return { metric: "recent_rows", since, until, tables };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [filename] = process.argv.slice(2);
  if (!filename || process.argv.length !== 3) {
    console.error(
      "Usage: node --import tsx scripts/table-write-report.ts /path/to/allos.db"
    );
    process.exit(2);
  }
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    console.log(JSON.stringify(tableWriteReport(db), null, 2));
  } finally {
    db.close();
  }
}
