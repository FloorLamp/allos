import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static boundary guard for the write-transaction lock mode (issue #468). A plain
// `db.transaction(fn)` is DEFERRED: it opens a read snapshot and only tries to take
// the write lock at its FIRST write. If another connection committed in between, that
// upgrade throws SQLITE_BUSY *immediately* — NOT covered by busy_timeout. With three
// processes writing this file (the web app, the hourly notify tick, the poll
// sidecar), a read-then-write transaction hits that trap under the top-of-hour write
// burst and 500s. The fix routes every WRITE transaction through `writeTx` (BEGIN
// IMMEDIATE) and every read-only snapshot through `readTx` (DEFERRED, never writes),
// both in lib/db.ts. This test reads the repo's own source as TEXT (no DB, no
// network, so it stays "pure" in the vitest sense) and fails the build if any
// production module opens a raw `db.transaction(...)` — which would default back to
// DEFERRED and re-open the trap — instead of going through the helpers.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Directories scanned for production source.
const SCAN_DIRS = ["lib", "app", "scripts"];

// The ONLY files permitted to name `db.transaction(` directly:
//  - lib/db.ts defines writeTx/readTx (the sanctioned wrappers) in terms of it.
//  - The migration layer (runner + boot tasks + versioned migrations) manages its
//    own BEGIN IMMEDIATE + bounded SQLITE_BUSY retry via runBootTx / `.immediate()`
//    around the parallel-`next build` boot path (schema-utils.ts) — a different,
//    already-hardened concurrency contract than the request-path writeTx.
//  - lib/offline/queue-db.ts calls the browser IndexedDB `db.transaction(store, mode)`
//    — a completely unrelated API that merely shares the method name.
const ALLOWLIST = new Set<string>(["lib/db.ts", "lib/offline/queue-db.ts"]);

function isAllowlisted(rel: string): boolean {
  return ALLOWLIST.has(rel) || rel.startsWith("lib/migrations/");
}

function isExcluded(rel: string): boolean {
  return (
    rel.includes("__tests__") ||
    rel.includes("__db_tests__") ||
    rel.includes("__action_tests__") ||
    rel.endsWith(".test.ts") ||
    rel.endsWith(".test.tsx")
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (isExcluded(rel)) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

// Strip line and block comments so a mention of `db.transaction` in prose (e.g. a
// doc comment explaining the helper) can't trip the scanner — only real code counts.
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("write-transaction lock mode boundary (issue #468)", () => {
  it("no production module opens a raw db.transaction() — writes use writeTx, reads use readTx", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (isAllowlisted(rel)) continue;
      if (/\bdb\.transaction\s*\(/.test(stripComments(text))) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `These modules must route through writeTx (BEGIN IMMEDIATE) or readTx ` +
        `(read-only snapshot) from @/lib/db instead of a raw, DEFERRED ` +
        `db.transaction():\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the writeTx / readTx helpers exist in lib/db.ts", () => {
    const dbSrc = fs.readFileSync(path.join(REPO, "lib/db.ts"), "utf8");
    expect(/export function writeTx\b/.test(dbSrc)).toBe(true);
    expect(/export function readTx\b/.test(dbSrc)).toBe(true);
  });
});
