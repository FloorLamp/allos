import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isArguedExclusion } from "@/lib/loggable-domains";
import {
  LOG_DAY_SOURCES,
  LOG_SEGMENT_CENSUS,
  type LogSegmentId,
} from "@/lib/log-sheet";
import { QUICK_LOG_IDS } from "@/lib/quick-log";

// The #2709 measure counts days out of ONE hand-written UNION statement, while its
// coverage is DECLARED as a census keyed on QuickLogId. Two records of the same
// fact drift, so this reads the module's own source and holds them together.
//
// It is a text scan for the same reason the owned-table scans are: the SQL is a
// literal (deliberately — see the module header), and nothing but reading it can
// tell whether a declared store is actually counted.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SOURCE = fs.readFileSync(
  path.join(REPO, "lib/queries/log-sheet.ts"),
  "utf8"
);

// The statement's own text: the one backtick-quoted literal the module passes to
// hoistedStatement. Sliced rather than exported, so the module keeps handing a
// literal straight to the compiler where the owned-table scans can read it.
const SQL_START = SOURCE.indexOf("`", SOURCE.indexOf("hoistedStatement(")) + 1;
const SQL = SOURCE.slice(SQL_START, SOURCE.indexOf("`", SQL_START));

function declaredTables(): string[] {
  return Object.values(LOG_DAY_SOURCES).flatMap((v) =>
    isArguedExclusion(v) ? [] : [...v]
  );
}

describe("LOG_DAY_SOURCES", () => {
  it("answers for every quick-log entry, with a store or an argued exclusion", () => {
    for (const id of QUICK_LOG_IDS) {
      const declared = LOG_DAY_SOURCES[id];
      if (isArguedExclusion(declared)) {
        expect(declared.reason.length).toBeGreaterThan(40);
      } else {
        expect(declared.length).toBeGreaterThan(0);
      }
    }
  });

  it("counts every store it declares", () => {
    for (const table of declaredTables()) {
      expect(SQL, `declared store ${table} is not counted`).toMatch(
        new RegExp(`FROM\\s+${table}\\b`)
      );
    }
  });

  it("declares every store it counts", () => {
    // Every `FROM <table>` in the statement, minus the JOIN'd parent a child table
    // scopes through (intake_items carries the profile filter, not the days).
    const counted = new Set(
      [...SQL.matchAll(/FROM\s+([a-z_]+)/g)].map((m) => m[1])
    );
    counted.delete("intake_items");
    const declared = new Set(declaredTables());
    for (const table of counted) {
      expect(declared, `${table} is counted but undeclared`).toContain(table);
    }
  });

  it("tags each arm with a real segment, and only segments the census uses", () => {
    const tagged = new Set<string>(
      [...SQL.matchAll(/SELECT '([a-z]+)' AS segment/g)].map((m) => m[1])
    );
    const known = new Set<LogSegmentId>(Object.values(LOG_SEGMENT_CENSUS));
    for (const segment of tagged) {
      expect(known).toContain(segment as LogSegmentId);
    }
    // Care and Body are each fed by several stores; every segment that has a
    // counted entry must actually be counted, or its profiles could never lead.
    for (const id of QUICK_LOG_IDS) {
      if (isArguedExclusion(LOG_DAY_SOURCES[id])) continue;
      expect(tagged).toContain(LOG_SEGMENT_CENSUS[id]);
    }
  });

  it("scopes every counted arm to the profile", () => {
    // The owned-table scan already proves this for the statement as a whole; this
    // is the per-ARM version, which a single-literal UNION otherwise hides: one
    // arm missing its filter would count another profile's days.
    const arms = SQL.split("UNION ALL").filter((a) => a.includes("FROM"));
    expect(arms.length).toBe(
      [...SQL.matchAll(/SELECT '([a-z]+)' AS segment/g)].length
    );
    for (const arm of arms) {
      expect(arm).toMatch(/profile_id = @profileId/);
      expect(arm).toContain("@from");
    }
  });
});
