import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Source-scan guard for the #2232 day-window conversion. It exists because the
// conversion could not be complete at the storage layer:
//
// The rebuilt `illness_episodes` still carries inert `started_at` and `ended_at`
// columns (always NULL). Not as a hedge — `migrate()` applies every migration
// unconditionally and the DB-test harness replays it against an already-migrated
// database, while migrations 046 and 062 (shipped, immutable) hold prepared
// statements that NAME those columns. SQLite validates a statement at PREPARE time,
// before any row is examined, so dropping them makes those migrations throw on every
// replay. (The exact obligation-collapse-guard situation, one table over — see
// migration 124.)
//
// Two dead columns sitting in the schema are precisely how a settled convention
// un-settles: the next person finds `ended_at` in `PRAGMA table_info`, writes the
// EXCLUSIVE first-well day into it, and the off-by-one this issue closed is back with
// no reader able to tell. This test makes that a build failure. Application code
// reads `start_date`/`end_date` (both bounds INCLUSIVE); nothing else may name the
// retired pair on this table.
//
// `started_at`/`ended_at` are live, correct column names elsewhere (the
// integration_backfill_jobs lease), so the signature is scoped: a retired name
// counts only when the same statement/template names illness_episodes.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components", "lib", "scripts", "e2e"];

// Where the retired pair may legitimately appear next to illness_episodes:
//   • the versioned migrations — 046 created them, 062 reads them, 168 is the
//     conversion itself. All frozen or self-describing.
//   • the DB specs that rebuild a HISTORICAL illness_episodes schema from the frozen
//     migrations and must therefore speak that schema's vocabulary.
//   • this guard.
function isExempt(rel: string): boolean {
  return (
    rel.startsWith("lib/migrations/") ||
    // The declared index itself: the vestigial pair is DECLARED there (with the
    // VESTIGIAL note) so the schema census stays complete.
    rel === "lib/time-columns.ts" ||
    rel === "lib/__db_tests__/illness-day-window-migration.test.ts" ||
    rel === "lib/__db_tests__/illness-episode-model.test.ts" ||
    rel === "lib/__db_tests__/illness-episode-visit-lifecycle.test.ts" ||
    rel.endsWith("lib/__tests__/illness-window-collapse-guard.test.ts")
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

describe("the illness day-window conversion stays converted (#2232)", () => {
  it("no application source names started_at/ended_at on illness_episodes", () => {
    const offenders: string[] = [];
    for (const d of SCAN_DIRS) {
      const abs = path.join(REPO, d);
      if (!fs.existsSync(abs)) continue;
      for (const full of walk(abs)) {
        const rel = path.relative(REPO, full).split(path.sep).join("/");
        if (isExempt(rel)) continue;
        const text = fs.readFileSync(full, "utf8");
        // A statement that names the table and, within the same template literal /
        // statement stretch, one of the retired columns. 400 chars comfortably spans
        // the longest INSERT/SELECT over this seven-column table.
        if (
          /\billness_episodes\b[\s\S]{0,400}?\b(?:started_at|ended_at)\b/.test(
            text
          ) ||
          /\b(?:started_at|ended_at)\b[\s\S]{0,400}?\billness_episodes\b/.test(
            text
          )
        ) {
          offenders.push(rel);
        }
      }
    }
    expect(
      offenders,
      `#2232 renamed illness_episodes.started_at/ended_at to start_date/end_date ` +
        `(end INCLUSIVE). The old columns survive in the schema ONLY so replayed ` +
        `pre-168 migrations still prepare — they are dead storage. Read/write ` +
        `start_date/end_date instead:\n` +
        offenders.join("\n")
    ).toEqual([]);
  });
});
