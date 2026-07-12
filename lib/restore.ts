// Restore core (issue #462). The last line of defense — copy a verified snapshot
// into place over the live DB — used to live only in scripts/restore.ts, so no
// test ever exercised the copy-into-place / WAL-cleanup / post-integrity sequence:
// the first time it ran was mid-disaster. This module extracts that core so the
// DB-tier restore drill (lib/__db_tests__/restore.test.ts) executes it against a
// real VACUUM INTO snapshot. It mirrors how backup already splits the pure/fs core
// (lib/backup.ts) from its CLI (scripts/backup.ts).
//
// This module deliberately does NOT import lib/db (which would open the singleton
// on import): the CLI resolves the live path (dbFilePath) and passes it in, so the
// core stays a pure-ish fs/handle unit the test tier can drive against temp files.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { interpretIntegrityRows, decideSnapshotVersion } from "./backup-verify";

// Confine a snapshot NAME to its source directory: a caller-supplied positional
// (`npm run restore -- <name>`) must resolve to a file INSIDE `dir`, never escape
// it via `../` or an absolute path. Returns the resolved absolute path, or null
// when it would escape (or names the directory itself). Pure — path math only.
export function confineSnapshotPath(dir: string, name: string): string | null {
  const root = path.resolve(dir);
  const full = path.resolve(root, name);
  const rel = path.relative(root, full);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return full;
}

// Raised by restoreCore when a safety gate refuses the restore. `reason` is the
// coarse cause; the CLI maps it to an operator-facing message.
export class RestoreRefusedError extends Error {
  constructor(
    public reason: "snapshot-failed-integrity" | "snapshot-newer-schema"
  ) {
    super(`restore refused: ${reason}`);
    this.name = "RestoreRefusedError";
  }
}

// Read `PRAGMA user_version` from a snapshot (read-only open), or null when it
// can't be read. Used both to gate a restore (a snapshot from a NEWER build would
// trip the boot-time downgrade guard) and to print the version in the CLI listing
// (#472) so the operator isn't sent in a loop by that guard's own error.
export function readSnapshotUserVersion(snapshotPath: string): number | null {
  try {
    const h = new Database(snapshotPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      return h.pragma("user_version", { simple: true }) as number;
    } finally {
      h.close();
    }
  } catch {
    return null;
  }
}

export interface RestoreCoreParams {
  // Absolute path to the snapshot to install (already confined by the CLI).
  snapshotPath: string;
  // Absolute path to the live DB to overwrite (dbFilePath(), passed by the CLI).
  livePath: string;
  // Whether the chosen snapshot passed its integrity check (from verifySnapshot).
  snapshotOk: boolean;
  // Override the safety refusals (failed-integrity, newer-schema).
  force: boolean;
  // The snapshot's PRAGMA user_version and this build's migration count (#472).
  // When the snapshot is from a NEWER schema than this build knows, installing it
  // would only make the boot-time downgrade guard refuse to start — so restore
  // refuses up front (overridable with --force). Omit to skip the version gate.
  snapshotUserVersion?: number | null;
  buildMigrationCount?: number;
  // Fixed clock for the aside filename stamp (tests); defaults to now.
  now?: Date;
}

export interface RestoreCoreResult {
  // Where the pre-restore live DB (and its WAL/SHM, #472) was copied, or null when
  // there was no live DB to set aside.
  asidePath: string | null;
}

// Install a verified snapshot over the live DB. Steps: gate → aside copy →
// install → WAL/SHM cleanup → post-restore integrity. Throws RestoreRefusedError
// on a gate failure (before touching anything) and Error on a copy/integrity
// failure. Returns the aside path so the CLI can point the operator at the
// rollback copy.
export function restoreCore(params: RestoreCoreParams): RestoreCoreResult {
  const { snapshotPath, livePath, snapshotOk, force } = params;

  // Gate: refuse an integrity-failed snapshot unless forced. This is the safety
  // net the drill pins — it holds regardless of how the CLI called us.
  if (!snapshotOk && !force) {
    throw new RestoreRefusedError("snapshot-failed-integrity");
  }
  // Gate: refuse a snapshot from a NEWER schema than this build (#472) — otherwise
  // the boot-time downgrade guard just refuses to start and points back here.
  if (
    !decideSnapshotVersion({
      snapshotUserVersion: params.snapshotUserVersion,
      buildMigrationCount: params.buildMigrationCount,
      force,
    }).ok
  ) {
    throw new RestoreRefusedError("snapshot-newer-schema");
  }
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`Snapshot not found: ${snapshotPath}`);
  }

  // 1. Copy the current live DB aside as a rollback point — MAIN file plus its
  //    -wal/-shm (#472): under --force with a busy/failed checkpoint the WAL may
  //    still hold the newest committed transactions, and step 2 unlinks it, so an
  //    aside of only the main file would silently drop them.
  let asidePath: string | null = null;
  if (fs.existsSync(livePath)) {
    const stamp = (params.now ?? new Date())
      .toISOString()
      .replace(/[:.]/g, "-");
    asidePath = `${livePath}.pre-restore-${stamp}`;
    fs.copyFileSync(livePath, asidePath);
    for (const suffix of ["-wal", "-shm"]) {
      const from = livePath + suffix;
      if (fs.existsSync(from)) fs.copyFileSync(from, asidePath + suffix);
    }
  }

  // 2. Install the snapshot via an ATOMIC swap (#472): copy to a temp sibling on
  //    the same filesystem, then rename over the live file. A kill mid-copy leaves
  //    the (untouched) live DB intact instead of a half-written torn file. Clear
  //    stale -wal/-shm only AFTER the rename so the next boot can't replay an old
  //    WAL over the freshly restored file.
  const tmpPath = livePath + ".restore-tmp";
  try {
    fs.copyFileSync(snapshotPath, tmpPath);
    fs.renameSync(tmpPath, livePath);
  } catch (e) {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* best effort */
      }
    }
    throw e;
  }
  for (const suffix of ["-wal", "-shm"]) {
    const p = livePath + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  // 3. Sanity-check: the restored live DB opens read-only and passes integrity.
  const live = new Database(livePath, { readonly: true, fileMustExist: true });
  try {
    const res = interpretIntegrityRows(live.pragma("integrity_check"));
    if (!res.ok) {
      throw new Error(`restored DB failed integrity_check: ${res.detail}`);
    }
  } finally {
    live.close();
  }

  return { asidePath };
}
