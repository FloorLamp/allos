import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Full-handle boot helpers cannot import the request singleton without a cycle.
// Keep their existing IMMEDIATE-wrapper check here. Request db.transaction calls
// are rejected by the exported db type, including renamed imports.
// This source check recognizes wrapper spellings; it does not prove execution.
const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const HANDLE_OWNERS = new Set([
  "lib/photo/metadata-backfill.ts",
  "lib/canonical-alias-merge-db.ts",
  "lib/cycling-stream-summary-db.ts",
  "lib/settings/ai-tiers.ts",
  "lib/migrations/runner.ts",
  "lib/migrations/boot-tasks.ts",
]);

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function unguardedTransactions(text: string): number {
  const source = stripComments(text);
  const transactions = [...source.matchAll(/\bdb\.transaction\s*\(/g)];
  return transactions.filter((match, i) => {
    const start = match.index ?? 0;
    const prefix = source.slice(Math.max(0, start - 80), start);
    if (/\brunBootTx\s*\(\s*$/.test(prefix)) return false;

    // A named transaction's `.immediate()` / runBootTx call follows its creation.
    // Stop at the next transaction so one wrapper cannot cover two raw calls.
    const end = transactions[i + 1]?.index ?? source.length;
    const suffix = source
      .slice(start + match[0].length, end)
      // A direct wrapper immediately before the next transaction belongs to that
      // next call; it must not make this transaction look guarded.
      .replace(/\brunBootTx\s*\(\s*$/, "");
    return !/\.immediate\s*\(|\brunBootTx\s*\(/.test(suffix);
  }).length;
}

describe("full-handle transaction owners", () => {
  it("keeps boot and AI-tier writes behind their IMMEDIATE wrappers", () => {
    const offenders = [...HANDLE_OWNERS].filter(
      (file) =>
        unguardedTransactions(fs.readFileSync(path.join(REPO, file), "utf8")) >
        0
    );
    expect(offenders).toEqual([]);
  });

  it("rejects a handle-owned transaction when its IMMEDIATE wrapper is removed", () => {
    expect(
      unguardedTransactions(`db.transaction(() => write()).immediate()`)
    ).toBe(0);
    expect(
      unguardedTransactions(
        `const tx = db.transaction(() => write()); runBootTx(tx);`
      )
    ).toBe(0);
    expect(unguardedTransactions(`db.transaction(() => write())`)).toBe(1);
    expect(
      unguardedTransactions(
        `db.transaction(() => first()); runBootTx(db.transaction(() => second()))`
      )
    ).toBe(1);
  });
});
