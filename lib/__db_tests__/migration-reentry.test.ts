import { describe, it, expect } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS } from "@/lib/migrations/versions";
import { runMigrations, type Migration } from "@/lib/migrations/runner";
import { makeTmpDir } from "../__tests__/tmp-dir";

// RE-ENTERING A MIGRATION BODY AFTER IT HAS ALREADY WRITTEN (#3590).
//
// #3442 made runBootTx's bounded SQLITE_BUSY retry live for the first time — its
// guard had read the error MESSAGE, and better-sqlite3 puts the result code on
// `.code`. The runner calls every `up()` through that retry (runner.ts), so from
// #3442 onward a migration body has a re-entry path it never had, and nothing had
// ever checked that the 219 shipped bodies survive one.
//
// TWO PROPERTIES ANSWER THAT, AND THEY ARE NOT THE SAME PROPERTY.
//
//  1. ON THE PRODUCTION PATH THE RETRY RE-ENTERS A BODY THAT WROTE NOTHING.
//     lib/db.ts sets `journal_mode = WAL` before runMigrations, and the runner
//     opens each migration with BEGIN IMMEDIATE. In WAL the write lock is
//     exclusive from BEGIN, so a competing writer makes the BEGIN itself fail —
//     measured: a second `BEGIN IMMEDIATE` raises SQLITE_BUSY, while an open
//     reader does NOT make the writer's COMMIT fail. Re-entry is therefore a
//     first entry, with zero statements executed.
//
//  2. WHEN A BUSY *DOES* LAND MID-BODY, THE RUNNER'S TRANSACTION UNDOES THE BODY.
//     runner.ts wraps `m.up(db)` and the `schema_migrations` insert in ONE
//     transaction, so SQLite rolls back the body's DDL and DML together and the
//     retry re-enters a database identical to the one the first attempt found.
//     That is what this file measures, over every shipped migration at once.
//
// THIS FILE DELIBERATELY CONSTRUCTS THE HARDER CASE THAN PRODUCTION CAN PRODUCE.
// The databases below run in SQLite's default rollback-journal mode, not WAL,
// because that is the only mode in which a body can write in full and THEN meet a
// busy: a peer holding a SHARED read lock lets BEGIN IMMEDIATE take RESERVED, and
// refuses only the RESERVED -> EXCLUSIVE upgrade at COMMIT. Every busy error here
// is raised by SQLite, never synthesised — the same standard
// `boot-tx-busy-retry.test.ts` sets, and for the same reason: a hand-thrown
// `{ code: "SQLITE_BUSY" }` would prove only that the harness sets the property
// the guard reads.
//
// ONE ASSERTION OVER 219 BODIES, NOT 219 ASSERTIONS. Every shipped body is forced
// to re-enter exactly once and the two resulting databases are compared whole. A
// per-migration assertion set would have 219 cases that all pass for the same
// reason, and would say nothing more than this does.

/** The two settings values that are a WALL-CLOCK READING, elided by name. */
//
// Both are provenance — "when did this apply" — and both are written through a
// conflict clause, so re-entry leaves ONE row with a later instant rather than a
// second row. Nothing else in the database moves, which is what the comparison
// below is for; these two are named here instead of being quietly normalised
// away.
//
//   notify_channel_migration_report — 105-login-notification-channels writes a
//     one-shot reconciliation summary stamped `new Date().toISOString()`, upserted
//     (ON CONFLICT DO UPDATE).
//   hc_overlap_unstamped_era_at — 20260821-hc-overlap-supersede writes the instant
//     `pushed_at` began being recorded, ON CONFLICT DO NOTHING. Its paired
//     `hc_overlap_unstamped_era_max_id` is read in the SAME body, so a retry that
//     writes a later instant writes the matching MAX(id) with it and the pair
//     stays internally consistent.
const WALL_CLOCK_SETTING_KEYS = [
  "notify_channel_migration_report",
  "hc_overlap_unstamped_era_at",
];

/**
 * Every schema object and every row, as comparable text.
 *
 * `schema_migrations.applied_at` is reduced to the name: it is the RUNNER's own
 * `instantNow()` at `record.run`, not anything a migration body writes.
 */
