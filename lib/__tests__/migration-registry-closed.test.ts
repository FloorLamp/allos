import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENUM_CHECKS } from "@/lib/migrations/enum-checks";

// "Mechanism closed, not removed" guard (issue #119). The pre-runner idempotency
// mechanisms — `addColumnIfMissing` (+ its ADDITIVE_COLUMNS registry) and the
// `ENUM_CHECKS` reconcile — are frozen INSIDE the baseline migration. Going
// forward, a new column is a plain `ALTER TABLE` in a new migration and a grown
// enum is a rebuild migration; neither reopens these mechanisms. This pure source
// scan fails the build if a NEW caller of the closed mechanism appears outside the
// frozen baseline, so the escape hatch can't be quietly reused.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BASELINE = "lib/migrations/versions/001-baseline.ts";
// enum-checks.ts is the mechanism's DEFINITION module (the registry + the
// reconcile function live there); it is not a "caller" and stays allowed.
const ENUM_DEF = "lib/migrations/enum-checks.ts";

function walk(dir: string, out: string[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      walk(p, out);
    } else if (e.isFile() && (p.endsWith(".ts") || p.endsWith(".tsx"))) {
      out.push(p);
    }
  }
}

function sourceFiles(): { rel: string; src: string }[] {
  const all: string[] = [];
  walk(path.join(REPO, "lib"), all);
  walk(path.join(REPO, "app"), all);
  walk(path.join(REPO, "scripts"), all);
  return all
    .filter((f) => {
      const rel = path.relative(REPO, f).split(path.sep).join("/");
      // Test files legitimately name these mechanisms (this file included, and the
      // migrate/enum-drift DB tests) — exclude the whole test tier.
      return !rel.includes("__tests__") && !rel.includes("__db_tests__");
    })
    .map((f) => ({
      rel: path.relative(REPO, f).split(path.sep).join("/"),
      // Strip comments so a prose MENTION of a closed mechanism (e.g. the
      // owned-tables.ts note "…via addColumnIfMissing (a pre-#67 table)") isn't
      // mistaken for a call. Coarse but sufficient for a lint scan: drop /*…*/
      // blocks and //… line tails.
      src: stripComments(fs.readFileSync(f, "utf8")),
    }));
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("closed mechanism — addColumnIfMissing is frozen in the baseline", () => {
  it("no source file outside the baseline migration calls addColumnIfMissing", () => {
    const offenders = sourceFiles()
      .filter((f) => f.rel !== BASELINE)
      // A call site is `addColumnIfMissing(` (definition + calls both live in the
      // baseline). Matching the open-paren avoids flagging a bare mention.
      .filter((f) => /addColumnIfMissing\s*\(/.test(f.src))
      .map((f) => f.rel);
    expect(
      offenders,
      `addColumnIfMissing is CLOSED to new callers — a new column must be an ` +
        `ALTER TABLE in a new migration, not addColumnIfMissing. Offending ` +
        `files: ${JSON.stringify(offenders)}`
    ).toEqual([]);
  });
});

describe("closed mechanism — ENUM_CHECKS reconcile is frozen in the baseline", () => {
  it("no source file outside the baseline calls reconcileEnumChecks", () => {
    const offenders = sourceFiles()
      .filter((f) => f.rel !== BASELINE && f.rel !== ENUM_DEF)
      .filter((f) => /reconcileEnumChecks\s*\(/.test(f.src))
      .map((f) => f.rel);
    expect(
      offenders,
      `reconcileEnumChecks is CLOSED to new call sites — grow an enum with a ` +
        `rebuild migration instead. Offending files: ${JSON.stringify(offenders)}`
    ).toEqual([]);
  });

  it("the ENUM_CHECKS registry is frozen at its baseline size (no new entries)", () => {
    // The registry mirrors the frozen baseline CREATE blocks. A NEW enum (or an
    // enum GROWN) must ship as its own migration, NOT as a new ENUM_CHECKS entry.
    // Pinning the count makes adding an entry fail here, pointing to a migration.
    expect(ENUM_CHECKS.length).toBe(16);
  });
});
