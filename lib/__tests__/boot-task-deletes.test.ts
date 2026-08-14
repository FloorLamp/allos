// PURE TIER — issue #2780: every row a BOOT TASK deletes is classified, and an
// unclassified one fails here.
//
// WHY THIS GUARD EXISTS. `runMigrations` copies the database aside before it
// applies a pending migration (#2702), and `bootTasks(db)` runs immediately AFTER
// it — outside the ledger, on every boot. Anything a boot task deletes is therefore
// deleted after the snapshot was taken, so the copy does not contain it.
//
// The snapshot's trigger cannot be reused. It works because a pending set is
// non-empty only on an upgrade; boot tasks run on every boot by design, so
// "boot tasks are about to run" is true always, and snapshotting on it would take a
// copy of the database on every start of every install — the unbounded disk cost
// #2779 was careful to avoid.
//
// So the question was answered by ENUMERATION instead, and the answer is that no
// boot task removes a person's records: what they delete is a duplicate the same
// statement just made redundant, machine-coined vocabulary, or a derived cache.
// That verdict is recorded in docs/internals/migration-snapshot.md — and this file
// is what stops it from rotting. An enumeration true on the day it was written and
// never re-checked is #2444 exactly: a claim that reads like coverage.
//
// WHAT IT SCANS, AND WHAT IT CANNOT SEE. `lib/migrations/boot-tasks.ts` plus the
// `lib/` modules it imports — computed from the file, not declared here, so a new
// boot task's module is scanned the moment it is imported. Two blind spots, stated
// rather than implied:
//
//   • A delete one hop further out — a boot-task module calling a query helper that
//     deletes — is not seen. The census is a tripwire on where boot-task code is
//     WRITTEN, not a proof about the whole call graph.
//   • A delete with no `DELETE` token (a table rebuild copying a filtered subset)
//     is invisible to any lexical rule, which is the argument #2703 settled. The
//     runner's `foreign_key_check` delta is the behavioural answer to that class.
//
// A `DELETE FROM` whose table is not a bare identifier FAILS rather than being
// skipped, so the scan cannot quietly stop seeing things — the #2772 lesson.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ENTRY = path.join(REPO, "lib/migrations/boot-tasks.ts");

/**
 * What a boot task removes, and why it is not the #2702 exposure.
 *
 * A new entry is a decision, not paperwork: if the rows are ones a PERSON entered
 * and nothing carries them forward, the honest answer is not another line here —
 * it is that the sweep belongs in a migration, where #2779's copy already covers
 * it, or that the boot task needs a copy of its own.
 */
interface BootTaskDelete {
  /** Repo-relative module. */
  file: string;
  table: string;
  /** What class of row, and what makes losing it recoverable. */
  why: string;
}

const BOOT_TASK_DELETES: BootTaskDelete[] = [
  {
    file: "lib/canonical-alias-merge-db.ts",
    table: "saved_items",
    why: "the ★ pin on a retired biomarker spelling, deleted only after the UPDATE OR IGNORE above it moved the pin onto the surviving spelling — so this removes the row the carry made redundant, never the pin. Exercised in canonical-alias-merge.test.ts ('moves the ★ save onto the target and drops a redundant old pin').",
  },
  {
    file: "lib/canonical-alias-merge-db.ts",
    table: "upcoming_dismissals",
    why: "the retest snooze and flagged-result acknowledgment under the old derived key, same carry-then-delete shape — and skipped entirely when the rename leaves the derived key unchanged, so a live suppression is never eaten.",
  },
  {
    file: "lib/canonical-alias-merge-db.ts",
    table: "coverage_gaps",
    why: "the tracked 'not in the catalog' gap under the old key, same carry-then-delete shape. Left behind it would be a phantom gap forever, naming an analyte nobody now has.",
  },
  {
    file: "lib/canonical-alias-merge-db.ts",
    table: "canonical_result_definitions",
    why: "an ai-coined vocabulary row the dataset has superseded. Scoped to source = 'ai', so a curated row is untouchable; nobody typed it, and the next import mints it again if it is still wanted.",
  },
  {
    file: "lib/canonical-alias-merge-db.ts",
    table: "canonical_biomarkers",
    why: "the same ai-coined vocabulary cleanup while immutable migration 174 replays before the #2737 table rename. The branch is unreachable to post-migration bootTasks; it remains literal so the frozen migration and this delete census both keep their contracts.",
  },
  {
    file: "lib/canonical-alias-merge-db.ts",
    table: "settings",
    why: "the canonical_flags_sig cache key only, cleared so reconcileFlagsIfCanonicalChanged re-derives once. Derived state, re-computed from the canonical ranges on the same boot.",
  },
];

