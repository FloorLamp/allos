// globalSetup for the shared-registry DB tier (vitest.db-shared.config.ts).
//
// Builds the migrated schema ONCE per run, in the main process, so the 178
// migrations are executed a single time instead of once per test file. Every
// worker then starts a file by copying this file (~3ms) instead of replaying the
// migration list (~300ms).
//
// The template is produced by the REAL boot path — importing lib/db.ts runs
// runMigrations() and bootTasks() exactly as production does — so a copy of it is
// a genuinely booted database, at the current user_version, not a hand-built
// approximation. runMigrations is version-gated, so reopening a copy re-runs the
// per-boot tasks and no migrations.
import fs from "node:fs";
import path from "node:path";
import { templateDbPath, TEMPLATE_SIDECARS } from "./shared-template";

export default async function setup(): Promise<void> {
  const target = templateDbPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  for (const suffix of TEMPLATE_SIDECARS) {
    fs.rmSync(target + suffix, { force: true });
  }

  // Point the singleton at the template for the duration of the build, then put
  // the environment back so nothing downstream inherits it.
  const priorPath = process.env.ALLOS_DB_PATH;
  const priorAdmin = process.env.ADMIN_PASSWORD;
  process.env.ALLOS_DB_PATH = target;
  // Pin the bootstrap password so bootTasks is deterministic and never prints a
  // generated one, matching the isolated tier's setup.
  process.env.ADMIN_PASSWORD = priorAdmin ?? "db-test-admin-pw";

  try {
    const { db } = await import("../db");
    // Fold the WAL into the main file so a single copyFileSync yields a complete
    // database; a clean close then removes the emptied sidecar.
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
  } finally {
    if (priorPath === undefined) delete process.env.ALLOS_DB_PATH;
    else process.env.ALLOS_DB_PATH = priorPath;
    if (priorAdmin === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = priorAdmin;
  }

  if (!fs.existsSync(target)) {
    throw new Error(
      `Template database was not created at ${target}. The shared-registry DB ` +
        `tier cannot seed its per-file databases without it.`
    );
  }
}