function dumpState(db: Database.Database): string {
  const out: string[] = [];
  out.push(`user_version=${db.pragma("user_version", { simple: true })}`);
  const objects = db
    .prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`)
    .all() as { type: string; name: string; sql: string | null }[];
  for (const o of objects) out.push(`SCHEMA ${o.type} ${o.name} :: ${o.sql}`);
  for (const o of objects) {
    if (o.type !== "table" || o.name.startsWith("sqlite_")) continue;
    let rows = db.prepare(`SELECT * FROM "${o.name}"`).all() as Record<
      string,
      unknown
    >[];
    if (o.name === "schema_migrations") {
      rows = rows.map((r) => ({ name: r.name }));
    }
    if (o.name === "settings") {
      rows = rows.map((r) =>
        WALL_CLOCK_SETTING_KEYS.includes(String(r.key))
          ? { ...r, value: "<wall-clock reading, see WALL_CLOCK_SETTING_KEYS>" }
          : r
      );
    }
    out.push(`DATA ${o.name} n=${rows.length}`);
    for (const line of rows.map((r) => JSON.stringify(r)).sort()) {
      out.push(`  ${line}`);
    }
  }
  return out.join("\n");
}

function freshFileDb(label: string, file: string): Database.Database {
  const db = new Database(path.join(makeTmpDir(label), file));
  // No tolerance: SQLite raises the instant the peer's lock is in the way, so the
  // count of forced re-entries below is exact and not a timing sample.
  db.pragma("busy_timeout = 0");
  return db;
}

/** Apply `migrations` with nothing in the way. */
function applyCleanly(label: string, migrations: readonly Migration[]): string {
  const db = freshFileDb(label, "clean.db");
  try {
    runMigrations(db, migrations);
    return dumpState(db);
  } finally {
    db.close();
  }
}

/**
 * Apply `migrations`, forcing EVERY body to run twice: the first attempt writes in
 * full and then meets a real SQLITE_BUSY at COMMIT, and the retry re-enters it.
 *
 * Returns the resulting dump and the set of names actually forced — a harness that
 * silently forced nothing would otherwise report a green having measured nothing.
 */
function applyWithForcedReentry(
  label: string,
  migrations: readonly Migration[]
): { dump: string; forced: Set<string> } {
  const dir = makeTmpDir(label);
  const file = path.join(dir, "reentry.db");
  const worker = new Database(file);
  worker.pragma("busy_timeout = 0");
  const peer = new Database(file);
  peer.pragma("busy_timeout = 0");
  const forced = new Set<string>();
  let peerHoldsRead = false;

  const releasePeer = (): void => {
    if (!peerHoldsRead) return;
    peer.exec("ROLLBACK");
    peerHoldsRead = false;
  };

  const wrapped: Migration[] = migrations.map((m) => ({
    name: m.name,
    ...(m.id !== undefined ? { id: m.id } : {}),
    up(db: Database.Database) {
      // The retry re-enters HERE, so this is where the peer lets go: the first
      // attempt's COMMIT must fail and the second must succeed.
      releasePeer();
      m.up(db);
      if (forced.has(m.name)) return;
      forced.add(m.name);
      // A SHARED read lock. BEGIN IMMEDIATE already holds RESERVED and is
      // unaffected; the COMMIT's upgrade to EXCLUSIVE is what SQLite refuses.
      peer.exec("BEGIN");
      peer.prepare(`SELECT count(*) AS c FROM sqlite_master`).get();
      peerHoldsRead = true;
    },
  }));

  try {
    runMigrations(worker, wrapped);
    releasePeer();
    return { dump: dumpState(worker), forced };
  } finally {
    try {
      releasePeer();
    } catch {
      /* the peer may already be out of its transaction */
    }
    peer.close();
    worker.close();
  }
}

describe("migration bodies re-entered by the SQLITE_BUSY retry (#3590)", () => {
  it("leaves the same database when EVERY shipped up() is re-entered after a real busy at COMMIT", () => {
    const clean = applyCleanly("migration-reentry-clean", MIGRATIONS);
    const { dump, forced } = applyWithForcedReentry(
      "migration-reentry-forced",
      MIGRATIONS
    );

    // The measurement is worthless if the forcing did not happen, and a harness
    // that forced nothing produces an IDENTICAL dump — the reassuring direction.
    expect(forced.size).toBe(MIGRATIONS.length);
    expect(dump).toBe(clean);
  });

  // THE CONTROL, because the assertion above passes for 219 bodies at once and a
  // comparison that cannot see a difference would pass for 220. These two are the
  // shapes the runner's transaction genuinely does NOT undo — the same class
  // #3582's lens checked the direct runBootTx callbacks for, asked of a migration
  // body — and the harness must report both.
  it("SEES a body whose write escapes the transaction through a second connection", () => {
    // A sidecar PER RUN, so the difference the assertion reads comes from the
    // retry alone and not from the two runs sharing an accumulator.
    const sidecarFor = (label: string): string =>
      path.join(makeTmpDir(label), "sidecar.db");

    const escapee = (sidecar: string): Migration => ({
      name: "control-escapes-through-a-second-connection",
      up(db) {
        db.exec(`CREATE TABLE IF NOT EXISTS mirror (n INTEGER)`);
        // A SECOND handle on a SEPARATE file: its write commits on its own and
        // the runner's ROLLBACK cannot reach it, so a re-entered body doubles it.
        const other = new Database(sidecar);
        try {
          other.exec(`CREATE TABLE IF NOT EXISTS tally (n INTEGER)`);
          other.prepare(`INSERT INTO tally (n) VALUES (1)`).run();
          const count = (
            other.prepare(`SELECT count(*) AS c FROM tally`).get() as {
              c: number;
            }
          ).c;
          db.prepare(`INSERT INTO mirror (n) VALUES (?)`).run(count);
        } finally {
          other.close();
        }
      },
    });

    const clean = applyCleanly("migration-reentry-escapee-clean", [
      escapee(sidecarFor("migration-reentry-escapee-a")),
    ]);
    const { dump, forced } = applyWithForcedReentry(
      "migration-reentry-escapee-forced",
      [escapee(sidecarFor("migration-reentry-escapee-b"))]
    );
    expect(forced.size).toBe(1);
    expect(dump).not.toBe(clean);
  });

  it("SEES a body that carries state in a module-level binding across the retry", () => {
    // The migration-body form of the outer-binding mutation #3582 audited the 14
    // direct runBootTx callbacks for. A rollback undoes the row; it cannot undo
    // the counter, so the retry writes a different number than a single run does.
    let applications = 0;
    const counter: Migration = {
      name: "control-counts-in-a-module-binding",
      up(db) {
        applications++;
        db.exec(`CREATE TABLE IF NOT EXISTS applied (n INTEGER)`);
        db.prepare(`INSERT INTO applied (n) VALUES (?)`).run(applications);
      },
    };

    const clean = applyCleanly("migration-reentry-counter-clean", [counter]);
    applications = 0;
    const { dump, forced } = applyWithForcedReentry(
      "migration-reentry-counter-forced",
      [counter]
    );
    expect(forced.size).toBe(1);
    expect(dump).not.toBe(clean);
  });
});