/** Resolve a relative or `@/` import specifier to a file in the repo, or null. */
function resolveSpecifier(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(REPO, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null; // a package, not ours
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
}

/** boot-tasks.ts and the `lib/` modules it imports, repo-relative, sorted. */
function bootTaskModules(): string[] {
  const sf = parse(ENTRY);
  const out = new Set([ENTRY]);
  const visit = (node: ts.Node): void => {
    const spec =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments[0] &&
            ts.isStringLiteral(node.arguments[0])
          ? node.arguments[0].text
          : null;
    if (spec !== null) {
      const resolved = resolveSpecifier(ENTRY, spec);
      if (resolved?.endsWith(".ts")) out.add(resolved);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...out].map((f) => path.relative(REPO, f)).sort();
}

interface FoundDelete {
  file: string;
  line: number;
  /** null when the table is not a bare identifier — a gap, not a table. */
  table: string | null;
  text: string;
}

/**
 * Every `DELETE FROM …` inside a SQL string in `src`.
 *
 * String and template literals only, via the AST: a comment saying "the DELETE
 * below" must not invent a registration requirement, and a table name spliced in
 * with `${}` must not be read as the identifier that happens to follow it.
 */
function findDeletes(file: string, src: string): FoundDelete[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const found: FoundDelete[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      const raw = node.getText(sf);
      const start = node.getStart(sf);
      for (const m of raw.matchAll(/DELETE\s+FROM\s+/gi)) {
        const rest = raw.slice(m.index + m[0].length);
        const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
        found.push({
          file,
          line: sf.getLineAndCharacterOfPosition(start + m.index).line + 1,
          table: name ? name[0] : null,
          text: `${m[0]}${rest.slice(0, 40)}`.replace(/\s+/g, " ").trim(),
        });
      }
      return; // a template's own substitutions are text, already covered above
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function deletesIn(relFile: string): FoundDelete[] {
  return findDeletes(
    relFile,
    fs.readFileSync(path.join(REPO, relFile), "utf8")
  );
}

const MODULES = bootTaskModules();
const FOUND = MODULES.flatMap(deletesIn);
const key = (d: { file: string; table: string | null }): string =>
  `${d.file}: ${d.table}`;

describe("the boot-task delete census is not vacuous", () => {
  it("scans boot-tasks.ts and the lib modules it imports", () => {
    expect(MODULES).toContain("lib/migrations/boot-tasks.ts");
    expect(MODULES.length).toBeGreaterThan(5);
    // The one boot task that deletes anything today. If this module stops being
    // imported the census would go quiet, which must be noticed, not enjoyed.
    expect(MODULES).toContain("lib/canonical-alias-merge-db.ts");
  });

  it("finds the deletes it is here to classify", () => {
    expect(FOUND.length).toBeGreaterThan(0);
    expect(BOOT_TASK_DELETES.length).toBeGreaterThan(0);
  });
});

describe("every row a boot task deletes is classified (#2780)", () => {
  it("no boot-task delete is unregistered", () => {
    const registered = new Set(BOOT_TASK_DELETES.map(key));
    const unregistered = [
      ...new Set(FOUND.filter((d) => !registered.has(key(d))).map(key)),
    ].sort();
    expect(
      unregistered,
      "a boot task deletes rows a pre-migration snapshot does not contain: " +
        "bootTasks runs AFTER runMigrations took the copy, and it runs on every " +
        "boot, so the copy is behind the migrations and not behind this (#2780). " +
        "Add an entry to BOOT_TASK_DELETES saying what class of row it is and why " +
        "losing it is recoverable — and if the honest answer is that a person " +
        "entered those rows and nothing carries them forward, the sweep belongs " +
        "in a migration, where #2779's copy already covers it."
    ).toEqual([]);
  });

  it("no registration is stale", () => {
    const present = new Set(FOUND.map(key));
    const gone = BOOT_TASK_DELETES.filter((d) => !present.has(key(d))).map(key);
    expect(
      gone,
      "these deletes are no longer in the boot-task modules — drop the entries, " +
        "so the registry keeps describing what the code does"
    ).toEqual([]);
  });

  it("every registration says what the rows are and why losing them is survivable", () => {
    for (const d of BOOT_TASK_DELETES) {
      expect(d.why.length, `${key(d)} needs a real reason`).toBeGreaterThan(60);
    }
  });

  it("a delete whose table cannot be read is a failure, not a skip", () => {
    // The #2772 shape: a scan that silently stops recognising things reads like
    // coverage. An interpolated target has to be spelled out or the census cannot
    // say what it protects.
    const unreadable = FOUND.filter((d) => d.table === null).map(
      (d) => `${d.file}:${d.line} — ${d.text}`
    );
    expect(
      unreadable,
      "this census reads a bare table name after DELETE FROM. Name the table " +
        "literally, or the row class it removes goes unclassified while the guard " +
        "still reads like protection."
    ).toEqual([]);
  });
});

describe("the census can actually see an unclassified delete", () => {
  // The registry above is satisfied, so nothing in the tree proves the scan FIRES.
  // These drive the real scanner over sources written for the purpose.
  const scratch = (src: string): FoundDelete[] =>
    findDeletes("scratch.ts", src);

  it("reads a plain delete, across lines, and ignores one in a comment", () => {
    expect(
      scratch(
        "// the DELETE FROM symptom_logs below is the one to worry about\n" +
          "const sql = `DELETE FROM symptom_logs\n  WHERE profile_id = ?`;"
      ).map((d) => d.table)
    ).toEqual(["symptom_logs"]);
  });

  it("reports an interpolated target as unreadable rather than guessing", () => {
    expect(
      scratch("const sql = `DELETE FROM ${table} WHERE id = ?`;").map(
        (d) => d.table
      )
    ).toEqual([null]);
  });

  it("does not read the identifier after an interpolation as the table", () => {
    expect(
      scratch("const sql = `DELETE FROM ${prefix}_logs WHERE id = ?`;").map(
        (d) => d.table
      )
    ).toEqual([null]);
  });
});
