// DB INTEGRATION TIER setup (vitest.db.config.ts `setupFiles`). Runs once per
// test file, BEFORE that file's module graph is imported — so the env it sets is
// visible to the hoisted `import { db } from "@/lib/db"` every db-test performs.
//
// It points the `db` singleton (lib/db.ts createDb) at a throwaway, per-file temp
// database via ALLOS_DB_PATH, so importing lib/db.ts (and the query layer) never
// opens — or depends on — a developer's real data/allos.db. Each test file gets a
// fresh temp directory (isolation; vitest runs files in separate module
// registries), torn down in afterAll. Also pins ADMIN_PASSWORD so bootstrapAuth,
// which runs inside migrate() on first open, is deterministic and doesn't print a
// generated password.

import { afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "allos-db-test-"));
process.env.ALLOS_DB_PATH = path.join(tmpDir, "test.db");
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";

afterAll(() => {
  // Best-effort: drop the whole temp dir (DB + WAL/SHM sidecars). The singleton
  // handle may still be open, but unlinking an open file is fine on Linux, and
  // the process exits right after the suite anyway.
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore — it's a throwaway temp dir under os.tmpdir()
  }
});
