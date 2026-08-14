// Pure decision logic for the PRE-FLIGHT MIGRATION SNAPSHOT (issue #2702).
//
// `runMigrations` applies row-deleting migrations at boot, before anyone can look.
// A migration that FAILS loses nothing (savepoint + transaction, no ledger row —
// established by the adversarial lane on #2696). A migration that SUCCEEDS and
// deleted the wrong rows is unrecoverable: #2699 open question 6 records rows
// already removed by `20260813-bmi-derived-rows` that cannot be resurrected,
// because no copy of the pre-migration database exists anywhere.
//
// This module owns WHEN a snapshot is taken, WHAT it is called, and WHEN it is
// removed. The fs + `VACUUM INTO` side lives in ./snapshot.ts, the way
// lib/backup-rotation.ts splits from lib/backup.ts. No fs, no DB, no clock here —
// unit-tested in lib/__tests__/migration-snapshot-policy.test.ts.
//
// ---------------------------------------------------------------------------
// WHY THE TRIGGER IS "AN UPGRADE IS HAPPENING" AND NOT "A DELETE IS PENDING"
// ---------------------------------------------------------------------------
//
// The obvious design is a per-migration declaration (`deletesRows: true`) read off
// the pending set. This repository's entire incident record argues against it:
// #2444 shipped a `CHILD_LINKS` guard whose entries named three columns that have
// never existed, so it covered nothing while still READING like a guard; #2680's
// silence read as coverage for a year. A declaration that is wrong is worse than
// no declaration, because it buys confidence it has not earned.
//
// The second option is a lexical scan of the migration source. #2703 closed that
// door explicitly: a table rebuild that copies a FILTERED subset into `<t>_new`
// removes rows with no `DELETE` token anywhere, and no lexical rule is complete
// over that class. It is also unavailable at runtime — the production image ships
// compiled migrations, not `lib/migrations/versions/*.ts`.
//
// The third option is behavioural, which is how #2703 was actually resolved (the
// runner compares `PRAGMA foreign_key_check` before and after each migration). A
// pre-flight snapshot cannot be behavioural: the evidence a delete happened only
// exists AFTER the delete, and by then the copy it needed is gone.
//
// A fourth — apply the pending set to a throwaway copy first and keep the copy
// only if rows vanished — is strictly worse: the copy IS the snapshot, so the disk
// cost is paid either way, and the migrations run twice.
//
// So the trigger asks a question the runner already answers EXACTLY and cannot get
// wrong: is anything pending? An upgrade snapshot is unforgettable by construction.
// A new migration inherits the protection with no declaration to write, spell
// correctly, or remember. The cost of the choice is a snapshot taken before an
// upgrade that only added a column — bounded by the retention below, and by the
// skips that remove every boot where there is nothing to protect:
//
//   • nothing pending  — every boot after the first, on every install. The
//     dominant case, and it costs one set difference the runner already computed.
//   • fresh install    — an empty ledger means an empty database. Applying 190
//     migrations to no rows can delete nothing.
//   • :memory:         — no file to copy, and no operator to recover it.
//   • disabled         — the operator took the decision (host-level volume
//     snapshots, an external backup agent).
//
// See docs/internals/migration-snapshot.md.

import path from "node:path";
import { BACKUP_SNAPSHOT_HEADROOM_FACTOR } from "../health-status";

// How many pre-migration snapshots to keep. Two, not one: an upgrade that runs
// twice in quick succession (a rolled-forward hotfix) must not evict the copy that
// protects the upgrade before it, which is the one most likely to be wrong.
export const MIGRATION_SNAPSHOT_KEEP = 2;

// Age cap, in days. This is a RECOVERY copy for a bad upgrade, not an archive —
// the ordinary keep-N-dailies + M-weeklies snapshots (lib/backup-rotation.ts) are
// the long-horizon path and cover the same data. A pre-migration copy's unique
// value is "the state immediately before THIS upgrade", which is worth the most in
// the days after it and approximately nothing a year later, while still costing a
// whole database on the bind mount. The cap also stops an instance that upgrades
// once and then never again from holding two copies forever.
export const MIGRATION_SNAPSHOT_MAX_AGE_DAYS = 30;

// Filenames start `allos-` and end `.db` so `listBackupNames()` sees them and
// `npm run restore -- --from <dir>` lists them without a special case. They do NOT
// match `parseBackupStamp`'s `allos-YYYY-MM-DD-HHmm.db` shape, so they can never be
// mistaken for a scheduled snapshot by the rotation planner or by `getLastBackup`
// — which matters, because they live under the backups directory.
// The optional `-N` tail disambiguates two snapshots inside the same UTC second.
// Production reaches it only if an operator upgrades twice within one second; the
// DB-tier tests reach it constantly, which is the point — a scheme that silently
// overwrites its predecessor under a same-second collision would be untestable
// AND wrong.
const SNAPSHOT_RE =
  /^allos-premigrate-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d+))?\.db$/;

