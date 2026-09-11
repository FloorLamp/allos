import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isArguedExclusion } from "@/lib/loggable-domains";
import { LEDGERS_WITH_LOGGED_VIA } from "@/lib/logged-via";
import {
  LOG_DAY_SOURCES,
  LOG_LEDGER_SEGMENT,
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
// tell whether a declared ledger is actually counted.
//
// #4249 MOVED THE SQL, NOT THE CENSUS. The statement now belongs to the
// surface-usage read model (lib/queries/surface-usage.ts) and `getSegmentLogDays`
// folds its result, so both modules are read here — every case below is the case it
// was, asked of wherever the literals currently live.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SOURCE = ["lib/queries/surface-usage.ts", "lib/queries/log-sheet.ts"]
  .map((rel) => fs.readFileSync(path.join(REPO, rel), "utf8"))
  .join("\n");

// The statements' own text: EVERY backtick-quoted literal passed to
// hoistedStatement, joined so the per-arm cases below read them as one census.
// Sliced rather than exported, so the modules keep handing literals straight to the
// compiler where the owned-table scans can read them.
//
// There are two literals from #3191 on. The `activities` arm is its own statement
// because whether an activity row is a create-at-start draft is settled by
// `isDraftActivityRow` (lib/activity-draft.ts) reading the WHOLE row, which a
// grouped aggregate cannot show it — and restating that rule in SQL would be a
// second definition of a draft, which the census the #3056 work rests on forbids. It
// kept the tagged-arm shape (`SELECT 'activities' AS ledger … FROM activities …
// profile_id = @profileId … @from`), so every case below applies to it unchanged.
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
// the per-arm pairing below reads one as a ledger: the JOIN'd parent a child table
// scopes through (`intake_items` carries the profile filter, not the days), and the
// correlated EXISTS the activities arm asks the draft rule's "has any set" half with
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
  it("answers for every quick-log entry, with a ledger or an argued exclusion", () => {
    for (const id of QUICK_LOG_IDS) {
      const declared = LOG_DAY_SOURCES[id];
      if (isArguedExclusion(declared)) {
        expect(declared.reason.length).toBeGreaterThan(40);
      } else {
        expect(declared.length).toBeGreaterThan(0);
      }
    }
  });

  // #4249's floor, and the reason the census's value type narrowed: the measure asks
  // `logged_via`, so a ledger outside the #3087 tranche could only ever count zero.
  // `tsc` refuses the declaration; this states the invariant in the tier that reads.
  it("declares only ledgers that carry logged_via", () => {
    for (const table of declaredTables()) {
      expect(LEDGERS_WITH_LOGGED_VIA as readonly string[]).toContain(table);
    }
  });

  it("counts every ledger it declares", () => {
    for (const table of declaredTables()) {
      expect(SQL, `declared ledger ${table} is not counted`).toMatch(
        new RegExp(`FROM\\s+${table}\\b`)
      );
    }
  });

  it("declares every ledger it counts", () => {
    const counted = new Set(
      [...SQL.matchAll(/FROM\s+([a-z_]+)/g)].map((m) => m[1])
    );
    for (const table of NO_DAYS_OF_ITS_OWN) counted.delete(table);
    const declared = new Set(declaredTables());
    for (const table of counted) {
      expect(declared, `${table} is counted but undeclared`).toContain(table);
    }
  });

  it("tags each arm with a ledger the tranche and the census both know", () => {
    const tagged = [...SQL.matchAll(/SELECT '([a-z_]+)' AS ledger/g)].map(
      (m) => m[1]
    );
    expect(tagged.length).toBeGreaterThan(0);
    for (const ledger of tagged) {
      expect(LEDGERS_WITH_LOGGED_VIA as readonly string[]).toContain(ledger);
      expect(declaredTables()).toContain(ledger);
    }
    // Care and Body are each fed by several ledgers; every segment that has a
    // counted entry must actually be counted, or its profiles could never lead.
    const reachable = new Set(
      tagged.map((l) => LOG_LEDGER_SEGMENT[l as never])
    );
    for (const id of QUICK_LOG_IDS) {
      if (isArguedExclusion(LOG_DAY_SOURCES[id])) continue;
      expect(reachable).toContain(LOG_SEGMENT_CENSUS[id]);
    }
  });

  it("counts each ledger toward the segment its declaring entry maps to", () => {
    // The cases above check the two records against each other one AXIS at a time:
    // every declared ledger is counted, every counted ledger is declared, every arm
    // tag is a real ledger. None of them ties a LEDGER to a SEGMENT, so tagging the
    // period arm 'care' once passed all three — `body` was still reachable and
    // `care` is still a legal segment — while a period start had silently become
    // Care evidence. The pairing is the fact the measure rests on, so it is checked
    // as a pairing, in both of its halves: the fold `getSegmentLogDays` applies must
    // agree with the census, and no ledger may be claimed by two segments.
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
    for (const [table, segments] of expected) {
      expect(
        [...segments],
        `${table} is declared under ${[...segments].join(" / ")}, so the fold ` +
          `cannot name one segment for it`
      ).toHaveLength(1);
      expect(LOG_LEDGER_SEGMENT[table as never]).toBe([...segments][0]);
    }
    // And the arm's OWN table is its tag — see NO_DAYS_OF_ITS_OWN for the two that
    // are named without being counted — so a mislabelled arm cannot slip a ledger's
    // days into another ledger's segment.
    const arms = SQL.split("UNION ALL").filter((a) => a.includes("FROM"));
    for (const arm of arms) {
      const tag = /SELECT '([a-z_]+)' AS ledger/.exec(arm)?.[1] ?? "";
      expect(armTable(arm), `arm tagged '${tag}' reads another table`).toBe(
        tag
      );
    }
  });

  it("scopes every counted arm to the profile", () => {
    // The owned-table scan already proves this for the statement as a whole; this
    // is the per-ARM version, which a single-literal UNION otherwise hides: one
    // arm missing its filter would count another profile's days.
    const arms = SQL.split("UNION ALL").filter((a) => a.includes("FROM"));
    expect(arms.length).toBe(
      [...SQL.matchAll(/SELECT '([a-z_]+)' AS ledger/g)].length
    );
    for (const arm of arms) {
      expect(arm).toMatch(/profile_id = @profileId/);
      expect(arm).toContain("@from");
    }
  });

  // #4249: the measure counts WEB acts, and an unattributable row is not one. Every
  // arm therefore refuses NULL — the shape of every row written before the #3087
  // tranche — rather than leaving the classification to the fold, where a missing
  // predicate would read as "unknown surface" silently becoming whatever the
  // channel record's default happened to be.
  it("asks every arm for a stamped surface", () => {
    const arms = SQL.split("UNION ALL").filter((a) => a.includes("FROM"));
    for (const arm of arms) {
      const tag = /SELECT '([a-z_]+)' AS ledger/.exec(arm)?.[1] ?? "";
      expect(arm, `arm '${tag}' counts unstamped rows`).toMatch(
        /logged_via IS NOT NULL/
      );
    }
  });
});
