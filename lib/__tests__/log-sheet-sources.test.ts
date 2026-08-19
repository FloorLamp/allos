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

// The statements' own text: EVERY backtick-quoted literal the module passes to
// hoistedStatement, joined so the per-arm cases below read them as one census.
// Sliced rather than exported, so the module keeps handing literals straight to the
// compiler where the owned-table scans can read them.
//
// There are two literals from #3191 on. The `activities` arm left the union because
// whether an activity row is a create-at-start draft is settled by
// `isDraftActivityRow` reading the WHOLE row (lib/activity-draft.ts), which a
// `COUNT(DISTINCT d)` aggregate cannot show it — and restating that rule in SQL
// would be a second definition of a draft, which the census the #3056 work rests on
// forbids. It kept the tagged-arm shape (`SELECT 'train' AS segment … FROM
// activities … profile_id = @profileId … @from`), so every case below applies to it
// unchanged; only the collection widened.
function statementLiterals(): string[] {
  const out: string[] = [];
  let at = SOURCE.indexOf("hoistedStatement(");
  while (at !== -1) {
    const start = SOURCE.indexOf("`", at) + 1;
    out.push(SOURCE.slice(start, SOURCE.indexOf("`", start)));
    at = SOURCE.indexOf("hoistedStatement(", start);
  }
  return out;
}
const LITERALS = statementLiterals();
const SQL = LITERALS.join("\nUNION ALL\n");

// Tables an arm names WITHOUT producing a day from them, so neither the census nor
// the per-arm pairing below reads one as a store: the JOIN'd parent a child table
// scopes through (`intake_items` carries the profile filter, not the days), and the
// correlated EXISTS the Train arm asks the draft rule's "has any set" half with
// (`exercise_sets` decides whether an activity row is an entry, and contributes no
// date). The EXISTS sits in the select list, so it is also the FIRST `FROM` in its
// arm — `armTable` therefore skips these rather than taking the literal first match.
const NO_DAYS_OF_ITS_OWN = ["intake_items", "exercise_sets"];

function armTable(arm: string): string {
  for (const m of arm.matchAll(/FROM\s+([a-z_]+)/g)) {
    if (!NO_DAYS_OF_ITS_OWN.includes(m[1])) return m[1];
  }
  return "";
}

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
    const counted = new Set(
      [...SQL.matchAll(/FROM\s+([a-z_]+)/g)].map((m) => m[1])
    );
    for (const table of NO_DAYS_OF_ITS_OWN) counted.delete(table);
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

  it("counts each store toward the segment its declaring entry maps to", () => {
    // The cases above check the two records against each other one AXIS at a time:
    // every declared store is counted, every counted store is declared, every used
    // segment tag is a real one. None of them ties a STORE to a SEGMENT, so tagging
    // the `cycles` arm 'care' passed all three — `body` was still tagged (by
    // `body_metrics`) and `care` is still a legal segment — while a period start had
    // silently become Care evidence. The pairing is the fact the measure rests on,
    // so it is checked as a pairing.
    const expected = new Map<string, Set<LogSegmentId>>();
    for (const id of QUICK_LOG_IDS) {
      const declared = LOG_DAY_SOURCES[id];
      if (isArguedExclusion(declared)) continue;
      for (const table of declared) {
        const set = expected.get(table) ?? new Set<LogSegmentId>();
        set.add(LOG_SEGMENT_CENSUS[id]);
        expected.set(table, set);
      }
    }
    const arms = SQL.split("UNION ALL").filter((a) => a.includes("FROM"));
    for (const arm of arms) {
      const segment = /SELECT '([a-z]+)' AS segment/.exec(arm)?.[1] ?? "";
      // The arm's OWN table is its first day-producing FROM — see
      // NO_DAYS_OF_ITS_OWN for the two that are named without being counted.
      const table = armTable(arm);
      const declaredFor = [...(expected.get(table) ?? [])];
      expect(
        declaredFor,
        `${table || "(no table)"} is counted toward '${segment}', but the census ` +
          `declares it under ${declaredFor.length ? declaredFor.map((s) => `'${s}'`).join(" / ") : "no segment at all"}`
      ).toContain(segment as LogSegmentId);
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
