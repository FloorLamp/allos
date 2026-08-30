import { describe, expect, it } from "vitest";
import { readSource, relPath, sourceFiles } from "./sql-scan";
import { stripComments } from "./strip-comments";

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
  // The WHOLE statement, whitespace-normalized — not a fixed-length prefix of it. The
  // allowlist matches on this EXACTLY (see `allowed`), so the text below is what a
  // reviewer signed off on rather than its first hundred characters.
  sql: string;
}

// A statement runs to the end of the string literal it is written in, or to the first
// `;` inside it, whichever comes first. Capped so a pathological file cannot put an
// unbounded string in an assertion message.
const MAX_SQL = 300;

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
  if (!/\bDELETE\s+FROM\s+(?:body_metrics\b|\$\{)/i.test(src)) return [];
  const text = stripComments(src);
  const out: Finding[] = [];
  for (const m of text.matchAll(DELETE_RE)) {
    let j = (m.index ?? 0) - 1;
    while (j >= 0 && /\s/.test(text[j])) j--;
    if (j >= 0 && !STATEMENT_START.includes(text[j])) continue;
    const opener = j >= 0 ? text[j] : "";
    const rest = text.slice(m.index);
    let end = Math.min(rest.length, MAX_SQL);
    // The closing quote of the literal the SQL is written in…
    const close = "`\"'".includes(opener) ? rest.indexOf(opener) : -1;
    if (close >= 0 && close < end) end = close;
    // …or the end of this statement inside it, for a multi-statement `exec`.
    const semi = rest.indexOf(";");
    if (semi >= 0 && semi < end) end = semi;
    out.push({
      file: rel,
      sql: rest.slice(0, end).replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

// EVERY delete that can reach `body_metrics`, and what triggers it. `reaches` is the
// reviewed answer to "can this statement's table be body_metrics?" — `false` means the
// interpolated table is drawn from a registry that does not contain it, and the entry
// names the registry so the claim is checkable.
//
// `sql` IS THE WHOLE STATEMENT AND IT IS MATCHED EXACTLY. It was a PREFIX until the
// owner ruled otherwise (#3524, 2026-08-23), and the prefix made this guard blind at
// precisely the point of it: the entry for the reconcile read `"DELETE FROM
// body_metrics"`, so the removed blind sweep, replanted IN THAT MODULE, was found by the
// scan and then silently allowed. The prefix was also quietly covering a delete nobody
// had listed — `manage-actions.ts` has TWO, and one entry matched both. Exact matching
// means a statement that changes at all comes back for review, which is the cost and
// also the whole mechanism.
const ALLOW: {
  file: string;
  sql: string;
  reaches: boolean;
  trigger: string;
}[] = [
  {
    file: "lib/integrations/ingest-timezone-reconcile.ts",
    sql: "DELETE FROM body_metrics WHERE profile_id = ? AND date = ? AND source IS ?",
    reaches: true,
    trigger:
      "A HEALTH CONNECT PUSH, never a zone change, and only after the measure it is withdrawing has landed on its new day. It removes a row this push emptied: the re-keyed measure has already been nulled on it and no other measure was left. A switch with no re-push changes nothing; a day the exporter does not re-send is never named. #3524.",
  },
  {
    file: "app/(app)/data/review-actions.ts",
    sql: "DELETE FROM body_metrics WHERE id = ? AND profile_id = ?",
    reaches: true,
    trigger:
      "A PERSON, on one row they are looking at, in the Review resolver — the discard half of the import-review affordance.",
  },
  {
    file: "app/(app)/data/manage-actions.ts",
    sql: "DELETE FROM ${resolved.table} WHERE id IN (${placeholders}) AND profile_id = ?",
    reaches: true,
    trigger:
      "A PERSON, in Data → Manage, on rows they selected. The table comes from the dataset registry (lib/export.ts), where `body_metrics` is a registered dataset.",
  },
  {
    file: "app/(app)/data/manage-actions.ts",
    sql: "DELETE FROM ${resolved.table} WHERE profile_id = ?",
    reaches: true,
    trigger:
      "The same person in the same place, clearing a WHOLE dataset rather than a selection. Same registry. Listed separately because the allowlist matches statements exactly, and this one was riding on its neighbour's prefix.",
  },
  {
    file: "lib/import-persist.ts",
    sql: "DELETE FROM ${t.table} WHERE ${t.key} = ? AND ${footprintScope(t)}",
    reaches: true,
    trigger:
      "A PERSON undoing an IMPORT. The table comes from IMPORT_FOOTPRINT_TABLES (lib/import-footprint.ts), which registers `body_metrics`; the delete is scoped to that import's footprint.",
  },
  {
    file: "lib/undo-delete-db.ts",
    sql: "DELETE FROM ${root.table} WHERE id = ? AND profile_id = ?",
    reaches: true,
    trigger:
      "A PERSON, undoing their own delete. The table comes from the undo registry (lib/undo-delete.ts), where `body_metrics` is a registered owned table.",
  },
  {
    file: "lib/undo-delete-db.ts",
    sql: "DELETE FROM ${child.table} WHERE id = ? AND profile_id = ?",
    reaches: true,
    trigger:
      "The same registry and the same person's undo, restoring the child rows that hang off the root row above it.",
  },
  {
    file: "lib/profile-delete.ts",
    sql: "DELETE FROM ${child.table} WHERE ${cond.sql}",
    reaches: true,
    trigger:
      "A PERSON deleting a whole PROFILE. Every profile-owned table is erased, `body_metrics` among them.",
  },
  {
    file: "lib/profile-delete.ts",
    sql: "DELETE FROM ${t} WHERE profile_id = ?",
    reaches: true,
    trigger:
      "The same person deleting the same profile, sweeping the tables that carry a profile_id of their own rather than reaching it through a parent.",
  },
  {
    file: "lib/migrations/cascade-delete.ts",
    sql: "DELETE FROM ${q(table)} AS t0 WHERE ${root.sql}",
    reaches: true,
    trigger:
      "The generic FK cascade a caller above it asked for — it deletes whatever table it is handed, and its callers are the erasure and undo paths already listed.",
  },
  {
    file: "lib/migrations/cascade-delete.ts",
    sql: "DELETE FROM ${q(link.table)} AS ${alias} WHERE ${childPredicate.sql}",
    reaches: true,
    trigger:
      "The same cascade the erasure and undo paths invoke, deleting the link rows that join the row being removed to its children.",
  },
  {
    file: "lib/migrations/cascade-delete.ts",
    sql: "DELETE FROM ${q(table)} WHERE ${notNull} AND NOT EXISTS",
    reaches: true,
    trigger:
      "The same cascade again, its trailing pass over rows whose only parent has just been removed and which nothing can reach any more.",
  },
  {
    file: "lib/migrations/versions/002-edit-lock-flags.ts",
    sql: "DELETE FROM body_metrics WHERE source IS NOT NULL AND id NOT IN ( SELECT MIN(id) FROM body_metrics WHERE source IS NOT NULL GROUP BY profile_id, date, source )",
    reaches: true,
    trigger:
      "A SHIPPED MIGRATION, once: the dedupe that let (profile_id, date, source) become a UNIQUE index. Frozen by the hash manifest and cannot run again.",
  },
  {
    file: "lib/day-counter-ledger.ts",
    sql: "DELETE FROM ${spec.table} WHERE ${where} AND ${spec.amountColumn} <= 0",
    reaches: false,
    trigger:
      "A day counter falling to zero. The table comes from DAY_COUNTER_SPECS, whose three entries are food_daily_totals, substance_daily_totals and protein_daily_totals — no reading store is reachable.",
  },
  {
    file: "lib/assessment-reclass-db.ts",
    sql: "DELETE FROM ${definitionTable} WHERE name = ? COLLATE NOCASE AND source = 'ai'",
    reaches: false,
    trigger:
      "An AI-authored definition being reclassified away. `definitionTable` is a clinical DEFINITION table, never a reading store.",
  },
];

// EXACT, never a prefix — see the note above the list.
const allowed = (f: Finding) =>
  ALLOW.some((a) => f.file === a.file && f.sql === a.sql);

describe("no production module deletes body_metrics on a timezone change (#3524)", () => {
  const sources = sourceFiles().map((file) => ({
    rel: relPath(file),
    raw: readSource(file),
  }));

  it("scans the files a previous guard silently skipped", () => {
    const scanned = sources.map(({ rel }) => rel);
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
    const findings = sources.flatMap(({ rel, raw }) => scanFile(rel, raw));
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

  // THE SWEEP ITSELF IS GONE, by name — as CODE. A revert cannot land quietly beside a
  // guard that only counts statements.
  //
  // Comments are blanked first, and that is not a loosening. Three files name the removed
  // symbol ON PURPOSE and must keep doing so: the two modules that replace it explain
  // what they replace, and shipped migration 164 records that the sweep existed to paper
  // over the `hr_minutes` half of the same defect. A guard that made those illegal would
  // force the tree to forget why the sweep went, which is the one thing worth keeping
  // about it.
  //
  // AND IT DOES NOT BLANK THE WHOLE TREE TO ASK. An earlier draft mapped every source
  // through comment projection and held the results, which cost 3.2 s idle against this
  // tier's 15 s ceiling and timed out 6/6 on a loaded box — a guard that fails when the
  // machine is busy is a guard that gets quarantined. The names below cannot appear in a
  // blanked file without appearing in the raw one, so the raw text is the filter and only
  // the handful of files that mention the sweep at all pay for the lexer.
  it("no source file CALLS or IMPORTS the deleted sweep", () => {
    const NAMES = [
      "sweepIngestWindowForTimezoneChange",
      "integrations/ingest-timezone-sweep",
    ];
    const hits: string[] = [];
    for (const { rel, raw } of sources) {
      if (!NAMES.some((n) => raw.includes(n))) continue;
      const code = stripComments(raw);
      if (NAMES.some((n) => code.includes(n))) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });

  it("still SEES the sweep when it is code rather than prose", () => {
    // The guard above passes on a clean tree; this is what proves it is not passing
    // because comment blanking ate the evidence.
    const planted = stripComments(`
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

  // THE EVASION THE PREFIX ALLOWED, and the reason the match is exact. The allowlist
  // entry for the reconcile used to be the PREFIX `"DELETE FROM body_metrics"`, so the
  // blind sweep this whole issue removed — replanted in the reconcile's own module, the
  // one place it would look at home — was found by the scan and then silently allowed.
  it("FLAGS a blind sweep replanted in the RECONCILE's own module", () => {
    const planted = `db.prepare(\`DELETE FROM body_metrics WHERE profile_id = ? AND date >= ?\`).run(p, cutoff);`;
    const found = scanFile(
      "lib/integrations/ingest-timezone-reconcile.ts",
      planted
    );
    expect(found).toHaveLength(1);
    expect(allowed(found[0])).toBe(false);
    // …while the statement that module really runs is allowed, so this is exactness and
    // not a file-level ban.
    const real = scanFile(
      "lib/integrations/ingest-timezone-reconcile.ts",
      `db.prepare(\`DELETE FROM body_metrics
          WHERE profile_id = ? AND date = ? AND source IS ?\`);`
    );
    expect(real).toHaveLength(1);
    expect(allowed(real[0])).toBe(true);
  });

  it("FLAGS a statement that merely EXTENDS an allowlisted one", () => {
    // The other half of "exact, not a prefix": appending a clause is a new statement and
    // comes back for review.
    const found = scanFile(
      "lib/integrations/ingest-timezone-reconcile.ts",
      `db.prepare("DELETE FROM body_metrics WHERE profile_id = ? AND date = ? AND source IS ? OR 1 = 1");`
    );
    expect(found).toHaveLength(1);
    expect(allowed(found[0])).toBe(false);
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
