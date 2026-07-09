// Restore tooling for SQLite snapshots (issue #25).
//
//   npm run restore                    # LIST snapshots + their integrity status
//   npm run restore -- <snapshot.db>   # RESTORE the named snapshot to the live DB
//   npm run restore -- <snapshot.db> --yes    # skip the confirmation prompt
//   npm run restore -- <snapshot.db> --force  # also override safety refusals
//
// Restore is deliberate and safe:
//   1. VERIFY the chosen snapshot (PRAGMA integrity_check) before trusting it.
//   2. REFUSE if the app appears to be running (best-effort — see note below) so a
//      live connection isn't clobbered mid-flight.
//   3. Copy the current live DB ASIDE (allos.db.pre-restore-<ts>) as a rollback.
//   4. Copy the snapshot into place and clear any stale -wal/-shm sidecars so the
//      next boot can't replay an old WAL over the restored file.
//
// App-running detection is BEST-EFFORT: in WAL mode an *idle* app connection may
// not be detected, so ALWAYS stop the container before restoring. `--force`
// overrides both the running check and a failed-integrity refusal.

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import Database from "better-sqlite3";
import { dbFilePath } from "../lib/db";
import {
  backupsDir,
  listBackupNames,
  readVerification,
  verifySnapshot,
} from "../lib/backup";
import { interpretIntegrityRows, decideRestore } from "../lib/backup-verify";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Print every snapshot with size + last-known verification status.
function list() {
  const names = listBackupNames();
  if (names.length === 0) {
    console.log("No snapshots found in", backupsDir());
    return;
  }
  console.log(`Snapshots in ${backupsDir()} (newest first):\n`);
  for (const name of names) {
    const st = fs.statSync(path.join(backupsDir(), name));
    const v = readVerification(name);
    const status = v
      ? v.integrity === "ok"
        ? "verified ok"
        : `FAILED (${v.detail ?? "integrity"})`
      : "unverified";
    console.log(`  ${name}  ${fmtBytes(st.size).padStart(9)}  [${status}]`);
  }
  console.log("\nRestore with:  npm run restore -- <snapshot.db>");
}

// Best-effort "is the app connected?" probe. Tries to acquire the write lock and
// a TRUNCATE checkpoint; a SQLITE_BUSY from either means another connection is
// actively using the DB. Cannot reliably see an idle WAL reader — hence the
// stop-the-container guidance above. Any non-busy error is treated as "unknown"
// (don't block) so a fresh/empty environment can still restore.
function appAppearsRunning(livePath: string): boolean {
  if (!fs.existsSync(livePath)) return false;
  let probe: Database.Database | null = null;
  try {
    probe = new Database(livePath);
    probe.pragma("busy_timeout = 0");
    const chk = probe.pragma("wal_checkpoint(TRUNCATE)") as Array<{
      busy?: number;
    }>;
    if (Array.isArray(chk) && chk[0]?.busy === 1) return true;
    probe.exec("BEGIN EXCLUSIVE");
    probe.exec("ROLLBACK");
    return false;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return /SQLITE_BUSY|database is locked/i.test(msg);
  } finally {
    try {
      probe?.close();
    } catch {
      /* ignore */
    }
  }
}

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function restore(name: string, opts: { force: boolean; yes: boolean }) {
  const dir = backupsDir();
  const snapPath = path.join(dir, name);
  if (!fs.existsSync(snapPath)) {
    console.error(`Snapshot not found: ${snapPath}`);
    console.error("Run `npm run restore` with no arguments to list snapshots.");
    process.exit(1);
  }

  // 1. Verify the snapshot now (fresh check, also refreshes its sidecar).
  const v = verifySnapshot(name);
  const snapshotOk = v.integrity === "ok";
  console.log(
    `Snapshot integrity: ${snapshotOk ? "ok" : `FAILED — ${v.detail ?? ""}`}`
  );

  // 2. Safety gate: app-running + integrity, both overridable with --force.
  const livePath = dbFilePath();
  const running = appAppearsRunning(livePath);
  const decision = decideRestore({
    snapshotOk,
    appRunning: running,
    force: opts.force,
  });
  if (!decision.proceed) {
    if (decision.reason === "app-running") {
      console.error(
        "Refusing: the app appears to be running (a live DB connection was detected)."
      );
      console.error(
        "Stop the container/app first, then retry (or pass --force)."
      );
    } else {
      console.error(
        "Refusing: the snapshot failed its integrity check. Pass --force to restore it anyway."
      );
    }
    process.exit(1);
  }

  if (!opts.yes) {
    const ok = await confirm(
      `\nReplace ${livePath}\n   with ${snapPath}?\nThe current DB will be copied aside first. [y/N] `
    );
    if (!ok) {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  // 3. Copy the current live DB aside as a rollback point.
  if (fs.existsSync(livePath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const aside = `${livePath}.pre-restore-${stamp}`;
    try {
      fs.copyFileSync(livePath, aside);
      console.log(`Backed up current DB aside: ${aside}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Could not copy the current DB aside (${msg}) — aborting.`);
      process.exit(1);
    }
  }

  // 4. Copy the snapshot into place, then clear stale WAL/SHM sidecars so the next
  //    boot doesn't replay an old WAL over the freshly restored file.
  try {
    fs.copyFileSync(snapPath, livePath);
    for (const suffix of ["-wal", "-shm"]) {
      const p = livePath + suffix;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Restore copy failed: ${msg}`);
    process.exit(1);
  }

  // Sanity-check the restored live DB opens + passes integrity_check.
  try {
    const live = new Database(livePath, {
      readonly: true,
      fileMustExist: true,
    });
    const res = interpretIntegrityRows(live.pragma("integrity_check"));
    live.close();
    if (!res.ok) {
      console.error(
        `WARNING: restored DB failed integrity_check: ${res.detail}`
      );
      process.exit(1);
    }
  } catch (e) {
    console.error("WARNING: could not open the restored DB:", e);
    process.exit(1);
  }

  console.log(`\nRestored ${name} -> ${livePath}. Start the app to use it.`);
  process.exit(0);
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const yes = args.includes("--yes") || args.includes("-y") || force;
  const positional = args.filter((a) => !a.startsWith("-"));
  const target = positional[0];

  if (!target || target === "list") {
    list();
    process.exit(0);
  }
  await restore(target, { force, yes });
}

main().catch((e) => {
  console.error("restore failed", e);
  process.exit(1);
});
