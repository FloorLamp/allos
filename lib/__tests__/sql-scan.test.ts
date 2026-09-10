import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { REPO, firstStringArgs, norm, prepareArgs, relPath } from "./sql-scan";

// The shared extractor's own spec. It exists because the guards that read
// `sql-scan.ts` cannot each re-prove the extraction — that re-growing is the
// duplication the helper is here to end — so the extraction's edges are stated
// once, here, against fixtures.

const prep = /\.prepare\s*\(/g;
const texts = (src: string): string[] =>
  firstStringArgs(src, prep).map((a) => norm(a.text));

describe("firstStringArgs reads a statement split across `+`-joined literals", () => {
  // The hole this closes: the reader stopped at the FIRST literal's closing
  // quote, so everything after the `+` — routinely the WHERE — was dropped, and
  // the caller saw a statement that looked complete because nothing said it was
  // not. A truncated `UPDATE … SET x` is not a shorter statement, it is a
  // DIFFERENT and more alarming one.
  it("joins two double-quoted literals", () => {
    expect(
      texts('db.prepare("SELECT * FROM " + "users WHERE id = ?")')
    ).toEqual(["SELECT * FROM users WHERE id = ?"]);
  });

  it("joins backtick literals split across lines, the shape the tree uses", () => {
    expect(
      texts(
        "db.prepare(\n  `UPDATE t SET a = 1 ` +\n    `WHERE profile_id = ?`\n)"
      )
    ).toEqual(["UPDATE t SET a = 1 WHERE profile_id = ?"]);
  });

  it("joins more than two", () => {
    expect(texts("db.prepare(`A ` + `B ` + `C`)")).toEqual(["A B C"]);
  });

  it("keeps `composed` keyed on the statement's OPENING literal", () => {
    // `composed` marks a literal whose statement POSITION is an interpolation.
    // Concatenation only appends, so it cannot change what the statement starts
    // with — and a trailing piece must not be able to clear the flag.
    const [a] = firstStringArgs(
      "db.prepare(`${verb} FROM t ` + `WHERE x`)",
      prep
    );
    expect(a).toEqual({
      kind: "sql",
      text: "${verb} FROM t WHERE x",
      composed: true,
    });
  });

  it("stops at a `+` whose right side is not a literal — a stated limit", () => {
    // The scan cannot know what an expression holds; reading a prefix is honest,
    // guessing is not. Documented so a future reader does not read this as a bug.
    expect(texts("db.prepare(`SELECT ` + col + ` FROM t`)")).toEqual([
      "SELECT",
    ]);
  });

  it("does not swallow a NEXT prepare call while looking for a `+`", () => {
    expect(
      texts('db.prepare("SELECT 1").run(); db.prepare("SELECT 2").run();')
    ).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("still reads a lone literal, and a non-literal argument, unchanged", () => {
    expect(texts('db.prepare("SELECT 1")')).toEqual(["SELECT 1"]);
    expect(firstStringArgs("db.prepare(buildSql(x))", prep)).toEqual([
      { kind: "expr", text: "buildSql(x)" },
    ]);
  });

  it("does not treat an escaped quote as the literal's end", () => {
    expect(texts('db.prepare("a \\" b" + " c")')).toEqual(['a " b c']);
  });
});

describe("the live statements the hole was hiding", () => {
  // Not a fixture: the two statements in the tree that the truncating reader
  // actually mis-read. A single-line `git grep` for `"…" +` reported the tree
  // clean because BOTH are written across lines, which is why this is pinned to
  // the real file rather than to a probe string.
  const src = fs.readFileSync(
    path.join(REPO, "lib/migrations/cascade-delete.ts"),
    "utf8"
  );
  const all = prepareArgs(src).map((a) => norm(a.text));

  it("reads the set-null UPDATE's WHERE, which used to be dropped", () => {
    const stmt = all.find((s) => s.startsWith("UPDATE ${q(link.table)}"));
    expect(stmt).toBe(
      "UPDATE ${q(link.table)} AS ${alias} SET ${sets} WHERE ${childPredicate.sql}"
    );
  });

  it("reads the orphan DELETE's NOT EXISTS subquery, which used to be cut off", () => {
    const stmt = all.find((s) => s.includes("AND NOT EXISTS"));
    expect(stmt).toBe(
      "DELETE FROM ${q(table)} WHERE ${notNull} AND NOT EXISTS " +
        "(SELECT 1 FROM ${q(link.parent)} p WHERE ${join})"
    );
  });
});

describe("relPath is the posix repo-relative path every allowlist is keyed on", () => {
  it("agrees with the expression the guards used to inline", () => {
    const f = path.join(REPO, "lib", "db.ts");
    expect(relPath(f)).toBe("lib/db.ts");
    expect(relPath(f)).toBe(path.relative(REPO, f).split(path.sep).join("/"));
  });
});
