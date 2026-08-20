import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// SQLite's CASE FOLD IS NOT THIS APP'S CASE FOLD (#3325).
//
// The free-text vocabularies fold case for MATCHING through one pure function,
// `foldVocabularyName()` (lib/vocabulary-fold.ts), which uses JS `toLowerCase()` and is
// therefore UNICODE-AWARE. SQLite's `LOWER()` / `UPPER()` / `COLLATE NOCASE` fold ASCII
// A–Z ONLY: to SQLite, "ÄRZTE" and "ärzte" are two different strings, and "STRASSE" and
// "strasse" are one.
//
// So a case-insensitive MATCH written in SQL over a vocabulary column would fold
// DIFFERENTLY from the write boundary that minted the keys — and the failure is silent
// and in the worst direction. Two spellings that are one entry to `logSymptomCore` would
// be two rows to that query, and the duplicate this issue exists to prevent reappears in
// somebody's record, on a surface that reads correct.
//
// A COMMENT SAYING "DO NOT REACH FOR `LOWER()`" IS TRUE THE DAY IT IS WRITTEN AND
// UNCHECKED EVER AFTER — the #3260 shape, where a stated reason quietly went false and
// nothing was watching. This is the check instead. It fires the day someone reaches for
// the ASCII fold, and it names the answer: register the pure function as a SQLite user
// function, the way `biomarker_family` calls `biomarkerFamily()` through
// `registerSqlFunctions()` (lib/sql-functions.ts) rather than re-realizing the identity
// in SQL where it can drift.
//
// ---- WHAT IS FLAGGED, AND WHAT IS DELIBERATELY NOT ---------------------------
//
// SORTING IS NOT MATCHING. `ORDER BY symptom COLLATE NOCASE` decides the order rows are
// READ IN; it groups nothing and keys nothing, so an ASCII fold there can put two rows in
// a surprising order and can do nothing worse. Five such sorts ship today
// (lib/queries/symptoms.ts, lib/export.ts) and they are correct. Anything else — `=`,
// `IN`, `GROUP BY`, `PARTITION BY`, a JOIN condition — is IDENTITY, and identity is what
// must not be spelled twice.
//
// `substance` IS AN AMBIGUOUS COLUMN NAME, which is why the `COLLATE NOCASE` half of this
// census is scoped to statements naming the two vocabulary LEDGERS. `allergies.substance`
// is the ALLERGEN domain (`allergenKey()`, a different identity function with its own
// registry row), and it is sorted `COLLATE NOCASE` in several places. A census that
// flagged those would need an exception list of unrelated rows, and a guard that cries
// wolf is a guard somebody deletes. The `LOWER(` / `UPPER(` half needs no such scoping:
// that spelling appears nowhere in the tree today, on any column, so it is checked
// everywhere and starts from zero.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// The ledgers that REGISTER a free-text vocabulary key (lib/vocabulary-store.ts), and the
// column in each that holds the spelling.
const VOCABULARY_TABLES = ["symptom_logs", "substance_daily_totals"];
const VOCABULARY_COLUMNS = ["symptom", "substance"];

/**
 * A case fold applied to a vocabulary column by SQLite's own (ASCII) rules.
 *
 * `LOWER(symptom)`, `lower(s.symptom)`, `UPPER(symptom_logs.symptom)` — the optional
 * qualifier is what a JOIN spells, and matching it is why an aliased table cannot slip
 * past.
 */
const SQL_FOLD_CALL = new RegExp(
  String.raw`\b(?:lower|upper)\s*\(\s*(?:[A-Za-z_]\w*\s*\.\s*)?(?:` +
    VOCABULARY_COLUMNS.join("|") +
    String.raw`)\s*\)`,
  "gi"
);

/**
 * String and template literals in a source file — where SQL lives in this repo.
 *
 * Deliberately crude: it over-collects (every literal, SQL or not), and over-collecting
 * costs a regex pass while under-collecting costs the whole point of the census.
 */
