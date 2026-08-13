import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { resolveTimezone } from "./timezone";
import { dateStrInTz, shiftDateStr, zonedMinuteStr } from "./date";
import { now } from "./clock";
import { ensureLedger, runMigrations } from "./migrations/runner";
import { bootTasks } from "./migrations/boot-tasks";
import { MIGRATIONS } from "./migrations/versions";
import {
  acquireBootLock,
  BOOT_LOCK_TIMEOUT_MS,
} from "./migrations/schema-utils";
// Side-effect import: registers the fs-backed error sink so createLogger().error()
// persists to data/logs/errors.jsonl (issue #596). Lives here because db.ts is on
// the Node boot path for both the app server and CLI scripts, and is NEVER pulled
// into the Edge middleware / client bundles (where fs is unavailable) — keeping
// log.ts itself Edge-safe.
import "./error-log";
// Side-effect import: registers the fs-backed SCOPE sink so the notification tick's
// decisions — including the declines, which write no row anywhere — persist to
// data/logs/notify.jsonl (issue #2209). Same boot-path reasoning as the error sink
// above: Node only, never the Edge middleware or a client bundle.
import "./notify-log";
import { registerSqlFunctions } from "./sql-functions";
import { setTierConfigProvider } from "./ai-client";
import { getTierConfigs } from "./settings/ai-tiers";

// Single shared connection across hot-reloads in dev.
const globalForDb = globalThis as unknown as { __healthDb?: Database.Database };

// The on-disk path of the live database (data/allos.db, or an ALLOS_DB_PATH
// override). Exported so out-of-process tooling (scripts/restore.ts) can locate
// the file it must replace without re-deriving the path convention.
export function dbFilePath(): string {
  return (
    process.env.ALLOS_DB_PATH || path.join(process.cwd(), "data", "allos.db")
  );
}

function createDb(): Database.Database {
  // The DB path is data/allos.db in normal operation. A test (see
  // lib/__db_tests__) can redirect the singleton at a throwaway database — a temp
  // file or ":memory:" — by setting ALLOS_DB_PATH before this module is first
  // imported, so the query smoke tests exercise the real query functions without
  // touching (or depending on) a developer's data/allos.db. Unset in normal boot,
  // where the path is unchanged. ":memory:" has no directory to create.
  const override = process.env.ALLOS_DB_PATH;
  const dbPath = override || path.join(process.cwd(), "data", "allos.db");
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  // Shared SQL user functions (lib/sql-functions.ts) — registered on the handle
  // BEFORE anything prepares a statement, since a query that calls one fails to
  // prepare if the function is missing. They are pure and deterministic:
  // biomarker_family(), the SQL half of the #482 identity family, and
  // biomarker_panel(), the SQL half of the #1502 panel taxonomy.
  registerSqlFunctions(db);
  // busy_timeout MUST be the FIRST pragma set — before journal_mode = WAL (issue
  // #581). Parallel `next build` workers all open this same file on a cold boot and
  // race to establish WAL; switching SQLite's write-ahead mode takes a database lock, and
  // a statement issued BEFORE busy_timeout is installed does NOT wait on a competing
  // worker's lock — it fails the caller with a raw SQLITE_BUSY ("database is
  // locked"). Setting busy_timeout first installs the busy handler so EVERY
  // subsequent lock acquisition (the WAL switch, the migration/boot writes) waits
  // out a peer instead of throwing.
  //
  // The BOOT PHASE uses a much larger timeout (BOOT_LOCK_TIMEOUT_MS = 60s) than the
  // runtime value set after boot below: a cold boot is a one-time cost and waiting
  // beats dying, and the boot phase is also where a non-cooperating writer (an old
  // image, sqlite3 CLI) could hold the file longest. Requests never see this value.
  db.pragma(`busy_timeout = ${BOOT_LOCK_TIMEOUT_MS}`);
  // Serialize the ENTIRE boot (WAL establishment + migrations + boot tasks) across
  // processes with the advisory boot lock (issue #581 residual — see
  // lib/migrations/schema-utils.ts). busy_timeout alone bounds ONE lock
  // acquisition, but N parallel build workers each make ~30 sequential IMMEDIATE
  // acquisitions and SQLite's busy poll is unfair, so a starved worker could
  // exceed any per-acquisition timeout. With the lock, the first worker does the
  // whole boot alone; every peer waits on the sidecar file, then replays the boot
  // as a version-gated no-op with near-zero contention on the main DB. Advisory +
  // fail-open: if the lock can't be taken, boot proceeds unserialized (the
  // pre-lock, busy-tolerant path).
  const bootLock = acquireBootLock(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    // synchronous=NORMAL is the recommended companion to WAL: commits no longer
    // fsync on every transaction (only at checkpoint), removing a per-commit fsync
    // stall on this single-threaded, synchronous better-sqlite3 process. It stays
    // crash-safe under WAL — a power loss can lose the last few committed
    // transactions but never corrupts the database. temp_store=MEMORY keeps
    // transient sorters / temp b-trees off disk.
    db.pragma("synchronous = NORMAL");
    db.pragma("temp_store = MEMORY");
    // Apply the versioned schema migrations (lib/migrations/runner), then the
    // per-boot tasks that must re-run on every process start (boot-tasks).
    runMigrations(db);
    bootTasks(db);
  } finally {
    bootLock?.release();
  }
  // Runtime busy timeout: generous enough for the three-writer steady state (web
  // app, notify tick, poll sidecar — see writeTx / rebuildTable), but bounded so a
  // genuinely wedged peer fails a request in seconds, not the boot-phase minute.
  db.pragma("busy_timeout = 10000");
  return db;
}

