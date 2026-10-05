// Verify a supplied checkpoint through the real restore core, startup and profile readers in a disposable workspace.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { interpretIntegrityRows } from "../lib/backup-verify";
import { restoreCore } from "../lib/restore";
import { MIGRATIONS } from "../lib/migrations/versions";

async function main() {
  const input = path.resolve(process.argv[2] ?? "/app/data");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "allos-restore-"));
  const originalCwd = process.cwd();
  let connection: Database.Database | undefined;
  try {
    const livePath = path.join(workspace, "data", "allos.db");
    fs.mkdirSync(path.dirname(livePath));
    // SQLite may create WAL sidecars even on a read-only handle; inspect a private copy.
    const snapshotPath = path.join(workspace, "checkpoint.db");
    fs.copyFileSync(path.join(input, "allos.db"), snapshotPath);
    const snapshot = new Database(snapshotPath, {
      readonly: true,
      fileMustExist: true,
    });
    let snapshotOk: boolean, snapshotUserVersion: number;
    try {
      snapshotOk = interpretIntegrityRows(
        snapshot.pragma("integrity_check")
      ).ok;
      snapshotUserVersion = snapshot.pragma("user_version", {
        simple: true,
      }) as number;
    } finally {
      snapshot.close();
    }
    restoreCore({
      snapshotPath,
      livePath,
      snapshotOk,
      snapshotUserVersion,
      buildMigrationCount: MIGRATIONS.length,
      force: false,
    });
    const uploads = path.join(input, "uploads");
    if (fs.existsSync(uploads))
      fs.cpSync(uploads, path.join(workspace, "data", "uploads"), {
        recursive: true,
      });

    // Imports capture paths and open the singleton, so isolate them before loading application code.
    process.chdir(workspace);
    process.env.ALLOS_DB_PATH = livePath;
    process.env.ALLOS_MIGRATION_SNAPSHOT_DIR = path.join(
      workspace,
      "data",
      "backups",
      "pre-migration"
    );
    const { rawDb } = await import("../lib/db");
    connection = rawDb;
    const { collectExportSnapshot } = await import("../lib/export-full");
    let files = 0;
    const profiles = rawDb
      .prepare("SELECT id, name FROM profiles ORDER BY id")
      .all() as { id: number; name: string }[];
    for (const profile of profiles) {
      const exported = collectExportSnapshot(profile.id, profile.name, {
        includeMedia: true,
        requiredFiles: true,
      });
      const held = [...exported.files, ...(exported.media ?? [])];
      const photo = exported.profilePhoto;
      if (photo) held.push(photo);
      for (const file of held) {
        const handle = fs.openSync(file.absPath, "r");
        try {
          fs.readSync(handle, Buffer.alloc(1), 0, 1, 0);
        } finally {
          fs.closeSync(handle);
        }
      }
      files += held.length;
    }
    if (!interpretIntegrityRows(rawDb.pragma("integrity_check")).ok)
      throw new Error("Restored database failed integrity");
    console.log(
      JSON.stringify({
        ok: true,
        schemaVersion: rawDb.pragma("user_version", { simple: true }),
        files,
      })
    );
  } finally {
    connection?.close();
    process.chdir(originalCwd);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}
main().catch(() => {
  console.error("Allos restore verification failed");
  process.exitCode = 1;
});
