import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { resolveTimezone } from "./timezone";
import { dateStrInTz, shiftDateStr } from "./date";
import { runMigrations } from "./migrations/runner";
import { bootTasks } from "./migrations/boot-tasks";
import { MIGRATIONS } from "./migrations/versions";

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
  // Parallel `next build` workers each open the DB and run migrate() at once; a
  // generous busy timeout lets a writer wait out another's write lock instead of
  // failing an IMMEDIATE transaction with SQLITE_BUSY (see rebuildTable).
  db.pragma("busy_timeout = 10000");
  // Apply the versioned schema migrations (lib/migrations/runner), then the
  // per-boot tasks that must re-run on every process start (boot-tasks).
  runMigrations(db);
  bootTasks(db);
  return db;
}

// DB-tier test entry point. Applies the full current schema — EVERY migration's
// up() in order (baseline's CREATE ... IF NOT EXISTS set plus each appended
// migration) followed by the per-boot tasks — UNCONDITIONALLY (not version-gated).
// The production boot path (createDb) uses the version-gated `runMigrations` +
// `bootTasks` instead; this wrapper exists for the lib/__db_tests__ suites that
// build the schema on their own in-memory handle (and re-run it to prove the replay
// is a no-op) without touching user_version. Every migration is written to be
// re-runnable (CREATE IF NOT EXISTS / guarded ADD COLUMN), so replaying the whole
// list is a schema no-op.
export function migrate(db: Database.Database): void {
  for (const m of MIGRATIONS) m.up(db);
  bootTasks(db);
}

export const db = globalForDb.__healthDb ?? createDb();
if (process.env.NODE_ENV !== "production") globalForDb.__healthDb = db;

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
  return dateStrInTz(appTimezone(profileId));
}

export function yesterday(profileId: number): string {
  return shiftDateStr(today(profileId), -1);
}
