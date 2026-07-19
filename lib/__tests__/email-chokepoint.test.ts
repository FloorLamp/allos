import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static boundary guard for the outbound-email chokepoint (issue #985), mirroring
// the Telegram chokepoint (#454). Every email send goes through lib/email.ts, the
// SOLE importer of `nodemailer` — that's where TLS enforcement, the "not configured
// ⇒ refuse" gate, and the deterministic test capture live. This reads the repo's own
// source as TEXT (no DB/network — pure) and fails the build if any other module
// imports nodemailer, i.e. a new sender tries to reach the wire directly and would
// re-implement (or forget) a cross-cutting obligation.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CHOKEPOINT = "lib/email.ts";
const SCAN_DIRS = ["lib", "app", "scripts"];

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

describe("outbound email chokepoint boundary (issue #985)", () => {
  it("nodemailer is imported only by the chokepoint module", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (rel === CHOKEPOINT) continue;
      if (
        /from\s+["']nodemailer["']|require\(\s*["']nodemailer["']\s*\)/.test(
          text
        )
      ) {
        offenders.push(`${rel} imports nodemailer`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the chokepoint module exists", () => {
    expect(fs.existsSync(path.join(REPO, CHOKEPOINT))).toBe(true);
  });
});
