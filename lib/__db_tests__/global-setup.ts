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
import {
  templateDbPath,
  templateKey,
  templateKeyPath,
} from "./shared-template";

export default async function setup(): Promise<void> {
  const target = templateDbPath();

  // Reuse the template when nothing that decides its schema has changed. The
  // build below is ~0.8s of importing 191 migration modules and replaying the
  // chain, and it was paid on every invocation — including a developer running
  // ONE test file, where the whole run is ~5.4s of which 0.1s is the test.
  //
  // The key is a hash of the migration sources themselves (see templateKey), so
  // it cannot go stale behind a manifest that was not updated. A miss rebuilds;
  // being wrong would show as a test failing on a missing column, never as a red
  // test passing.
  const key = templateKey();
  if (fs.existsSync(target) && readKey() === key) return;

  // BUILD BESIDE THE TEMPLATE AND MOVE IT IN, never onto it. Two runs can share
  // this path legitimately — the directory is the fingerprint, so sharing means
  // identical inputs — and a build that emptied the destination first would take
  // the file a sibling's workers are mid-`copyFileSync` from, which is the
  // #5893 failure in a smaller window. `rename` replaces the name atomically, so
  // the path a worker opens is either the old complete template or the new one
  // and never absent.
  //
  // It also retires the old clear-the-sidecars step: the WAL, the SHM and the
  // boot lock are now born and destroyed inside this staging directory, so no
  // stale sidecar can be left beside the template to be read back as schema. And
  // everything below can throw — a failing migration, a failing boot task —
  // leaving the destination untouched rather than half-written, which is what
  // dropping the key first used to have to cover for.
  //
  // Beside the destination rather than in `/tmp`, because `rename` is only
  // atomic within one filesystem and `node_modules` need not be on the same one.
  // Named for THIS process, so a concurrent build is a separate directory and the
  // only staging any run removes is its own; a killed run strands one small
  // directory that the next run under that pid clears.
  const staging = path.join(path.dirname(target), `building-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const built = path.join(staging, "template.db");

  // Point the singleton at the STAGED copy for the duration of the build, then
  // put the environment back so nothing downstream inherits it.
  const priorPath = process.env.ALLOS_DB_PATH;
  const priorAdmin = process.env.ADMIN_PASSWORD;
  process.env.ALLOS_DB_PATH = built;
  // Pin the bootstrap password so bootTasks is deterministic and never prints a
  // generated one, matching the isolated tier's setup.
  process.env.ADMIN_PASSWORD = priorAdmin ?? "db-test-admin-pw";

  try {
    const { db, rawDb } = await import("../db");
    // Fold the WAL into the main file so a single copyFileSync yields a complete
    // database; a clean close then removes the emptied sidecar.
    db.pragma("wal_checkpoint(TRUNCATE)");
    rawDb.close();
    if (!fs.existsSync(built)) {
      throw new Error(
        `Template database was not created at ${built}. The shared-registry DB ` +
          `tier cannot seed its per-file databases without it.`
      );
    }
    fs.renameSync(built, target);
  } finally {
    if (priorPath === undefined) delete process.env.ALLOS_DB_PATH;
    else process.env.ALLOS_DB_PATH = priorPath;
    if (priorAdmin === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = priorAdmin;
    fs.rmSync(staging, { recursive: true, force: true });
  }

  // LAST, and only once the template is known to exist: the key's presence is
  // the claim that a complete template built from these inputs is on disk.
  fs.writeFileSync(templateKeyPath(), key + "\n");
}

/** The fingerprint recorded beside the template, or null when there is none. */
function readKey(): string | null {
  try {
    return fs.readFileSync(templateKeyPath(), "utf8").trim();
  } catch {
    return null;
  }
}
