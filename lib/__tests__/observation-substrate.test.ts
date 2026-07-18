import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static boundary guard for the observation-substrate helpers (issue #944). The
// eight observation-shaped tables are NOT merged (#860 decided that); instead the
// three behaviors every ingest path shares are extracted as ONE helper each, and
// this test reads the repo's own source as TEXT (no DB, no network — pure vitest
// tier) and fails the build if an importer re-implements one instead of calling it.
// The class of drift this prevents is exactly what shipped before #944: activities
// consulted `found.edited` raw while body-metrics/vitals went through isEditLocked
// (#133), and each upsert bumped the insert/update/unchanged split by hand.
//
//   1. edit-lock (#133)  — the keyed upserts consult the `edited` lock ONLY through
//                          isEditLocked (lib/integrations/sync-log.ts).
//   2. source-dedup (#14) — the insert/update/unchanged split is bumped ONLY by
//                          tallyUpsert (lib/integrations/sync-log.ts); no upsert
//                          increments those three UpsertCounts segments by hand.
//   3. is_latest (#944)  — the latest-per-group ordering rule lives ONLY in
//                          lib/latest-per-group.ts; the derived-table merge calls it.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// The module that owns the shared upsert accounting/lock primitives — the sole place
// allowed to import the guarded pieces and to bump the dedup split directly.
const ACCOUNTING = "lib/integrations/sync-log.ts";
// The keyed-upsert module: every integration parser routes into these upserts.
const UPSERTS = "lib/integrations/normalize.ts";
// The pure latest-per-group helper and its single JS consumer (the derived-table
// merge that re-decides is_latest over the combined stored+derived set).
const LATEST_HELPER = "lib/latest-per-group.ts";
const LATEST_CONSUMER = "lib/derived-table.ts";

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

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

// Strip line + block comments AND string literals so a mention of `edited` in prose
// (a doc comment) or inside a SQL SELECT string ("SELECT id, edited, …") can't trip
// the scanners — only real code tokens count.
function stripCommentsAndStrings(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

describe("observation-substrate helpers boundary (issue #944)", () => {
  // ---- 1. edit-lock (#133) -------------------------------------------------
  it("the keyed upserts consult the edit-lock only through isEditLocked", () => {
    expect(/export function isEditLocked\b/.test(read(ACCOUNTING))).toBe(true);
    const src = read(UPSERTS);
    expect(src.includes("isEditLocked")).toBe(true);

    const code = stripCommentsAndStrings(src);
    const offenders: string[] = [];
    // Every `<obj>.edited` token that is NOT the `counts.edited` split segment and
    // NOT a write (`.edited++` / `.edited =`) is a LOCK CONSULT and must be wrapped
    // in isEditLocked(<obj>.edited). A raw `found.edited` truthiness check is the
    // exact pre-#944 activities bug.
    const re = /([A-Za-z_$][\w$]*)\.edited\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const obj = m[1];
      const after = code.slice(re.lastIndex, re.lastIndex + 3);
      const isWrite = /^\s*(\+\+|\+=|=[^=])/.test(after);
      if (obj === "counts" || isWrite) continue; // UpsertCounts split, not the lock
      const before = code.slice(0, m.index);
      if (!before.endsWith("isEditLocked(")) {
        offenders.push(`${UPSERTS}: raw \`${obj}.edited\` lock read`);
      }
    }
    expect(
      offenders,
      `Edit-lock consults must route through isEditLocked (issue #133/#944):\n${offenders.join(
        "\n"
      )}`
    ).toEqual([]);
  });

  // ---- 2. source-dedup (#14) ----------------------------------------------
  it("the insert/update/unchanged split is bumped only by the shared tallyUpsert", () => {
    const acc = read(ACCOUNTING);
    expect(/export function classifyUpsert\b/.test(acc)).toBe(true);
    expect(/export function tallyUpsert\b/.test(acc)).toBe(true);

    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (rel === ACCOUNTING) continue; // tallyUpsert lives here, may increment
      if (/\.(?:inserted|updated|unchanged)\+\+/.test(stripCommentsAndStrings(text))) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `The dedup split (inserted/updated/unchanged) must be bumped via tallyUpsert ` +
        `(lib/integrations/sync-log.ts), not a raw counter++ (issue #14/#944):\n${offenders.join(
          "\n"
        )}`
    ).toEqual([]);
  });

  // ---- 3. is_latest (#944) -------------------------------------------------
  it("latest-per-group ordering lives in one helper, and the derived-table merge calls it", () => {
    const helper = read(LATEST_HELPER);
    expect(/export function latestByGroup\b/.test(helper)).toBe(true);
    expect(/export function isLaterReading\b/.test(helper)).toBe(true);

    const consumer = stripCommentsAndStrings(read(LATEST_CONSUMER));
    // The consumer routes its family-latest through the helper …
    expect(consumer.includes("latestByGroup(")).toBe(true);
    // … and does NOT re-implement the same-date ordering rule inline (the reduction
    // this helper replaced). `.date >` / `.date ===` comparisons in the latest
    // selection are the shape that would drift from the SQL LATEST_IDS_CTE.
    expect(/\.date\s*>\s*\w+\.date/.test(consumer)).toBe(false);
  });
});
