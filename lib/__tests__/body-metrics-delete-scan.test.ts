import { describe, expect, it } from "vitest";
import { readSource, relPath, sourceFiles } from "./sql-scan";

// NOTHING DELETES `body_metrics` BECAUSE A PROFILE MOVED (#3524).
//
// The blind timezone sweep is gone: it deleted every non-edit-locked Health Connect
// `body_metrics` row from `today − 3` forward on every zone change, on the argument that
// the next push would put them back, and the exporter re-sends ONE day. Four days of a
// production profile's resting HR went with two travel switches. The re-key that sweep
// existed to prevent (#608) is handled at ingest now, against the reading instant a push
// actually re-sends (lib/integrations/ingest-timezone-reconcile.ts).
//
// A guard is what stops that coming back, and this is the second attempt at one. The
// first (PR #3539) FAILED OPEN in three ways an adversarial lens found, and every choice
// below is a repair of one of them:
//
//   • IT SKIPPED `lib/migrations/`. Its walker did `if (e.name === "node_modules" ||
//     e.name === "migrations") continue`, so every file under lib/migrations/ was
//     invisible — including `cascade-delete.ts`, which deletes from any table in the
//     schema. This file uses the SHARED walker (./sql-scan.ts) and asserts below that
//     cascade-delete is in the set it scanned.
//
//   • IT MATCHED LITERALS ONLY — `/DELETE\s+FROM\s+body_metrics/i` — while this tree's
//     prevailing idiom is `DELETE FROM ${table}`. Fifteen delete sites can reach
//     `body_metrics` and only THREE spell its name. A literal-only guard turns "nobody
//     has done this" into "nobody can do this", and only the first was ever true.
//
//   • ITS SYNTHETIC OFFENDERS WERE FED TO THE REGEX AS STRINGS, so the corpus walk was
//     never exercised by them at all. Every fixture below goes through `scanFile`, the
//     same function the real tree goes through.
//
// WHAT IT ASSERTS, and it is deliberately not "no module deletes body_metrics" — several
// legitimately do, at a person's explicit request. It is that EVERY delete which can
// reach the table is ENUMERATED with a stated trigger, and that no entry's trigger is a
// timezone change. Adding one is then a reviewed decision rather than a silent one.
//
// SCOPE, stated rather than implied. This is a TEXT scan. It reads the repo's own source
// with no DB and no network, it cannot resolve an interpolated table name, and it does
// not follow a table name through a registry — which is exactly why an interpolated
// delete is a FINDING here rather than a pass: the allowlist entry is where somebody
// states whether `body_metrics` is reachable through it, and review can check the claim.
// `lib/__db_tests__/` and `lib/__action_tests__/` are out of scope for the same reason
// lib/__tests__/stateful-writes.test.ts leaves them out: a fixture that seeds or clears a
// table is not a write path a user's tap can reach.

const OUT_OF_SCOPE = ["lib/__db_tests__/", "lib/__action_tests__/"];

interface Finding {
  file: string;
  sql: string;
}

