import type Database from "better-sqlite3";
import { instantNow } from "../clock";
import { createLogger } from "../log";
import { runBootTx } from "./schema-utils";
import {
  foreignKeyViolationTally,
  introducedViolations,
  type ForeignKeyViolationTally,
} from "./cascade-delete";
import { MIGRATIONS } from "./versions";

const log = createLogger("migrate");

// Versioned migration runner (issue #119; name-keyed since #2601's follow-up). A
// minimal, zero-dependency runner whose applied-set lives in a `schema_migrations`
// ledger table keyed by migration NAME. Migrations are ordered, append-only,
// synchronous TypeScript functions (see lib/migrations/versions/); the MIGRATIONS
// array in versions/index.ts is the single ordering authority.
//
// TWO ERAS, ONE REGISTRY. Migrations 001–185 are the closed NUMBERED era: their
// ids are frozen 1-based array positions and their files are hash-locked by the
// immutability manifest. Everything after them is name-keyed only — a new
// migration is `versions/YYYYMMDD-slug.ts` with a unique name and NO id, appended
// LAST to the array. The number was the coordination bottleneck of parallel
// development (slot reservations, the renumber recipe, a gap failing every DB test
// at import); a name plus explicit array order keeps the determinism and drops the
// contention — two branches that each add a migration now conflict only on
// index.ts, and the resolution is keeping both lines.
//
// `PRAGMA user_version` is retained as a monotonic applied-COUNT, for exactly two
// consumers: releases older than the ledger (their downgrade guard compares
// user_version against their own migration count, so a ledger-era database must
// keep it climbing past 185 to make them refuse), and the backup/restore version
// gate (lib/restore.ts, lib/backup-verify.ts) which compares a snapshot's
// user_version to the build's migration count. The LEDGER is authoritative;
// user_version is a tripwire.

export interface Migration {
  /** Unique; matches the file slug ("001-baseline", "20260812-foo"). */
  name: string;
  /**
   * The closed numbered era only (1..185, contiguous, === position). New
   * migrations OMIT this — the registry assertion refuses a numbered migration
   * after the first name-keyed one.
   */
  id?: number;
  /** Synchronous; runs inside the runner's IMMEDIATE transaction. */
  up(db: Database.Database): void;
}

// The applied-count tripwire. 0 on a brand-new DB; on a migrated DB it equals the
// number of applied migrations (numbered-era stamps and ledger-era bumps agree on
// that meaning).
export function readVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

