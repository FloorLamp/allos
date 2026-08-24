import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const UX_SERVED_DB_PREFIX = "allos-ux-walkthrough-";

// mkdtemp is the ownership claim: it atomically creates an unpredictable,
// private directory. The database path inside that directory has never existed,
// so the seed and server share a fresh file-backed target without an exists/check
// race against a caller-owned path.
export function allocateUxServedDb(tmpRoot = os.tmpdir()) {
  const root = path.resolve(tmpRoot);
  const dir = fs.mkdtempSync(path.join(root, UX_SERVED_DB_PREFIX));
  fs.chmodSync(dir, 0o700);
  const dbPath = path.join(dir, "allos.db");
  if (fs.existsSync(dbPath)) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `Owned UX database path was unexpectedly pre-created: ${dbPath}`
    );
  }
  return { root, dir, dbPath };
}

export function assertUxServedDbUnused(allocation) {
  if (fs.existsSync(allocation.dbPath)) {
    throw new Error(
      `Owned UX database path was pre-created before use: ${allocation.dbPath}`
    );
  }
}

export function cleanupUxServedDb(allocation) {
  const expectedParent = path.resolve(allocation.root);
  const dir = path.resolve(allocation.dir);
  if (
    path.dirname(dir) !== expectedParent ||
    !path.basename(dir).startsWith(UX_SERVED_DB_PREFIX)
  ) {
    throw new Error(
      `Refusing to clean an unowned UX database directory: ${dir}`
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