function literals(source: string): string[] {
  return [
    ...(source.match(/`[^`]*`/gs) ?? []),
    ...(source.match(/"(?:[^"\\\n]|\\.)*"/g) ?? []),
    ...(source.match(/'(?:[^'\\\n]|\\.)*'/g) ?? []),
  ];
}

/** SQLite's other ASCII fold, and the one people actually reach for. */
const SQL_NOCASE = /\bcollate\s+nocase\b/gi;

/** A vocabulary column, optionally qualified by a table name or a JOIN alias. */
const VOCABULARY_COLUMN_REF = new RegExp(
  String.raw`\b(?:[A-Za-z_]\w*\s*\.\s*)?(?:` +
    VOCABULARY_COLUMNS.join("|") +
    String.raw`)\b`,
  "i"
);

// The SQL clause an expression belongs to. Read BACKWARDS to the nearest one, because a
// fold in a WHERE that merely follows an ORDER BY inside an earlier subquery must not be
// excused by it.
const CLAUSE_KEYWORD =
  /\b(order\s+by|group\s+by|partition\s+by|where|having|on|select|set|values|join)\b/gi;

// Within a clause, the boundaries of ONE comparison. `WHERE symptom = ? AND note = ?
// COLLATE NOCASE` folds the NOTE, and reading back only to `AND` is what keeps the
// neighbouring `symptom` from making that a false positive.
const CONJUNCT_BOUNDARY = /\b(and|or)\b|,/gi;

/** The text of the last match of `pattern` in `before`, and where it started. */
function lastMatch(
  before: string,
  pattern: RegExp
): { text: string; index: number } | null {
  let found: { text: string; index: number } | null = null;
  const re = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"
  );
  for (const m of before.matchAll(re)) found = { text: m[0], index: m.index };
  return found;
}

/**
 * Whether a fold sits in an ORDER BY — the one position where an ASCII fold decides
 * nothing (see the header). Checked on the CLAUSE, before the column check below, so a
 * multi-key sort like `ORDER BY severity DESC, symptom COLLATE NOCASE` stays quiet.
 */
function isSortPosition(sql: string, matchIndex: number): boolean {
  const clause = lastMatch(sql.slice(0, matchIndex), CLAUSE_KEYWORD);
  return (
    clause != null && /^order\s+by$/i.test(clause.text.replace(/\s+/g, " "))
  );
}

/** Whether the comparison this fold applies to actually names a vocabulary column. */
function foldsAVocabularyColumn(sql: string, matchIndex: number): boolean {
  const before = sql.slice(0, matchIndex);
  const clause = lastMatch(before, CLAUSE_KEYWORD);
  const conjunct = lastMatch(before, CONJUNCT_BOUNDARY);
  const start = Math.max(
    clause == null ? 0 : clause.index + clause.text.length,
    conjunct == null ? 0 : conjunct.index + conjunct.text.length
  );
  return VOCABULARY_COLUMN_REF.test(before.slice(start));
}

export interface FoldSite {
  file: string;
  snippet: string;
  why: string;
}

/**
 * Every ASCII case fold this census considers an IDENTITY decision. Exported so the reach
 * test below can run it over sources written to break it — a green sweep over a tree that
 * happens to comply proves nothing about what the sweep can SEE (the #3206 lesson).
 */
export function foldSites(file: string, source: string): FoldSite[] {
  const found: FoldSite[] = [];
  for (const literal of literals(source)) {
    for (const m of literal.matchAll(SQL_FOLD_CALL)) {
      if (isSortPosition(literal, m.index)) continue;
      found.push({
        file,
        snippet: m[0],
        why: "LOWER()/UPPER() folds ASCII only",
      });
    }
    if (!VOCABULARY_TABLES.some((t) => literal.includes(t))) continue;
    for (const m of literal.matchAll(SQL_NOCASE)) {
      if (isSortPosition(literal, m.index)) continue;
      if (!foldsAVocabularyColumn(literal, m.index)) continue;
      found.push({
        file,
        snippet: literal
          .slice(Math.max(0, m.index - 40), m.index + m[0].length)
          .replace(/\s+/g, " ")
          .trim(),
        why: "COLLATE NOCASE folds ASCII only",
      });
    }
  }
  return found;
}

function trackedSources(): string[] {
  return (
    execFileSync("git", ["ls-files", "-z", "*.ts", "*.tsx"], {
      cwd: REPO,
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      // This file spells every forbidden shape in order to look for it.
      .filter((f) => !f.endsWith("vocabulary-sql-fold-census.test.ts"))
  );
}

describe("the vocabulary SQL case-fold census (#3325)", () => {
  it("finds no SQL folding a vocabulary key by SQLite's ASCII rules", () => {
    const sites = trackedSources().flatMap((relative) =>
      foldSites(relative, readFileSync(path.join(REPO, relative), "utf8"))
    );
    expect(
      sites.map(
        (s) =>
          `${s.file}: \`${s.snippet}\` — ${s.why}, while foldVocabularyName() is ` +
          `Unicode-aware, so this query and the write boundary disagree about which ` +
          `spellings are ONE entry. Register the pure fold as a SQLite user function ` +
          `(the biomarker_family pattern in lib/sql-functions.ts) instead of ` +
          `re-spelling the identity in SQL.`
      )
    ).toEqual([]);
  });

  it("leaves the ORDER BY sorts that ship today alone", () => {
    // The other direction: a census that flagged these would be deleted within a week,
    // so its silence on them is part of what is being asserted.
    const sorted = [
      "lib/queries/symptoms.ts",
      "lib/export.ts",
      "lib/queries/clinical.ts",
      "lib/queries/imports.ts",
    ];
    for (const relative of sorted) {
      const source = readFileSync(path.join(REPO, relative), "utf8");
      expect(source).toMatch(/collate nocase/i); // the fixture still has something to say
      expect(foldSites(relative, source)).toEqual([]);
    }
  });
});

describe("the census's reach", () => {
  // Run over sources written to BREAK it, because a green sweep proves the tree complies
  // and says nothing about whether the sweep can see (lib/__tests__/nul-byte-census.test.ts,
  // #3206). Each case below is a shape somebody could plausibly write.
  const caught = (sql: string): number =>
    foldSites("probe.ts", "db.prepare(`" + sql + "`)").length;

  it("sees the fold spellings a query would actually use", () => {
    expect(caught("SELECT 1 FROM symptom_logs WHERE LOWER(symptom) = ?")).toBe(
      1
    );
    expect(
      caught("SELECT 1 FROM symptom_logs WHERE lower(s.symptom) = lower(?)")
    ).toBe(1);
    expect(
      caught(
        "SELECT substance FROM substance_daily_totals GROUP BY UPPER(substance)"
      )
    ).toBe(1);
    expect(
      caught(
        "SELECT 1 FROM substance_daily_totals WHERE substance = ? COLLATE NOCASE"
      )
    ).toBe(1);
    expect(
      caught("SELECT symptom FROM symptom_logs GROUP BY symptom COLLATE NOCASE")
    ).toBe(1);
    // A qualified column behind a table ALIAS, which is what a JOIN spells.
    expect(
      caught(
        "SELECT 1 FROM symptom_logs sl JOIN x ON x.k = sl.symptom COLLATE NOCASE"
      )
    ).toBe(1);
    // A window PARTITION BY — grouping under another name.
    expect(
      caught(
        "SELECT ROW_NUMBER() OVER (PARTITION BY substance COLLATE NOCASE) FROM substance_daily_totals"
      )
    ).toBe(1);
  });

  it("does not excuse a WHERE fold just because an ORDER BY appeared earlier", () => {
    // The "nearest clause, not any clause" rule. A subquery ordering, then a real match.
    expect(
      caught(
        "SELECT (SELECT symptom FROM symptom_logs ORDER BY symptom COLLATE NOCASE LIMIT 1) " +
          "FROM symptom_logs WHERE symptom = ? COLLATE NOCASE"
      )
    ).toBe(1);
  });

  it("stays quiet on sorting, and on the allergen column that is not this vocabulary", () => {
    expect(
      caught("SELECT symptom FROM symptom_logs ORDER BY symptom COLLATE NOCASE")
    ).toBe(0);
    // allergies.substance is the ALLERGEN identity, a different domain entirely.
    expect(
      caught(
        "SELECT substance FROM allergies WHERE substance = ? COLLATE NOCASE"
      )
    ).toBe(0);
    expect(
      caught("SELECT 1 FROM logins WHERE username = ? COLLATE NOCASE")
    ).toBe(0);
  });
});