// The metadata sidecar. Distinct from `verificationSidecarName`'s `<name>.json`
// (the integrity verdict, which the restore tooling reads) — this one records what
// the snapshot was taken FOR, so an operator who finds the directory months later
// can tell which upgrade it precedes without opening the file.
export function migrationSidecarName(snapshotName: string): string {
  return `${snapshotName}.migration.json`;
}

export interface PreMigrationSnapshotMeta {
  /** ISO instant the snapshot was taken. */
  takenAt: string;
  /** `PRAGMA user_version` of the database at the moment it was copied. */
  fromUserVersion: number;
  /** How many migrations the ledger held before the pending set was applied. */
  appliedCount: number;
  /** The pending migration names, in the order they were about to be applied. */
  pending: string[];
  /** Size of the snapshot file in bytes. */
  bytes: number;
}

/**
 * The pre-migration state a snapshot protects. Two boots with the same
 * fingerprint would produce byte-equivalent snapshots, so the second reuses the
 * first (see `matchesPreState`).
 */
export interface PreMigrationState {
  fromUserVersion: number;
  appliedCount: number;
  pending: readonly string[];
}

// Whether an existing snapshot's metadata describes exactly the state we are about
// to migrate away from. This is what stops a CRASH LOOP — a migration that throws
// on every boot leaves the pending set unchanged, so without this the runner would
// VACUUM the whole database again on every restart. Reuse is safe precisely
// because the migrations did not apply: `createDb()` rethrows, so the app never
// served a request and nothing wrote to the database between the two boots.
export function matchesPreState(
  meta: PreMigrationSnapshotMeta | null,
  state: PreMigrationState
): boolean {
  if (!meta) return false;
  if (meta.fromUserVersion !== state.fromUserVersion) return false;
  if (meta.appliedCount !== state.appliedCount) return false;
  if (meta.pending.length !== state.pending.length) return false;
  return meta.pending.every((n, i) => n === state.pending[i]);
}

// Build a snapshot filename from a UTC instant. UTC, not the instance timezone:
// the timezone lives in `profile_settings`, and reading it here would mean opening
// the settings layer from inside the runner — before the migration that may be
// about to change that very table. The sidecar carries the full ISO instant, and
// the operator-facing log line states the path verbatim.
export function migrationSnapshotName(now: Date, seq = 1): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  const tail = seq > 1 ? `-${seq}` : "";
  return (
    `allos-premigrate-${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-` +
    `${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}` +
    `${p(now.getUTCSeconds())}${tail}.db`
  );
}

export interface MigrationSnapshotStamp {
  name: string;
  /** Sortable (newest = lexicographically greatest). */
  sort: string;
  /** Epoch milliseconds of the stamp, for the age cap. */
  atMs: number;
  /** Same-second disambiguator; 1 for the bare name. */
  seq: number;
}

// Parse one of our filenames; null for anything else, so a foreign file in the
// directory is never pruned.
export function parseMigrationSnapshotName(
  name: string
): MigrationSnapshotStamp | null {
  const m = SNAPSHOT_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, rawSeq] = m;
  const seq = rawSeq ? Number(rawSeq) : 1;
  return {
    name,
    // The sequence is part of the sort key so `-2` orders AFTER the bare name of
    // the same second, not before it (which plain string order would do).
    sort: `${y}-${mo}-${d}-${hh}${mm}${ss}-${String(seq).padStart(4, "0")}`,
    atMs: Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss),
    seq,
  };
}

/**
 * Which pre-migration snapshots to remove. Two independent clauses, either of
 * which prunes: beyond the newest `keep`, or older than `maxAgeDays`.
 *
 * The age clause deliberately applies to the newest file too, so a directory on an
 * instance that has stopped upgrading eventually empties rather than holding a
 * year-old database forever. That is safe because the just-taken snapshot is never
 * a candidate — the runner prunes BEFORE it writes the new one.
 */
export function planMigrationSnapshotPrune(
  names: readonly string[],
  opts: { keep?: number; maxAgeDays?: number; now: Date }
): string[] {
  const keep = Math.max(0, Math.floor(opts.keep ?? MIGRATION_SNAPSHOT_KEEP));
  const maxAgeDays = Math.max(
    0,
    opts.maxAgeDays ?? MIGRATION_SNAPSHOT_MAX_AGE_DAYS
  );
  const cutoffMs = opts.now.getTime() - maxAgeDays * 86_400_000;
  const parsed = names
    .map(parseMigrationSnapshotName)
    .filter((s): s is MigrationSnapshotStamp => s !== null)
    .sort((a, b) => (a.sort < b.sort ? 1 : a.sort > b.sort ? -1 : 0)); // newest first
  return parsed
    .filter((s, i) => i >= keep || s.atMs < cutoffMs)
    .map((s) => s.name);
}

