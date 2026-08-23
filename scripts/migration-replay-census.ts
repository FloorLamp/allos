// Classify every migration by what happens when its `up()` is applied a SECOND
// time over its own output (issue #3590).
//
//   npm run census:migration-replay
//
// WHAT THE VERDICTS MEAN, because "threw" is not a defect.
//
// The runner wraps `m.up(db)` and the `schema_migrations` insert in ONE
// transaction (lib/migrations/runner.ts), so no reachable path applies a body
// twice: either both commit or neither does. A body that throws on a standalone
// second application is therefore still safe under the runner — what it is not is
// self-sufficient, and 215 of its 219 neighbours are. Many of those say so in
// their own header ("guarded on PRAGMA table_info so a re-run is a strict
// no-op"), a convention that dates from a `migrate()` test wrapper which replayed
// bodies unconditionally and is now ledger-gated like everything else. So this is
// a census of that convention, not a gate on it: it reports, it does not fail.
//
// THE RE-ENTRY PROPERTY IS MEASURED ELSEWHERE, and it is the one that matters —
// `lib/__db_tests__/migration-reentry.test.ts` drives every shipped body through a
// real SQLITE_BUSY at COMMIT and compares the whole database against a clean run.
// See docs/internals/migration-reentry.md.
//
// Nothing is written to disk: the census runs in an in-memory database.

import "./load-env";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../lib/migrations/versions";
import { runMigrations } from "../lib/migrations/runner";

type Verdict = "noop" | "changed" | "threw";

// Thrown to unwind the trial application. A sentinel object, not an Error, so it
// can never be confused with something a migration body raised.
const ROLLBACK = { rollbackTheTrial: true };

/** Every schema object and every row, as comparable text. */
function dumpState(db: Database.Database): string {
  const out: string[] = [];
  const objects = db
    .prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`)
    .all() as { type: string; name: string; sql: string | null }[];
  for (const o of objects) out.push(`SCHEMA ${o.type} ${o.name} :: ${o.sql}`);
  for (const o of objects) {
    if (o.type !== "table" || o.name.startsWith("sqlite_")) continue;
    // The ledger is the RUNNER's bookkeeping, not a migration's output.
    if (o.name === "schema_migrations") continue;
    const rows = db.prepare(`SELECT * FROM "${o.name}"`).all();
    out.push(`DATA ${o.name} n=${rows.length}`);
    for (const line of rows.map((r) => JSON.stringify(r)).sort()) {
      out.push(`  ${line}`);
    }
  }
  return out.join("\n");
}

function firstDifference(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `${(a[i] ?? "<absent>").slice(0, 100)}\n       -> ${(b[i] ?? "<absent>").slice(0, 100)}`;
    }
  }
  return "<no textual difference>";
}

function main(): void {
  const db = new Database(":memory:");
  const results: { name: string; verdict: Verdict; detail: string }[] = [];

  for (let i = 0; i < MIGRATIONS.length; i++) {
    const m = MIGRATIONS[i];
    // Bring the database up to and including this migration through the REAL
    // runner, so each body is re-applied over exactly the state it produced —
    // not over the final schema, which later migrations may have moved out from
    // under it.
    runMigrations(db, MIGRATIONS.slice(0, i + 1));
    const before = dumpState(db);

    let verdict: Verdict = "noop";
    let detail = "";
    let after = before;
    try {
      db.transaction(() => {
        m.up(db);
        // Read INSIDE the trial: the rollback below is what keeps the census
        // side-effect free, so the comparison has to happen before it.
        after = dumpState(db);
        throw ROLLBACK;
      })();
    } catch (err) {
      if (err !== ROLLBACK) {
        verdict = "threw";
        detail = String((err as Error)?.message ?? err).slice(0, 140);
      }
    }
    if (verdict !== "threw" && after !== before) {
      verdict = "changed";
      detail = firstDifference(before, after);
    }
    results.push({ name: m.name, verdict, detail });
  }
  db.close();

  const counts: Record<Verdict, number> = { noop: 0, changed: 0, threw: 0 };
  for (const r of results) counts[r.verdict]++;

  console.log(
    `${MIGRATIONS.length} migrations, re-applied over their own output:`
  );
  console.log(`  noop     ${counts.noop}\tidempotent standalone`);
  console.log(
    `  changed  ${counts.changed}\tsecond application leaves a different database`
  );
  console.log(
    `  threw    ${counts.threw}\tsecond application errors — safe under the runner, not standalone`
  );
  const notable = results.filter((r) => r.verdict !== "noop");
  if (notable.length === 0) {
    console.log(`\nEvery body is a standalone no-op.`);
    return;
  }
  console.log(
    `\n${notable.length} migration(s) that are not a standalone no-op:\n`
  );
  for (const r of notable) {
    console.log(
      `  ${r.verdict.toUpperCase().padEnd(8)}${r.name}\n       ${r.detail}\n`
    );
  }
}

main();
