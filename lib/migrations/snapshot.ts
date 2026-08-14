// The PRE-FLIGHT MIGRATION SNAPSHOT's fs + `VACUUM INTO` side (issue #2702).
//
// The policy — when to take one, what to call it, when to remove it, and the whole
// argument for the trigger — lives in ./snapshot-policy.ts. This module executes
// it, and owns the two operator-facing consequences: the boot log that makes the
// snapshot DISCOVERABLE, and the refusal that stops a destructive upgrade the
// runner could not protect.
//
// IT MUST NOT IMPORT lib/db. It runs INSIDE `createDb()`, before the singleton
// exists; the runner hands it the open handle. That is also why the integrity
// verdict is written here rather than reused from lib/backup.ts, which imports the
// singleton at module scope — the sidecar FORMAT is shared (lib/backup-verify.ts is
// pure), so the artifact this writes is the artifact `npm run restore` reads.
//
// WHAT IS COPIED, AND WHY `VACUUM INTO`.
//
//   • A plain file copy of `allos.db` is WRONG under WAL. The `-wal` holds
//     committed transactions that have not been checkpointed, so a copy of the main
//     file alone silently loses them, and copying the three files separately from a
//     live connection can tear.
//   • SQLite's online backup API (`db.backup()` in better-sqlite3) returns a
//     PROMISE. `createDb()` and `runMigrations` are strictly synchronous — the whole
//     repository is synchronous better-sqlite3 — so it cannot be awaited here.
//   • `VACUUM INTO` is synchronous, transactionally consistent against the open
//     connection, writes one compact file, and PRESERVES `user_version` (which the
//     restore version gate reads). It is also exactly what `performBackup` already
//     uses, so the snapshot is the same kind of artifact the restore tooling
//     already knows how to list, verify and install.
//
// Uploaded medical files are NOT copied. They live on disk outside the database
// (lib/backup.ts mirrors them separately), and a migration cannot delete them.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { createLogger } from "../log";
import {
  interpretIntegrityRows,
  verificationSidecarName,
  type BackupVerification,
} from "../backup-verify";
import {
  MIGRATION_SNAPSHOT_KEEP,
  hasSnapshotHeadroom,
  matchesPreState,
  migrationSidecarName,
  migrationSnapshotDir,
  migrationSnapshotName,
  parseMigrationSnapshotName,
  planMigrationSnapshotPrune,
  shouldSnapshotBeforeMigrations,
  snapshotDisabledByEnv,
  type PreMigrationSnapshotMeta,
  type PreMigrationState,
  type SnapshotSkipReason,
} from "./snapshot-policy";

const log = createLogger("migrate");

export type MigrationSnapshotRefusal =
  "no-headroom" | "dir-unwritable" | "copy-failed" | "integrity-failed";

/**
 * Raised when the snapshot could not be taken. The runner does not catch it, so
 * the boot fails with nothing applied.
 *
 * WHY REFUSING IS RIGHT HERE, AND NOWHERE ELSE IN THIS RUNNER. The two costs are
 * asymmetric and the moment is unique. Refusing costs an outage that the operator
 * can end by freeing space, and it is perfectly reversible: no migration has run,
 * `user_version` and the ledger are untouched, and the PREVIOUS image still boots
 * this database unchanged. Proceeding risks a delete with no copy behind it, which
 * is not reversible at all — that is the whole subject of #2699 open question 6.
 *
 * Contrast `reportOrphansIntroduced` in the runner, which deliberately reports
 * rather than throws: by the time it runs the migration's transaction has already
 * committed, so a throw there would leave the database half-upgraded. Here nothing
 * has been applied, which is exactly what makes the refusal safe to take.
 *
 * The refusal is also OVERRIDABLE and says so in its own message. An operator who
 * takes host-level volume snapshots, or who is deliberately upgrading a box with no
 * room, sets `ALLOS_MIGRATION_SNAPSHOT=off` — which turns proceeding into a
 * decision someone made instead of a silence.
 */
export class MigrationSnapshotError extends Error {
  constructor(
    public reason: MigrationSnapshotRefusal,
    message: string
  ) {
    super(message);
    this.name = "MigrationSnapshotError";
  }
}