// The applied-set ledger. Created by the runner itself (not by a migration —
// chicken-and-egg: recording an application needs the table to exist first), so
// every historical database shape gains it on its next boot. `applied_at` is a
// canonical UTC+`Z` instant (lib/date.ts convention; minted via instantNow());
// for rows BACKFILLED from a pre-ledger user_version stamp it records when the
// backfill ran, not when the migration originally applied — the name is the
// authoritative fact, the timestamp is provenance.
export function ensureLedger(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`
  );
}

function appliedNames(db: Database.Database): Set<string> {
  return new Set(
    (
      db.prepare(`SELECT name FROM schema_migrations`).all() as {
        name: string;
      }[]
    ).map((r) => r.name)
  );
}

// Apply every migration whose name is not yet in the ledger, in array order, each
// in its own `BEGIN IMMEDIATE` transaction (via runBootTx's bounded SQLITE_BUSY
// retry). Semantics:
//
//   • Downgrade guard: a ledger row naming a migration this build does not know
//     means a newer release wrote this database and the running code has been
//     rolled back — fail the boot with a clear error rather than limping until the
//     old code hits a shape it doesn't understand. (The user_version comparison is
//     kept beside it for databases that predate the ledger.)
//   • One IMMEDIATE transaction PER migration. `next build` runs several parallel
//     workers that all import lib/db.ts and race the boot path; IMMEDIATE takes the
//     write lock at BEGIN (waiting out a peer via busy_timeout), and the
//     IN-TRANSACTION re-read of the ledger row is the AUTHORITATIVE dedup — a
//     worker that lost the race sees the recorded name and no-ops.
//   • Fresh and upgraded DBs take the SAME path: a fresh DB is just an empty
//     ledger replaying baseline + everything after it, so fresh/upgraded schema
//     divergence is impossible by construction.
//   • Order divergence is tolerated, deliberately, because it is a DEV-ONLY shape:
//     production only ever follows main, whose array is append-only, so its
//     applied set is always a prefix. A dev database that applied a branch's
//     migration and then merged main (which added one EARLIER in the array) simply
//     has the missing one applied on the next boot — late relative to array order,
//     which is exactly what the branch's own database already experienced.
//
// `migrations` is injectable for the runner's own tests; production callers pass
// nothing and get the real registry.
export function runMigrations(
  db: Database.Database,
  migrations: readonly Migration[] = MIGRATIONS
): void {
  const legacyCount = assertRegistry(migrations);

  runBootTx(db.transaction(() => ensureLedger(db)));

  // Downgrade guards FIRST, so a refused boot writes nothing — most-specific
  // (a ledger row this build does not know) before the pre-ledger fallback
  // (a bare user_version ahead of the code).
  const known = new Set(migrations.map((m) => m.name));
  const unknown = [...appliedNames(db)].filter((n) => !known.has(n)).sort();
  if (unknown.length > 0) {
    throw new Error(
      `Database has applied migration(s) this build does not know about: ` +
        `${unknown.join(", ")}. A newer release wrote this database and the ` +
        `running code has been rolled back. Running old code against a newer ` +
        `schema is refused to avoid corruption — restore the backup that matches ` +
        `this build (see scripts/restore.ts), or redeploy the newer image.`
    );
  }
  if (readVersion(db) > migrations.length) {
    throw new Error(
      `Database schema version (user_version = ${readVersion(db)}) is NEWER ` +
        `than this build knows about (this build carries ${migrations.length} ` +
        `migrations). A newer release wrote this database and the running code ` +
        `has been rolled back. Running old code against a newer schema is ` +
        `refused to avoid corruption — restore the backup that matches this ` +
        `build (see scripts/restore.ts), or redeploy the newer image.`
    );
  }

  // Numbered-era backfill, as one IMMEDIATE transaction so parallel boot workers
  // serialize on it; INSERT OR IGNORE makes the loser's replay a no-op. A
  // database stamped `user_version = V` by a pre-ledger release has, by that
  // release's contiguity invariant, applied exactly migrations 1..V.
  runBootTx(
    db.transaction(() => {
      const stamped = Math.min(readVersion(db), legacyCount);
      if (stamped > 0) {
        const backfill = db.prepare(
          `INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)`
        );
        const at = instantNow();
        for (let i = 0; i < stamped; i++) backfill.run(migrations[i].name, at);
      }
    })
  );

  const applied = appliedNames(db);

  // Apply migrations with foreign_keys DISABLED, restoring the prior setting after
  // (issue #95). SQLite cannot attach a foreign key to an existing column, so a
  // migration that enforces a link rebuilds the table (create → copy → drop → rename
  // into place). Rebuilding a table that is itself a FK *parent* while foreign_keys
  // is ON fires ON DELETE CASCADE on the drop and wipes its children — so SQLite's
  // own documented table-rebuild procedure requires foreign_keys off for the swap.
  // Toggling it is a no-op INSIDE a transaction, hence here, around the per-migration
  // IMMEDIATE transactions (we are in autocommit at this point). Migrations null any
  // dangling link before adding its FK, so re-enabling enforcement meets a clean
  // graph (baseline and the ordinary column/table migrations don't rely on FK
  // enforcement while applying).
  const fkWasOn = (db.pragma("foreign_keys", { simple: true }) as number) === 1;
  if (fkWasOn) db.pragma("foreign_keys = OFF");
  try {
    const isApplied = db.prepare(
      `SELECT 1 FROM schema_migrations WHERE name = ?`
    );
    const record = db.prepare(
      `INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`
    );
    // The FK-graph baseline for the orphan probe below. Taken LAZILY — a boot with
    // nothing to apply (every boot after the first, on every install) must not pay
    // for a probe it will never compare against.
    let fkBefore: ForeignKeyViolationTally | null | undefined;
    // A probe that could not be TAKEN is reported once per boot, not once per
    // migration: the fact worth knowing is that this boot had a blind spot, and
    // repeating it for every remaining migration would bury it.
    let probeGapReported = false;
    const noteProbeGap = (m: Migration): void => {
      if (probeGapReported) return;
      probeGapReported = true;
      log.warn(
        `could not read PRAGMA foreign_key_check around migration ${m.name} — ` +
          `rows it orphaned would go unreported (#2703). The baseline is re-taken ` +
          `for the migration after it, so this is one blind migration and not a ` +
          `probe that switched itself off.`,
        { migration: m.name }
      );
    };
    for (const m of migrations) {
      if (applied.has(m.name)) continue;
      // `== null` deliberately: `undefined` is "not taken yet" and `null` is "the
      // last probe FAILED", and both mean there is no baseline to compare against.
      // Re-taking on `null` is what stops one transient pragma failure from
      // disabling the guard for every later migration in the boot — a guard that
      // turns itself off after a hiccup and says nothing is the shape this whole
      // family exists to remove, and it said nothing precisely because `null` was
      // being carried forward as if it were a taken baseline.
      if (fkBefore == null) {
        fkBefore = foreignKeyViolationTally(db);
        if (fkBefore === null) noteProbeGap(m);
      }
      const tx = db.transaction(() => {
        // Authoritative in-txn dedup: a peer worker may have applied this
        // migration between our pre-loop read and taking the write lock.
        if (isApplied.get(m.name)) return;
        m.up(db);
        record.run(m.name, instantNow());
        // Keep the tripwire climbing: a numbered-era migration stamps its own id
        // (max-guarded so the value never moves backwards); a ledger-era one
        // bumps past the numbered ceiling by one per application.
        const next =
          m.id !== undefined
            ? Math.max(readVersion(db), m.id)
            : Math.max(readVersion(db), legacyCount) + 1;
        db.pragma(`user_version = ${next}`);
      });
      runBootTx(tx);
      fkBefore = reportOrphansIntroduced(db, m, fkBefore);
      if (fkBefore === null) noteProbeGap(m);
    }
  } finally {
    if (fkWasOn) db.pragma("foreign_keys = ON");
  }
}

