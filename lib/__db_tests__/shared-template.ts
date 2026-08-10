import path from "node:path";

// Where the shared-registry DB tier keeps its pre-migrated template database.
//
// Deterministic on purpose: vitest's globalSetup builds it in the MAIN process
// while the setup file copies it from inside each WORKER, and a computed path
// both sides derive independently avoids passing a value across that boundary.
// It lives under node_modules/.cache so it is already git-ignored and is thrown
// away by a clean install.
export function templateDbPath(): string {
  return path.join(
    process.cwd(),
    "node_modules",
    ".cache",
    "allos-db-tests",
    "template.db"
  );
}

// Sidecars SQLite (and our boot lock) can leave beside the template. Cleared
// before a rebuild so a stale WAL can never be read as part of the schema.
export const TEMPLATE_SIDECARS = ["", "-wal", "-shm", ".boot-lock"] as const;
