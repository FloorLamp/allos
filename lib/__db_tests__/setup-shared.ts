// SHARED-REGISTRY DB TIER setup (vitest.db-shared.config.ts `setupFiles`).
//
// The isolated tier (setup.ts) gets a fresh module registry per test file, so
// setting ALLOS_DB_PATH at module scope is enough — the hoisted
// `import { db } from "@/lib/db"` in each file opens that file's own database.
//
// This tier runs with `isolate: false`: one worker imports lib/db.ts ONCE and
// reuses it across hundreds of files, which is the whole point (the 178
// migration modules are imported once per worker rather than once per file). The
// cost is that a module-scope env assignment no longer reaches the singleton, so
// per-file isolation has to be re-established explicitly: seed a fresh copy of
// the template and rebind the singleton onto it before each file's tests run.
//
// Only mock-free specs run here. The config excludes every file containing
// vi.mock(), because a shared registry cannot re-mock a module an earlier file
// already evaluated.
import { beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { templateDbPath } from "./shared-template";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";

// Fresh throwaway database for one test file, copied from the pre-migrated
// template. Returns the directory holding it so the caller can drop it later.
function seedDatabase(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allos-db-shared-"));
  const dbPath = path.join(dir, "test.db");
  fs.copyFileSync(templateDbPath(), dbPath);
  process.env.ALLOS_DB_PATH = dbPath;
  return dir;
}

function discard(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Throwaway directory under os.tmpdir(); a failure to unlink is not worth
    // failing a test file over.
  }
}

// Bootstrap seed: the FIRST file to import lib/db.ts in this worker opens
// whatever ALLOS_DB_PATH says at that moment, which happens before any hook runs.
let activeDir = seedDatabase();

// Module-scope state that outlives a test file once the registry is shared, and
// would otherwise answer the next file with the previous file's data. These live
// here rather than in lib/db.ts: db.ts sits at the bottom of the import graph and
// reaching up into the query layer from it would be a cycle. Each entry needs a
// REASON, and a new module-level cache fed by DB reads belongs on this list.
async function resetCarriedState(): Promise<void> {
  // #2066 dose-schedule history, memoized per profile with a 5s TTL — every
  // seeded file bootstraps the same low profile ids, so a hit from the previous
  // file is indistinguishable from this file's own data.
  const schedule = await import("../queries/intake/schedule");
  schedule.invalidateDoseScheduleVersions();
}

beforeAll(async () => {
  const previousDir = activeDir;
  activeDir = seedDatabase();
  const { reopenDatabaseForTests } = await import("../db");
  // Closes the handle still held on previousDir, which is what makes the
  // directory removable on Windows (an open file cannot be unlinked there).
  reopenDatabaseForTests();
  await resetCarriedState();
  if (previousDir !== activeDir) discard(previousDir);
});