// DB-tier test entry point. Applies the full current schema — EVERY migration's
// up() in order (baseline's CREATE ... IF NOT EXISTS set plus each appended
// migration) followed by the per-boot tasks — UNCONDITIONALLY (not ledger-gated).
// The production boot path (createDb) uses the ledger-gated `runMigrations` +
// `bootTasks` instead; this wrapper exists for the lib/__db_tests__ suites that
// build the schema on their own in-memory handle (and re-run it to prove the replay
// is a no-op) without touching user_version or recording applied names. Every
// migration is written to be re-runnable (CREATE IF NOT EXISTS / guarded ADD
// COLUMN), so replaying the whole list is a schema no-op. The empty
// schema_migrations ledger is still created so this path yields the SAME table set
// as production.
export function migrate(db: Database.Database): void {
  // Mirror runMigrations: apply migrations with foreign_keys disabled so a FK-parent
  // rebuild (issue #95) can drop-and-recreate its table without cascade-wiping
  // children, then restore the prior setting before the boot tasks run.
  const fkWasOn = (db.pragma("foreign_keys", { simple: true }) as number) === 1;
  if (fkWasOn) db.pragma("foreign_keys = OFF");
  try {
    ensureLedger(db);
    for (const m of MIGRATIONS) m.up(db);
  } finally {
    if (fkWasOn) db.pragma("foreign_keys = ON");
  }
  bootTasks(db);
}

// `let`, not `const`, so the DB-tier test harness can repoint the singleton
// between test files — see reopenDatabaseForTests(). ESM exports are LIVE
// BINDINGS, so every `import { db }` site observes the reassignment without a
// single call site changing. Nothing in app code may reassign it.
export let db = globalForDb.__healthDb ?? createDb();
if (process.env.NODE_ENV !== "production") globalForDb.__healthDb = db;

// A prepared statement declared at MODULE scope, resolved at call time.
//
// A prepared statement compiles against ONE connection, so a statement hoisted
// into a module constant is welded to whichever database was open when that
// module was first evaluated. That is invisible in production — one connection is
// opened at import and lives for the whole process — but the shared-registry DB
// tier (vitest.db-shared.config.ts) evaluates a module once per worker and then
// swaps the database between test files, which left every hoisted statement
// pointing at a closed connection.
//
// Deferring the compile and caching it per connection keeps the reason those
// constants exist (compile each statement once, not per call) while making the
// cache self-invalidating: a new handle is a new cache entry, and the old map is
// collected with the handle it belonged to. Use this for a module-scope statement;
// an inline prepare inside a function already sees the current connection.
const statementCache = new WeakMap<
  Database.Database,
  Map<string, Database.Statement>
>();

function preparedFor(sql: string): Database.Statement {
  let forConnection = statementCache.get(db);
  if (!forConnection) {
    forConnection = new Map();
    statementCache.set(db, forConnection);
  }
  let prepared = forConnection.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql);
    forConnection.set(sql, prepared);
  }
  return prepared;
}

