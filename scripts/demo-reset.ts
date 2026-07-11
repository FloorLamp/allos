// Demo-instance reset (#181).
//
//   npm run demo-reset -- --yes     # wipe + reseed the demo DB (for a nightly cron)
//   npm run demo-reset              # same, but prompts to confirm first
//   npm run demo-reset -- --force   # also override the "not a demo instance" refusal
//
// Swaps in a PRISTINE seeded database and clears data/uploads, so a public demo
// returns to a known-good state on a schedule (a host cron). It reuses the restore
// mechanics: it clears the stale -wal/-shm sidecars (so the next boot can't replay
// an old WAL over the wiped file) and integrity-checks the freshly seeded DB before
// declaring success (scripts/restore.ts, lib/backup-verify).
//
// SAFETY: this is DESTRUCTIVE — it deletes the live DB and every uploaded file. It
// refuses to run unless ALLOS_DEMO_MODE is set (so it can never wipe a real family
// instance by mistake); --force overrides that single refusal. Run it with the app
// STOPPED (stop-reset-start): reseeding opens a fresh connection, and a live app
// holding the old DB open would race it.

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
// Pure helpers only — importing lib/db here would OPEN (and create) the very DB we
// are about to delete, so paths are recomputed inline to mirror lib/db.dbFilePath
// and lib/backup.uploadsDir.
import { interpretIntegrityRows } from "../lib/backup-verify";
import { isDemoModeEnv } from "../lib/demo";

// Mirrors lib/db.dbFilePath() without importing lib/db (which has a connect-on-
// import side effect).
function liveDbPath(): string {
  return (
    process.env.ALLOS_DB_PATH || path.join(process.cwd(), "data", "allos.db")
  );
}

// Mirrors lib/backup.uploadsDir().
function uploadsPath(): string {
  return path.join(process.cwd(), "data", "uploads");
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

// Delete the live DB file plus any stale -wal/-shm sidecars (restore's step 4).
function wipeDb(livePath: string): void {
  for (const p of [livePath, `${livePath}-wal`, `${livePath}-shm`]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

// Remove every entry directly under data/uploads, keeping the directory itself.
// Path-contained: only removes children of uploadsDir, never follows anything out.
function clearUploads(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const yes = args.includes("--yes") || args.includes("-y");

  if (!isDemoModeEnv(process.env.ALLOS_DEMO_MODE) && !force) {
    console.error(
      "Refusing: ALLOS_DEMO_MODE is not set, so this does not look like a demo instance."
    );
    console.error(
      "This deletes the live DB and all uploads. Set ALLOS_DEMO_MODE=1 (or pass --force) only if that is what you want."
    );
    process.exit(1);
  }

  const livePath = liveDbPath();
  const uploads = uploadsPath();

  if (!yes) {
    const ok = await confirm(
      `\nThis will DELETE ${livePath} and everything under ${uploads},\nthen reseed a pristine demo database. Continue? [y/N] `
    );
    if (!ok) {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  console.log("Wiping the live database and uploads…");
  wipeDb(livePath);
  clearUploads(uploads);

  // Reseed in a CHILD process: scripts/seed.ts imports lib/db, which recreates the
  // wiped file (bootstrap admin + profile 1) before populating it. ALLOS_DEMO_MODE
  // is forced on for the child so the seed also creates the read-only demo login +
  // grants; the rest of the env (ADMIN_PASSWORD, ALLOS_DB_PATH) is inherited.
  console.log("Reseeding a pristine demo database…");
  execFileSync("tsx", ["scripts/seed.ts"], {
    stdio: "inherit",
    env: { ...process.env, ALLOS_DEMO_MODE: "1" },
  });

  // Integrity-check the freshly seeded DB (restore's final sanity gate).
  try {
    const live = new Database(livePath, {
      readonly: true,
      fileMustExist: true,
    });
    const res = interpretIntegrityRows(live.pragma("integrity_check"));
    live.close();
    if (!res.ok) {
      console.error(`Reseeded DB failed integrity_check: ${res.detail}`);
      process.exit(1);
    }
  } catch (e) {
    console.error("Could not open the reseeded DB:", e);
    process.exit(1);
  }

  console.log(
    `\n✅ Demo reset complete. Start the app to serve the fresh demo.`
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("demo-reset failed", e);
  process.exit(1);
});