// Where snapshots live: `<the database's own directory>/backups/pre-migration`.
//
// Derived from the DATABASE path rather than `process.cwd()` (which is what
// `backupsDir()` uses) for two reasons. In production they are the same directory
// — the live DB is `<cwd>/data/allos.db`, so this resolves to
// `<cwd>/data/backups/pre-migration`, a subdirectory of the existing backups tree
// that `listBackupNames` cannot see (it filters for `.db` FILES). And when the DB
// is redirected with `ALLOS_DB_PATH` the snapshot follows the database it is a
// copy of, instead of appearing next to an unrelated working directory.
//
// It IS on the bind-mounted volume, competing with the database for the same space
// (#1856). That is deliberate: an off-volume destination (`BACKUP_DEST_DIR`) may
// legitimately be an unmounted mount point at boot — the #463 readiness gate exists
// for exactly that — and a boot that stalls on a NAS is a worse failure than a
// snapshot on the same disk. An operator who wants it elsewhere sets
// `ALLOS_MIGRATION_SNAPSHOT_DIR`, and the headroom pre-check plus the refusal below
// are what make the same-volume default honest.
export function migrationSnapshotDir(
  dbPath: string,
  override?: string | null
): string {
  const trimmed = override?.trim();
  if (trimmed) return path.resolve(trimmed);
  return path.join(
    path.dirname(path.resolve(dbPath)),
    "backups",
    "pre-migration"
  );
}

export type SnapshotSkipReason =
  "disabled" | "in-memory" | "nothing-pending" | "fresh-install";

export type SnapshotDecision =
  { take: true } | { take: false; reason: SnapshotSkipReason };

// The whole trigger, in one pure function. See the module header for why it asks
// "is an upgrade happening" rather than "does a pending migration delete rows".
export function shouldSnapshotBeforeMigrations(opts: {
  dbPath: string;
  disabled: boolean;
  pendingCount: number;
  appliedCount: number;
}): SnapshotDecision {
  if (opts.disabled) return { take: false, reason: "disabled" };
  if (opts.pendingCount === 0)
    return { take: false, reason: "nothing-pending" };
  // ":memory:" and the anonymous temp database (better-sqlite3 reports "" for it)
  // have no file to copy.
  if (opts.dbPath === ":memory:" || opts.dbPath.trim() === "") {
    return { take: false, reason: "in-memory" };
  }
  // An empty ledger means an empty database: the numbered-era backfill has already
  // run by this point, so a pre-ledger install stamped `user_version = N` arrives
  // here with N applied names, not zero. Applying the whole registry to no rows can
  // delete nothing.
  if (opts.appliedCount === 0) return { take: false, reason: "fresh-install" };
  return { take: true };
}

// Whether the operator has switched the pre-flight snapshot off.
// `ALLOS_MIGRATION_SNAPSHOT=off` (also `0`/`false`/`no`) is the documented opt-out,
// named in the refusal message itself so the escape hatch is discoverable at the
// moment it is needed.
export function snapshotDisabledByEnv(raw: string | undefined | null): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "off" || v === "0" || v === "false" || v === "no";
}

// Free bytes needed before attempting the copy. The factor is taken BY REFERENCE
// from the health endpoint's disk-headroom rule (#1856) rather than restated: it
// is a property of what `VACUUM INTO` does — a full copy of the database plus slack
// for the sidecars — and the two must not drift into disagreeing about the same
// quantity.
export function requiredSnapshotBytes(dbSizeBytes: number): number {
  return Math.ceil(dbSizeBytes * BACKUP_SNAPSHOT_HEADROOM_FACTOR);
}

/**
 * Whether there is room for the copy. Unknown free space answers OK — a probe we
 * could not run is not evidence of a problem, the same call `isDiskLow` makes. The
 * copy then either succeeds or throws, and the throw is the refusal.
 */
export function hasSnapshotHeadroom(opts: {
  freeBytes: number | null;
  dbSizeBytes: number;
}): { ok: boolean; needBytes: number } {
  const needBytes = requiredSnapshotBytes(opts.dbSizeBytes);
  if (opts.freeBytes == null || !Number.isFinite(opts.freeBytes)) {
    return { ok: true, needBytes };
  }
  return { ok: opts.freeBytes >= needBytes, needBytes };
}