export interface HoistedStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): Database.RunResult;
}

export function hoistedStatement(sql: string): HoistedStatement {
  return {
    get: (...params) => preparedFor(sql).get(...params),
    all: (...params) => preparedFor(sql).all(...params),
    run: (...params) => preparedFor(sql).run(...params),
  };
}

// TEST-ONLY seam for the shared-registry DB tier (vitest.db-shared.config.ts).
// That tier runs with `isolate: false`, so a worker imports this module ONCE and
// the per-file ALLOS_DB_PATH the isolated tier relies on no longer takes effect.
// The harness instead points ALLOS_DB_PATH at a fresh per-file copy of the
// pre-migrated template and calls this to rebind onto it.
//
// The previous handle is closed rather than dropped: one worker runs hundreds of
// files in a single process, and leaking a SQLite handle per file would exhaust
// the fd budget. Never call this from app code — the production singleton is
// opened exactly once, at import.
export function reopenDatabaseForTests(): void {
  const previous = db;
  db = createDb();
  if (process.env.NODE_ENV !== "production") globalForDb.__healthDb = db;
  // Module-level state derived from the OLD database outlives the swap in a
  // shared registry. The timezone memo is keyed by profile id, and every seeded
  // file bootstraps the same low ids, so a stale entry would silently answer for
  // the new database. Any future module-scope cache fed by DB reads has to be
  // reset here too.
  invalidateTimezoneMemo();
  try {
    previous.close();
  } catch {
    // Best effort: a handle already closed (or never fully opened) is not a
    // reason to fail the file that is trying to start cleanly.
  }
}

// Register the DB-backed AI tier-config reader as the runtime provider (issue #875) so
// lib/ai-resolve can resolve task → tier → client without importing the DB layer. Done
// here rather than in boot-tasks so that module stays off the lib/settings import (the
// db → boot-tasks → settings cycle otherwise TDZ-faults some import orders). The
// closure defers getTierConfigs to call time — it reads the assigned singleton, never
// during module evaluation — so a settings-first import order stays safe.
setTierConfigProvider(() => getTierConfigs());

// Run a WRITE transaction with the reserved-write lock taken at BEGIN (IMMEDIATE)
// (issue #468). A plain `db.transaction(fn)` is DEFERRED: it opens a read snapshot
// and only tries to upgrade to a write lock at its FIRST write — and that upgrade,
// if another connection has committed since the snapshot opened, throws SQLITE_BUSY
// *immediately*, NOT covered by busy_timeout. Three processes now write this file
// (the web app, the hourly notify tick, the poll sidecar), so a read-then-write
// transaction that snapshots then writes hits that trap under the top-of-hour write
// burst. IMMEDIATE takes the write lock up front, so a competing writer waits it out
// via busy_timeout instead of failing. Any app transaction that WRITES must go
// through here (or `.immediate()` directly, for the arg-passing migration sites) —
// enforced by lib/__tests__/immediate-tx.test.ts. Nesting is safe: better-sqlite3
// turns a transaction opened inside an already-open one into a SAVEPOINT and ignores
// the access mode, so writeTx works at either the top level or nested.
// The write-transaction TOKEN (#2133, owner mechanism). `writeTx` hands its callback a
// value only this module can mint, and the in-transaction read/compare helpers in
// lib/tx.ts REQUIRE it — so a guard read or compare-and-swap written with those helpers
// cannot typecheck OUTSIDE the transaction it protects. That makes the defect class
// #2133/#2139 found (status checked outside, write inside) unwritable rather than
// something each core's author remembers. The token is EVIDENCE, not an async handle:
// the callback-synchronous rule is unchanged, and a callback that ignores the token
// (every additive write) is exactly as valid as before.
declare const TX_BRAND: unique symbol;
export interface Tx {
  readonly [TX_BRAND]: true;
}
const txToken = {} as Tx;

export function writeTx<T>(fn: (tx: Tx) => T): T {
  return db.transaction(() => fn(txToken)).immediate() as T;
}

// Run a READ-ONLY snapshot transaction (DEFERRED): wrap several reads in one
// BEGIN…COMMIT so they observe a single consistent snapshot (e.g. the full-export
// collector, issue #135). Deferred is correct here — it never writes, so it must NOT
// take a write lock. Anything that mutates uses writeTx instead.
export function readTx<T>(fn: () => T): T {
  return db.transaction(fn)() as T;
}