// Comments blanked, so a sentence ABOUT a delete is not a delete. `lib/stateful-writes.ts`
// and `lib/cycle-store.ts` both discuss `DELETE FROM ${root.table}` in prose, correctly,
// and a guard that flagged them would be deleted within a week — taking the real guard
// with it.
export function blankComments(src: string): string {
  let out = "";
  let i = 0;
  let mode: "code" | "line" | "block" | "str" = "code";
  let quote = "";
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === "code") {
      if (c === "/" && d === "/") {
        mode = "line";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "/" && d === "*") {
        mode = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        mode = "str";
        quote = c;
      }
      out += c;
      i++;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") {
        mode = "code";
        out += c;
      } else out += " ";
      i++;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && d === "/") {
        mode = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += c === "\n" ? c : " ";
      i++;
      continue;
    }
    // Inside a string/template.
    if (c === "\\") {
      out += c + (src[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (c === quote) mode = "code";
    out += c;
    i++;
  }
  return out;
}

// A delete that names `body_metrics`, or one whose table is interpolated and therefore
// unreadable from source. Case-insensitive on purpose — the tree writes SQL in capitals,
// but a guard that can only see the house style cannot see the mistake.
const DELETE_RE = /\bDELETE\s+FROM\s+(?:body_metrics\b|\$\{)/gi;

// The match must START a SQL string, not merely appear inside one. Without this, two
// ERROR MESSAGES in lib/migrations/cascade-delete.ts ("recursive delete from ${table}
// exceeded depth …") read as deletes, and a guard that cries wolf on prose gets deleted.
const STATEMENT_START = "`\"';(";

// SCANS RAW SOURCE TEXT rather than only `.prepare(`/`.exec(` arguments, and that is a
// deliberate step OUTSIDE the shared extractor. `lib/__tests__/sql-scan.ts` reads the
// FIRST ARGUMENT of a prepare/exec call, which is the right shape for the profile-scoping
// and gated-write guards — but two delete sites in this tree build their SQL into an
// OBJECT PROPERTY first (`lib/profile-delete.ts`'s `{ sql: ... }` plan and
// `lib/day-counter-ledger.ts`'s `drop:`) and are invisible to it. The file ENUMERATION,
// the `__tests__` exclusion and the posix-relative paths still come from the shared
// module; only the "what counts as a delete" predicate is local, because the question is
// local. Two guards, one walker.
export function scanFile(rel: string, src: string): Finding[] {
  if (OUT_OF_SCOPE.some((p) => rel.startsWith(p))) return [];
  const text = blankComments(src);
  const out: Finding[] = [];
  for (const m of text.matchAll(DELETE_RE)) {
    let j = (m.index ?? 0) - 1;
    while (j >= 0 && /\s/.test(text[j])) j--;
    if (j >= 0 && !STATEMENT_START.includes(text[j])) continue;
    out.push({
      file: rel,
      sql: text
        .slice(m.index, (m.index ?? 0) + 100)
        .replace(/\s+/g, " ")
        .trim(),
    });
  }
  return out;
}

// EVERY delete that can reach `body_metrics`, and what triggers it. `reaches` is the
// reviewed answer to "can this statement's table be body_metrics?" — `false` means the
// interpolated table is drawn from a registry that does not contain it, and the entry
// names the registry so the claim is checkable.
const ALLOW: {
  file: string;
  includes: string;
  reaches: boolean;
  trigger: string;
}[] = [
  {
    file: "lib/integrations/ingest-timezone-reconcile.ts",
    includes: "DELETE FROM body_metrics",
    reaches: true,
    trigger:
      "A HEALTH CONNECT PUSH, never a zone change. The only delete in this tree that a timezone has anything to do with, and the direction is the point: it fires when a push re-sends a reading whose stored day was computed under a zone the profile has since left, and it removes the row THAT INSTANT is already sitting on. A switch with no re-push deletes nothing; a day the exporter does not re-send is never named. #3524.",
  },
  {
    file: "app/(app)/data/review-actions.ts",
    includes: "DELETE FROM body_metrics WHERE id = ?",
    reaches: true,
    trigger:
      "A PERSON, on one row they are looking at, in the Review resolver — the discard half of the import-review affordance.",
  },
  {
    file: "app/(app)/data/manage-actions.ts",
    includes: "DELETE FROM ${resolved.table}",
    reaches: true,
    trigger:
      "A PERSON, in Data → Manage, on rows or a whole dataset they selected. The table comes from the dataset registry (lib/export.ts), where `body_metrics` is a registered dataset.",
  },
  {
    file: "lib/import-persist.ts",
    includes: "DELETE FROM ${t.table}",
    reaches: true,
    trigger:
      "A PERSON undoing an IMPORT. The table comes from IMPORT_FOOTPRINT_TABLES (lib/import-footprint.ts), which registers `body_metrics`; the delete is scoped to that import's footprint.",
  },
  {
    file: "lib/undo-delete-db.ts",
    includes: "DELETE FROM ${root.table}",
    reaches: true,
    trigger:
      "A PERSON, undoing their own delete. The table comes from the undo registry (lib/undo-delete.ts), where `body_metrics` is a registered owned table.",
  },
  {
    file: "lib/undo-delete-db.ts",
    includes: "DELETE FROM ${child.table}",
    reaches: true,
    trigger:
      "The same registry and the same person's undo, restoring the child rows that hang off the root row above it.",
  },
  {
    file: "lib/profile-delete.ts",
    includes: "DELETE FROM ${child.table}",
    reaches: true,
    trigger:
      "A PERSON deleting a whole PROFILE. Every profile-owned table is erased, `body_metrics` among them.",
  },
  {
    file: "lib/profile-delete.ts",
    includes: "DELETE FROM ${t}",
    reaches: true,
    trigger:
      "The same person deleting the same profile, sweeping the tables that carry a profile_id of their own rather than reaching it through a parent.",
  },
  {
    file: "lib/migrations/cascade-delete.ts",
    includes: "DELETE FROM ${q(table)} AS t0",
    reaches: true,
    trigger:
      "The generic FK cascade a caller above it asked for — it deletes whatever table it is handed, and its callers are the erasure and undo paths already listed.",
  },
  {
    file: "lib/migrations/cascade-delete.ts",
    includes: "DELETE FROM ${q(link.table)}",
    reaches: true,
    trigger:
      "The same cascade the erasure and undo paths invoke, deleting the link rows that join the row being removed to its children.",
  },
  {
    file: "lib/migrations/cascade-delete.ts",
    includes: "DELETE FROM ${q(table)} WHERE ${notNull}",
    reaches: true,
    trigger:
      "The same cascade again, its trailing pass over rows whose only parent has just been removed and which nothing can reach any more.",
  },
  {
    file: "lib/migrations/versions/002-edit-lock-flags.ts",
    includes: "DELETE FROM body_metrics",
    reaches: true,
    trigger:
      "A SHIPPED MIGRATION, once: the dedupe that let (profile_id, date, source) become a UNIQUE index. Frozen by the hash manifest and cannot run again.",
  },
  {
    file: "lib/day-counter-ledger.ts",
    includes: "DELETE FROM ${spec.table}",
    reaches: false,
    trigger:
      "A day counter falling to zero. The table comes from DAY_COUNTER_SPECS, whose three entries are food_daily_totals, substance_daily_totals and protein_daily_totals — no reading store is reachable.",
  },
  {
    file: "lib/assessment-reclass-db.ts",
    includes: "DELETE FROM ${definitionTable}",
    reaches: false,
    trigger:
      "An AI-authored definition being reclassified away. `definitionTable` is a clinical DEFINITION table, never a reading store.",
  },
];

const allowed = (f: Finding) =>
  ALLOW.some((a) => f.file === a.file && f.sql.startsWith(a.includes));

describe("no production module deletes body_metrics on a timezone change (#3524)", () => {
  const files = sourceFiles();

  it("scans the files a previous guard silently skipped", () => {
    const scanned = files.map(relPath);
    expect(scanned.length).toBeGreaterThan(500);
    // The three PR #3539's walker could not see, named individually so a walk that
    // regresses fails HERE rather than by quietly finding nothing.
    for (const f of [
      "lib/migrations/cascade-delete.ts",
      "lib/migrations/versions/002-edit-lock-flags.ts",
      "lib/integrations/ingest-timezone-reconcile.ts",
    ]) {
      expect(scanned, f).toContain(f);
    }
  });

  it("enumerates every delete that can reach body_metrics", () => {
    const findings = files.flatMap((f) => scanFile(relPath(f), readSource(f)));
    const unlisted = findings.filter((f) => !allowed(f));
    expect(
      unlisted,
      `\nUNLISTED DELETE(S) THAT MAY REACH body_metrics:\n${unlisted
        .map((f) => `  ${f.file}: ${f.sql}`)
        .join("\n")}\n` +
        "Add an entry to ALLOW naming what TRIGGERS it. If the trigger is a timezone " +
        "change, that is #3524 coming back and the entry is not the fix.\n"
    ).toEqual([]);
    // The enumeration is not empty for the wrong reason.
    expect(findings.length).toBeGreaterThanOrEqual(ALLOW.length);
  });

  it("has no allowlist entry whose trigger is a timezone change", () => {
    const zoneish =
      /timezone|time zone|zone change|switch(ed)? (zone|timezone)/i;
    for (const a of ALLOW) {
      // The reconcile IS about a timezone, and says so — it is excluded by NAME rather
      // than by wording, so no future entry can smuggle a sweep back in by paraphrase.
      if (a.file === "lib/integrations/ingest-timezone-reconcile.ts") continue;
      expect(a.trigger, a.file).not.toMatch(zoneish);
    }
  });

  it("has a stated trigger on every entry", () => {
    for (const a of ALLOW) expect(a.trigger.length, a.file).toBeGreaterThan(60);
  });

  // THE SWEEP ITSELF IS GONE, by name — as CODE. A revert cannot land quietly beside a
  // guard that only counts statements.
  //
  // Comments are blanked first, and that is not a loosening. Three files name the removed
  // symbol ON PURPOSE and must keep doing so: the two modules that replace it explain
  // what they replace, and shipped migration 164 records that the sweep existed to paper
  // over the `hr_minutes` half of the same defect. A guard that made those illegal would
  // force the tree to forget why the sweep went, which is the one thing worth keeping
  // about it.
  it("no source file CALLS or IMPORTS the deleted sweep", () => {
    const hits = files
      .map((f) => ({ rel: relPath(f), src: blankComments(readSource(f)) }))
      .filter(
        (f) =>
          f.src.includes("sweepIngestWindowForTimezoneChange") ||
          f.src.includes("integrations/ingest-timezone-sweep")
      )
      .map((f) => f.rel);
    expect(hits).toEqual([]);
  });

  it("still SEES the sweep when it is code rather than prose", () => {
    // The guard above passes on a clean tree; this is what proves it is not passing
    // because comment blanking ate the evidence.
    const planted = blankComments(`
      // sweepIngestWindowForTimezoneChange used to run here
      import { sweepIngestWindowForTimezoneChange } from "@/lib/integrations/ingest-timezone-sweep";
    `);
    expect(planted).toContain("sweepIngestWindowForTimezoneChange");
    expect(planted).toContain("integrations/ingest-timezone-sweep");
    // …and only once: the commented mention is gone.
    expect(planted.match(/sweepIngestWindowForTimezoneChange/g)).toHaveLength(
      1
    );
  });
});

// THE FIXTURES THAT PROVE THE GUARD CAN SEE. Each goes through `scanFile` — the whole
// pipeline, comment blanking included — rather than being handed to the regex.
describe("the scan can see, and knows when to stay quiet", () => {
  it("FLAGS a sweep re-added under a literal table name", () => {
    const planted = `
      import { db } from "@/lib/db";
      export function sweepAgain(profileId: number, cutoff: string) {
        db.prepare(
          \`DELETE FROM body_metrics WHERE profile_id = ? AND date >= ?\`
        ).run(profileId, cutoff);
      }
    `;
    expect(scanFile("lib/integrations/rogue-sweep.ts", planted)).toHaveLength(
      1
    );
  });

  it("FLAGS one written the way this tree actually writes deletes", () => {
    const planted = `
      const table = "body_metrics";
      db.prepare(\`DELETE FROM \${table} WHERE profile_id = ?\`).run(profileId);
    `;
    expect(scanFile("lib/rogue-registry-sweep.ts", planted)).toHaveLength(1);
  });

  it("FLAGS one built into an object property, which a prepare-arg scan misses", () => {
    // The shape lib/profile-delete.ts and lib/day-counter-ledger.ts really use.
    const planted = `
      const plan = { sql: \`DELETE FROM \${child.table} WHERE profile_id = ?\`, binds: [p] };
    `;
    expect(scanFile("lib/rogue-plan.ts", planted)).toHaveLength(1);
  });

  it("FLAGS a db.exec form and a lowercase one", () => {
    expect(
      scanFile("lib/rogue-exec.ts", `db.exec("DELETE FROM body_metrics");`)
    ).toHaveLength(1);
    expect(
      scanFile(
        "lib/rogue-lower.ts",
        `db.prepare("delete from body_metrics WHERE profile_id = ?").run(p);`
      )
    ).toHaveLength(1);
  });

  it("FLAGS the same statement inside a file that IS allowlisted, when the SQL differs", () => {
    // The allowlist is keyed on the statement, not only the file, so an allowlisted
    // module cannot become a free pass for a second, different delete.
    const planted = `db.prepare(\`DELETE FROM body_metrics WHERE profile_id = ? AND date >= ?\`).run(p, c);`;
    const found = scanFile("lib/import-persist.ts", planted);
    expect(found).toHaveLength(1);
    expect(allowed(found[0])).toBe(false);
  });

  it("stays QUIET on prose about a delete, on a read, and on another table", () => {
    expect(
      scanFile(
        "lib/notes.ts",
        `// the generic machinery builds DELETE FROM \${root.table} and this scan cannot read it
         /* DELETE FROM body_metrics would be wrong here */`
      )
    ).toEqual([]);
    expect(
      scanFile(
        "lib/reads.ts",
        `db.prepare("SELECT date FROM body_metrics WHERE profile_id = ?").all(p);
         db.prepare("UPDATE body_metrics SET edited = 1 WHERE id = ?").run(id);`
      )
    ).toEqual([]);
    expect(
      scanFile(
        "lib/other-table.ts",
        `db.prepare("DELETE FROM metric_samples WHERE profile_id = ?").run(p);`
      )
    ).toEqual([]);
  });

  it("stays QUIET on an error message that happens to say 'delete from'", () => {
    // Verbatim shape from lib/migrations/cascade-delete.ts, which is REAL code this scan
    // walks — five words of prose either side of a template hole.
    const planted =
      "throw new Error(`recursive delete from ${table} exceeded depth ${MAX_DEPTH}`);";
    expect(scanFile("lib/migrations/cascade-delete.ts", planted)).toEqual([]);
  });

  it("stays QUIET on the test tiers, which seed and clear tables by design", () => {
    const planted = `db.prepare("DELETE FROM body_metrics").run();`;
    expect(scanFile("lib/__db_tests__/scope.test.ts", planted)).toEqual([]);
    expect(scanFile("lib/queries/anything.ts", planted)).toHaveLength(1);
  });
});