export type MigrationSnapshotOutcome =
  | { status: "skipped"; reason: SnapshotSkipReason }
  | { status: "reused"; path: string }
  | { status: "taken"; path: string; bytes: number };

// Free bytes on the volume holding `dir`, or null when the probe cannot run
// (statfs is unsupported on some filesystems). Mirrors the health route's
// `probeDiskSpace`: an unrunnable probe is not evidence of a problem.
function freeBytesFor(dir: string): number | null {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

function readMigrationMeta(
  dir: string,
  snapshotName: string
): PreMigrationSnapshotMeta | null {
  try {
    const raw = fs.readFileSync(
      path.join(dir, migrationSidecarName(snapshotName)),
      "utf8"
    );
    const parsed = JSON.parse(raw) as Partial<PreMigrationSnapshotMeta>;
    if (
      typeof parsed?.fromUserVersion === "number" &&
      typeof parsed.appliedCount === "number" &&
      Array.isArray(parsed.pending)
    ) {
      return parsed as PreMigrationSnapshotMeta;
    }
    return null;
  } catch {
    return null;
  }
}

function readIntegrity(
  dir: string,
  snapshotName: string
): BackupVerification | null {
  try {
    const raw = fs.readFileSync(
      path.join(dir, verificationSidecarName(snapshotName)),
      "utf8"
    );
    const parsed = JSON.parse(raw) as Partial<BackupVerification>;
    return parsed?.integrity === "ok" || parsed?.integrity === "failed"
      ? (parsed as BackupVerification)
      : null;
  } catch {
    return null;
  }
}

// Existing snapshot filenames in `dir`, newest first. Missing dir → none.
export function listMigrationSnapshots(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map(parseMigrationSnapshotName)
    .filter(
      (s): s is NonNullable<ReturnType<typeof parseMigrationSnapshotName>> =>
        Boolean(s)
    )
    .sort((a, b) => (a.sort < b.sort ? 1 : a.sort > b.sort ? -1 : 0))
    .map((s) => s.name);
}

function removeSnapshot(dir: string, name: string): void {
  for (const f of [
    name,
    verificationSidecarName(name),
    migrationSidecarName(name),
  ]) {
    try {
      fs.rmSync(path.join(dir, f), { force: true });
    } catch (e) {
      log.warn("could not remove pre-migration snapshot file", {
        file: f,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

/**
 * Apply the retention policy to `dir`. Returns how many snapshots were removed.
 *
 * Called from two places, both through the same pure plan: the runner, just before
 * it writes a new snapshot, and the scheduled backup tick (lib/backup.ts), which is
 * what stops an instance that has stopped upgrading from holding copies past the
 * age cap forever. Best-effort — never throws.
 */
export function pruneMigrationSnapshots(
  dir: string,
  opts: { keep?: number; now?: Date } = {}
): number {
  const names = listMigrationSnapshots(dir);
  if (names.length === 0) return 0;
  const prune = planMigrationSnapshotPrune(names, {
    keep: opts.keep,
    now: opts.now ?? new Date(),
  });
  for (const name of prune) removeSnapshot(dir, name);
  return prune.length;
}

export interface TakeSnapshotParams {
  /** Pending migration names, in the order they are about to be applied. */
  pending: readonly string[];
  /** Ledger size before the pending set is applied. */
  appliedCount: number;
  /** `PRAGMA user_version` before the pending set is applied. */
  fromUserVersion: number;
  /** Fixed clock (tests); defaults to now. */
  now?: Date;
  /** Directory override (tests); defaults to the env/derived location. */
  dir?: string;
  /** Force-disable (tests); defaults to reading ALLOS_MIGRATION_SNAPSHOT. */
  disabled?: boolean;
}

/**
 * Copy the database aside before a pending migration set is applied.
 *
 * Throws MigrationSnapshotError when the copy could not be made and the operator
 * has not opted out. Returns what happened otherwise — `skipped` (with the reason),
 * `reused` (a crash loop re-presenting the same pending set), or `taken`.
 */
export function takePreMigrationSnapshot(
  db: Database.Database,
  params: TakeSnapshotParams
): MigrationSnapshotOutcome {
  const dbPath = db.name;
  const decision = shouldSnapshotBeforeMigrations({
    dbPath,
    disabled:
      params.disabled ??
      snapshotDisabledByEnv(process.env.ALLOS_MIGRATION_SNAPSHOT),
    pendingCount: params.pending.length,
    appliedCount: params.appliedCount,
  });
  if (!decision.take) {
    if (decision.reason === "disabled" && params.pending.length > 0) {
      // The one skip worth a line: the operator switched off a protection that a
      // pending upgrade would otherwise have had. The other three are the ordinary
      // shape of a healthy boot and must not add noise to it.
      log.warn(
        `pre-migration snapshot DISABLED by ALLOS_MIGRATION_SNAPSHOT — ` +
          `${params.pending.length} migration(s) will apply with no recoverable ` +
          `copy behind them (#2702).`,
        { pending: [...params.pending] }
      );
    }
    return { status: "skipped", reason: decision.reason };
  }

  const now = params.now ?? new Date();
  const dir =
    params.dir ??
    migrationSnapshotDir(dbPath, process.env.ALLOS_MIGRATION_SNAPSHOT_DIR);
  const state: PreMigrationState = {
    fromUserVersion: params.fromUserVersion,
    appliedCount: params.appliedCount,
    pending: params.pending,
  };

  // A crash loop re-presents the same pending set on every restart. Reuse the
  // existing copy rather than VACUUMing the whole database again — see
  // matchesPreState for why that is safe.
  const existing = listMigrationSnapshots(dir);
  if (existing.length > 0) {
    const newest = existing[0];
    const meta = readMigrationMeta(dir, newest);
    const verified = readIntegrity(dir, newest);
    if (
      matchesPreState(meta, state) &&
      verified?.integrity === "ok" &&
      fs.existsSync(path.join(dir, newest))
    ) {
      log.info(
        `reusing the pre-migration snapshot from the previous boot — the same ` +
          `${params.pending.length} migration(s) are still pending, so the ` +
          `database has not changed since it was taken.`,
        { snapshot: path.join(dir, newest) }
      );
      return { status: "reused", path: path.join(dir, newest) };
    }
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new MigrationSnapshotError(
      "dir-unwritable",
      refusalMessage(
        `could not create the snapshot directory ${dir}: ` +
          (e instanceof Error ? e.message : String(e)),
        params.pending
      )
    );
  }

  // Prune BEFORE the copy, keeping one fewer than the retention so the new
  // snapshot lands inside it. Deliberately the opposite order from
  // `performBackup`, which prunes only after a verified snapshot so a corrupt new
  // file can never rotate away good ones. The reasoning differs here: the older
  // pre-migration copies protect upgrades that already completed and were lived
  // with, and the space they occupy is the space the copy about to be taken needs.
  // Freeing it first is what keeps a full-disk refusal from being caused by our own
  // files.
  const pruned = pruneMigrationSnapshots(dir, {
    keep: Math.max(0, MIGRATION_SNAPSHOT_KEEP - 1),
    now,
  });

  const dbSizeBytes = fileSize(dbPath) + fileSize(`${dbPath}-wal`);
  const headroom = hasSnapshotHeadroom({
    freeBytes: freeBytesFor(dir),
    dbSizeBytes,
  });
  if (!headroom.ok) {
    throw new MigrationSnapshotError(
      "no-headroom",
      refusalMessage(
        `${dir} does not have room for a copy of the database ` +
          `(need ~${headroom.needBytes} bytes). Free space on the data volume ` +
          `and start the container again — nothing has been applied, so the ` +
          `previous image still runs against this database unchanged.`,
        params.pending
      )
    );
  }

  // VACUUM INTO refuses an existing target. A name already taken is either a
  // PARTIAL from a crashed copy (no metadata sidecar — clear it and reuse the
  // name) or a real earlier snapshot from this same UTC second, which must not be
  // clobbered: take the next sequence instead.
  let seq = 1;
  let name = migrationSnapshotName(now, seq);
  while (
    fs.existsSync(path.join(dir, name)) &&
    readMigrationMeta(dir, name) !== null &&
    seq < 100
  ) {
    name = migrationSnapshotName(now, ++seq);
  }
  const full = path.join(dir, name);
  try {
    fs.rmSync(full, { force: true });
    // The path is app-controlled (our directory, our timestamped name); the quote
    // doubling matches performBackup's and covers an operator-supplied directory.
    db.exec(`VACUUM INTO '${full.replace(/'/g, "''")}'`);
  } catch (e) {
    throw new MigrationSnapshotError(
      "copy-failed",
      refusalMessage(
        `VACUUM INTO ${full} failed: ` +
          (e instanceof Error ? e.message : String(e)),
        params.pending
      )
    );
  }

  // Verify before trusting it. A snapshot that exists but cannot be restored is
  // worse than no snapshot, because it reads as a safety net — and the sidecar this
  // writes is the one `restoreCore` reads, which REFUSES an unverified snapshot
  // without `--force`. A failure here also means the LIVE database is corrupt,
  // which is its own reason not to run a migration over it.
  const verification = verifySnapshotFile(full);
  writeJson(path.join(dir, verificationSidecarName(name)), verification);
  if (verification.integrity !== "ok") {
    throw new MigrationSnapshotError(
      "integrity-failed",
      refusalMessage(
        `the snapshot written to ${full} failed PRAGMA integrity_check ` +
          `(${verification.detail ?? "no detail"}). That means the LIVE database ` +
          `is damaged; do not migrate it. Restore a known-good snapshot ` +
          `(npm run restore) before starting again.`,
        params.pending
      )
    );
  }

  const bytes = fileSize(full);
  const meta: PreMigrationSnapshotMeta = {
    takenAt: now.toISOString(),
    fromUserVersion: params.fromUserVersion,
    appliedCount: params.appliedCount,
    pending: [...params.pending],
    bytes,
  };
  writeJson(path.join(dir, migrationSidecarName(name)), meta);

  // DISCOVERY. A snapshot nobody can find is not a recovery path, and the boot log
  // is the only surface an operator is already reading at this moment. One line,
  // naming the file, its size, what it precedes, and how to use it.
  log.info(
    `pre-migration snapshot written before applying ${params.pending.length} ` +
      `migration(s) (#2702). Restore it with: ` +
      `npm run restore -- --from ${dir} ${name}  ` +
      `(read docs/internals/migration-snapshot.md first — restoring under the SAME ` +
      `image re-applies these migrations).`,
    {
      snapshot: full,
      bytes,
      fromUserVersion: params.fromUserVersion,
      pending: [...params.pending],
      pruned,
    }
  );

  return { status: "taken", path: full, bytes };
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function writeJson(p: string, value: unknown): void {
  try {
    fs.writeFileSync(p, JSON.stringify(value, null, 2));
  } catch (e) {
    // A sidecar write that fails must not mask what it describes; the same call
    // verifySnapshot makes. The snapshot itself is still on disk.
    log.warn("could not write pre-migration snapshot sidecar", {
      file: p,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

// Open a snapshot read-only and interpret PRAGMA integrity_check. Never throws —
// a check that cannot run counts as a failure, so a snapshot we cannot vouch for
// is never mistaken for a good one.
function verifySnapshotFile(full: string): BackupVerification {
  let result: { ok: boolean; detail?: string };
  try {
    const snap = new Database(full, { readonly: true, fileMustExist: true });
    try {
      result = interpretIntegrityRows(snap.pragma("integrity_check"));
    } finally {
      snap.close();
    }
  } catch (e) {
    result = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  return {
    integrity: result.ok ? "ok" : "failed",
    checkedAt: new Date().toISOString(),
    ...(result.ok ? {} : { detail: result.detail }),
  };
}

// Every refusal reads the same way: what failed, what it was protecting, and the
// one env var that turns the refusal off. The override is named in the message
// because the moment an operator needs it is the moment they are reading this.
function refusalMessage(what: string, pending: readonly string[]): string {
  return (
    `Refusing to migrate: could not take a pre-migration snapshot — ${what}\n` +
    `Pending migration(s): ${pending.join(", ")}\n` +
    `A migration that deletes the wrong rows cannot be undone without a copy ` +
    `(#2702), so the boot stops here with NOTHING applied. To proceed without ` +
    `one, set ALLOS_MIGRATION_SNAPSHOT=off.`
  );
}