// Proactively checkpoint the write-ahead log (issue #135, item 6). Three processes
// share one DB file on a bind mount (the app, the hourly tick, the poll sidecar) and
// nothing otherwise runs a passive checkpoint, so a long-lived reader can hold the
// WAL open and let it grow without bound on the shared volume. The hourly tick calls
// this once per run: TRUNCATE flushes committed pages back into the main DB and
// shrinks the -wal file to zero when no other connection is mid-read. It is
// best-effort — a busy checkpoint (another connection reading) simply does less work
// and is retried next tick; a hard failure is caught by the caller and never affects
// the notification flow. Returns the raw pragma result (busy flag + page counts) for
// logging. Uses `pragma(..., { simple:false })` so callers can log what happened.
export function checkpointWal(): unknown {
  return db.pragma("wal_checkpoint(TRUNCATE)");
}

// today()/appTimezone() run many times per request (weekWindowStart, streaks,
// dashboards, adherence), and resolving the zone costs 1–2 DB reads. Memoize the
// resolved zone per profile with a short TTL: within a request every call after
// the first is a map hit (1–2 reads per profile per request, not per call), while
// the TTL bounds staleness for the long-lived notify process, which is a separate
// process that never sees the web app's in-process invalidation. Settings writes
// invalidate the entry in-process for immediate correctness — see
// lib/settings.setProfileSetting/setSetting on the 'timezone' key.
const tzMemo = new Map<number, { tz: string; at: number }>();
const TZ_MEMO_TTL_MS = 5000;

// Drop the memoized timezone for a profile (or all profiles when omitted) so the
// next today()/appTimezone() re-reads it. Called by lib/settings on a 'timezone'
// write (per-profile write clears that profile; the instance default is a
// fallback for every profile, so its write clears the whole memo).
export function invalidateTimezoneMemo(profileId?: number): void {
  if (profileId == null) tzMemo.clear();
  else tzMemo.delete(profileId);
}

// Day boundaries follow the profile's configured timezone (profile_settings key
// 'timezone'), falling back to the instance default (global settings 'timezone')
// and then UTC. We read it inline rather than importing lib/settings (settings.ts
// imports this module, so importing it back would create a cycle);
// lib/settings.getTimezone() is the canonical copy and MUST stay in sync.
function appTimezone(profileId: number): string {
  const hit = tzMemo.get(profileId);
  const now = Date.now();
  if (hit && now - hit.at < TZ_MEMO_TTL_MS) return hit.tz;
  const tz = resolveAppTimezone(profileId);
  tzMemo.set(profileId, { tz, at: now });
  return tz;
}

function resolveAppTimezone(profileId: number): string {
  // Per-profile setting wins; only when it's absent do we read the instance
  // default. The validate-or-UTC decision is the shared resolveTimezone
  // (lib/timezone), the same one lib/settings.getTimezone uses, so the two
  // day-boundary readers can't drift.
  const prof = (
    db
      .prepare(
        "SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'timezone'"
      )
      .get(profileId) as { value?: string } | undefined
  )?.value;
  const instance = prof
    ? undefined
    : (
        db
          .prepare("SELECT value FROM settings WHERE key = 'timezone'")
          .get() as { value?: string } | undefined
      )?.value;
  return resolveTimezone(prof, instance);
}

export function today(profileId: number): string {
  // The clock seam (lib/clock.ts): `now()` is the real instant in production (the
  // env override is unset) and the frozen ALLOS_TEST_NOW instant under e2e, so a
  // suite run can't cross local midnight out from under its "today"-seeded fixtures.
  return dateStrInTz(appTimezone(profileId), now());
}

export function yesterday(profileId: number): string {
  return shiftDateStr(today(profileId), -1);
}

// The profile-local wall-clock HH:MM right now — `today()`'s time-of-day twin, over the
// same timezone resolution and the same clock seam, so "which day is it" and "what time
// is it" can never be answered from two different zones. Added for #2204's one-tap
// practice stamp; anything else that needs to record WHEN a server-side tap happened
// should read it here rather than trusting a device clock (#450).
export function nowTime(profileId: number): string {
  return zonedMinuteStr(appTimezone(profileId), now()).slice(11);
}
