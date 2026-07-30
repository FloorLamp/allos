import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Source-scan guard for the #1505 obligation collapse. It exists because the
// collapse could not be complete at the storage layer:
//
// The rebuilt `intake_items` still carries inert `priority` and `as_needed` columns.
// Not as a hedge — `migrate()` applies every migration unconditionally and the
// DB-test harness replays it against an already-migrated database, while migrations
// 092 and 101 (shipped, immutable) hold prepared statements that NAME those columns.
// SQLite validates a statement at PREPARE time, before any row is examined, so
// dropping them makes those two migrations throw on every replay.
//
// Two dead columns sitting in the schema are precisely how a collapsed model
// un-collapses: the next person to need "is this PRN?" finds `as_needed` in
// `PRAGMA table_info` and writes to it, and now there are two answers again. This
// test makes that a build failure. Application code asks `isPrn(item)` and reads
// `item.obligation`; nothing else may name either retired column.
//
// The scan is TEXT over the repo's own sources (no DB, no network), the same shape as
// the telegram-chokepoint / profile-scoping guards.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components", "lib", "scripts", "e2e"];

// The retired COLUMN, as it appears in SQL and in a stored-row property position.
//
// Deliberately not `asNeeded` (camel): that name is alive and correct as a DERIVED
// local/prop across the medication UI — `const asNeeded = obligation === "may"` and
// the extraction shape's parsed-sig field. The collapse removed a second SOURCE OF
// TRUTH, not the English phrase; banning the word would force worse names for a
// concept that still exists as a reading of the one field.
const RETIRED = ["as_needed"];

// Where they are legitimately allowed to appear:
//   • the versioned migrations — 001 created them, 092/101 insert into them, and 124
//     is the collapse itself. All frozen or self-describing.
//   • this guard.
//   • nothing else. Derived `asNeeded` locals are not scanned at all — see RETIRED.
//   • the two DB specs that rebuild a HISTORICAL schema from the frozen migrations
//     (administration-ledger at v40, situations at v28) and must therefore speak that
//     schema's vocabulary — they are testing the migrations, not the model.
function isExempt(rel: string): boolean {
  return (
    rel.startsWith("lib/migrations/") ||
    rel === "lib/__db_tests__/administration-ledger.test.ts" ||
    rel === "lib/__db_tests__/situations.test.ts" ||
    // The single-entry guard's own allowlist quotes migrations 092/101 VERBATIM to
    // identify them; changing that text would silently un-allowlist them.
    rel === "lib/__tests__/import-single-entry.test.ts" ||
    rel.endsWith("lib/__tests__/obligation-collapse-guard.test.ts")
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry.name)) {
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
      if (isExempt(rel)) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

describe("the obligation collapse stays collapsed (#1505)", () => {
  it("no application source names the retired as_needed column", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      text.split("\n").forEach((line, i) => {
        // A line that only TALKS about the retired flag (a comment explaining the
        // collapse) is fine; a line that USES it is not.
        if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
        for (const name of RETIRED) {
          if (new RegExp(`\\b${name}\\b`).test(line)) {
            offenders.push(`${rel}:${i + 1}`);
            return;
          }
        }
      });
    }
    expect(
      offenders,
      `#1505 collapsed as_needed into obligation. The column survives in the ` +
        `schema ONLY so replayed pre-124 migrations still prepare — it is dead ` +
        `storage. Ask isPrn(item) / read item.obligation instead:\n` +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("no application source reads or writes the retired intake priority column", () => {
    // Narrow on purpose: `priority` is a live, unrelated concept elsewhere (the
    // risk-stratified screening/retest ranking on UpcomingItem, metric source
    // priority). Only the INTAKE-shaped uses are retired, so the signature is the
    // column in intake SQL and the property on an intake row.
    // `item.priority` is deliberately NOT here: UpcomingItem carries a live,
    // unrelated risk RANK by that name (#517/#553). Only the stored intake column
    // and its retired enum values are the signature.
    const INTAKE_PRIORITY = [
      /INTO intake_items[^`]*\bpriority\b/,
      /UPDATE intake_items[^`]*\bpriority\b/,
      /\bpriority\s*=\s*'(?:mandatory|high|low)'/,
      /\bsupp\.priority\b/,
    ];
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      for (const re of INTAKE_PRIORITY) {
        if (re.test(text)) {
          offenders.push(rel);
          break;
        }
      }
    }
    expect(
      offenders,
      `#1505 renamed the intake priority column to obligation (must/should/may). ` +
        `The old column survives only for migration replay:\n` +
        offenders.join("\n")
    ).toEqual([]);
  });
});