/**
 * Report the dangling references `m` just created, and return the new baseline for
 * the migration after it (issue #2703).
 *
 * WHY THIS IS HERE AND NOT IN A SOURCE SCAN. Every migration applies with
 * `foreign_keys = OFF` (issue #95, for safe table rebuilds), so `ON DELETE CASCADE`
 * fires for nothing and any migration that removes parent rows leaves its children
 * behind. #2680 guards the shape a scanner can READ — `DELETE FROM <parent>`. It
 * cannot read a rebuild that copies a FILTERED subset of rows into `<t>_new`, which
 * drops the rest with no `DELETE` token at all, and no lexical rule is complete over
 * that class (see lib/migrations/cascade-delete.ts for the full argument). This asks
 * the database instead, which answers for every shape at once.
 *
 * A REPORT, NEVER A REFUSAL. The rows are dead weight, not corruption — every
 * current reader joins the parent — and refusing the boot over them would trade a
 * quiet inconsistency for an install that will not start, which is the worse of the
 * two. It is also the wrong moment to refuse: the migration's own transaction has
 * committed, so a throw here would leave the database half-upgraded rather than
 * undoing anything. So it names the migration and the links, loudly, and boots. The
 * repair is a forward migration calling `sweepOrphanedCascadeRows`, exactly as
 * 20260813-cascade-orphan-sweep did for the #2680 orphans.
 *
 * It fires wherever a migration meets DATA — an operator's install, and a
 * developer's own seeded database, which is where a new migration is first run
 * against rows. CI's fresh databases have nothing to orphan, which is precisely why
 * this class needs a probe that lives outside CI.
 */
function reportOrphansIntroduced(
  db: Database.Database,
  m: Migration,
  before: ForeignKeyViolationTally | null | undefined
): ForeignKeyViolationTally | null {
  const after = foreignKeyViolationTally(db);
  const introduced = introducedViolations(before ?? null, after);
  if (introduced.length > 0) {
    const rows = introduced.reduce((n, v) => n + v.rows, 0);
    // The remedy is per LINK, because the sweep is: it clears CASCADE orphans and
    // deliberately leaves `SET NULL` danglers alone (they are live provenance —
    // see sweepOrphanedCascadeRows). Prescribing it for a SET NULL link would be
    // advice that does nothing, offered in a voice that says it will.
    const sweepable = introduced.some((v) => v.action === "cascade");
    log.warn(
      `migration ${m.name} left ${rows} row(s) pointing at a parent it removed ` +
        `— migrations apply with foreign_keys = OFF, so ON DELETE CASCADE did not ` +
        `fire (#2680/#2703). Use deleteRowsWithCascade() in the migration` +
        (sweepable
          ? `, or append one calling sweepOrphanedCascadeRows() to clear the ` +
            `CASCADE orphans this one left.`
          : `. The sweep cannot clear these: it removes CASCADE orphans only, and ` +
            `deliberately leaves SET NULL references alone.`),
      { migration: m.name, rows, links: introduced.map((v) => v.link) }
    );
  }
  return after;
}

// Registry invariants, checked at boot. The numbered era is a frozen PREFIX:
// every migration carrying an id sits before every name-keyed one, ids are
// 1-based, contiguous, and equal to array position (so a pre-ledger stamp
// `user_version = N` unambiguously names migrations 1..N for the backfill). After
// the first name-keyed migration, a numbered one is refused — the era is closed,
// new migrations declare a name only. Names must be unique: they are the ledger's
// primary key. Returns the numbered-era length.
function assertRegistry(migrations: readonly Migration[]): number {
  const seen = new Set<string>();
  let legacyCount = 0;
  let namedEraStarted = false;
  migrations.forEach((m, i) => {
    if (!m.name) {
      throw new Error(
        `MIGRATIONS[${i}] has no name — the name is the identity.`
      );
    }
    if (seen.has(m.name)) {
      throw new Error(
        `Duplicate migration name "${m.name}" — names are the ledger's primary ` +
          `key and must be unique. Rename the new migration's file and slug.`
      );
    }
    seen.add(m.name);
    if (m.id !== undefined) {
      if (namedEraStarted) {
        throw new Error(
          `MIGRATIONS[${i}] ("${m.name}") declares id ${m.id} after a name-keyed ` +
            `migration. The numbered era is CLOSED — new migrations declare a ` +
            `name only and are appended last.`
        );
      }
      if (m.id !== i + 1) {
        throw new Error(
          `Migration ordering is broken: MIGRATIONS[${i}] has id ${m.id} ` +
            `(expected ${i + 1}, name "${m.name}"). Numbered-era ids are 1-based ` +
            `and contiguous.`
        );
      }
      legacyCount = m.id;
    } else {
      namedEraStarted = true;
    }
  });
  return legacyCount;
}
