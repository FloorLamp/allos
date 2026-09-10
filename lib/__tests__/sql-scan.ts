// SHARED source-scanning machinery for the repo's static SQL guards.
//
// The profile-scoping guard (lib/__tests__/profile-scoping.test.ts) grew this: read the
// repo's own source as TEXT — no DB, no network, so the scan stays "pure" in the vitest
// sense — enumerate every `.prepare(` / `.exec(` first argument, and decide something
// about each statement. The gated-table write scan (lib/__tests__/stateful-writes.test.ts,
// issue #1893) asks a DIFFERENT question of the SAME statements, so the extraction lives
// here rather than being re-grown a second time with its own subtly different quoting and
// file-selection rules.
//
// NOT a test file (no `.test.ts` suffix), so vitest's `lib/**/*.test.ts` include never
// collects it, and the coverage denominator already excludes `lib/__tests__/**`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(
  fileURLToPath(new URL("../..", import.meta.url))
);

function walk(dir: string, out: string[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      walk(p, out);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
}

// The source surfaces to scan: all of lib (minus tests), every server-action
// file, and every route handler.
//
// "Minus tests" means the TEST DIRECTORIES too, not only the *.test.ts files in them.
// The exclusion used to read `rel.includes("__tests__")`, which is one underscore
// short of `__db_tests__` and `__action_tests__` — so 22 fixture and harness modules
// (lib/__db_tests__/fixtures.ts among them) sat inside the surface every one of these
// scans calls production. Measured: dropping a module declaring `newBundle` into
// lib/__db_tests__/ reds one-bundle-mint.test.ts, a rule about production code, on a
// file no production code imports.
export function sourceFiles(): string[] {
  const all: string[] = [];
  walk(path.join(REPO, "lib"), all);
  walk(path.join(REPO, "app"), all);
  return all.filter((f) => {
    // relPath, not path.relative: the checks below are written in posix form, and
    // on Windows a raw relative path is `lib\…`, so `startsWith("lib/")` was false
    // for EVERY file — the scans silently dropped all of lib/ rather than failing.
    const rel = relPath(f);
    if (!f.endsWith(".ts") && !f.endsWith(".tsx")) return false;
    if (/__[a-z_]*tests__\//.test(rel) || f.endsWith(".test.ts")) return false;
    if (rel.startsWith("lib/")) return true;
    return (
      f.endsWith("actions.ts") ||
      f.endsWith("route.ts") ||
      f.endsWith("route.tsx")
    );
  });
}

// A scanned file's repo-relative path, in posix form (so allowlist suffixes match on
// every platform).
export function relPath(file: string): string {
  return path.relative(REPO, file).split(path.sep).join("/");
}

// `composed` marks a LITERAL whose statement POSITION is an interpolation — the text
// begins with `${…}`, so the FROM and the WHERE live in whatever that expression
// holds and the scan can read neither. It is still `kind: "sql"` (the text is a
// literal, and every other scan reads it as one); the flag exists so the
// profile-scoping guard can REFUSE such a statement instead of skipping it for
// naming no owned table, which is what it did (#5323). A `FROM ${table}` literal is
// NOT this: the scan can still see that statement's shape and its predicates.
export type SqlArg = { kind: "sql" | "expr"; text: string; composed?: true };

// Read one string/template literal starting at `src[i]` (which is its opening quote).
// Returns the literal's contents and the index of its closing quote.
function readLiteral(
  src: string,
  i: number,
  quote: string
): { text: string; end: number } {
  let j = i + 1;
  let text = "";
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      text += src[j + 1] ?? "";
      j += 2;
      continue;
    }
    if (c === quote) break;
    text += c;
    j++;
  }
  return { text, end: j };
}

// Extract the first argument of every call matching `opener` (a global RegExp that
// ends at the call's opening paren, e.g. /\.prepare\s*\(/g or /\.exec\s*\(/g).
// Returns either the string literal's contents (kind "sql") or the raw expression
// text (kind "expr").
export function firstStringArgs(src: string, opener: RegExp): SqlArg[] {
  const out: SqlArg[] = [];
  const re = new RegExp(opener.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i++;
    const q = src[i];
    if (q === "`" || q === '"' || q === "'") {
      // Read to the matching, unescaped closing quote/backtick. Template
      // interpolations in this codebase never contain a backtick, so a naive
      // scan to the next backtick is safe.
      const first = readLiteral(src, i, q);
      let buf = first.text;
      let end = first.end;
      // A statement SPLIT ACROSS `+`-JOINED LITERALS is one statement, so keep
      // reading while the next non-space token is `+` followed by another literal.
      // Stopping at the first literal truncated the statement, and a truncated
      // statement is not merely shorter — it silently loses the tail, which is
      // where a WHERE lives. lib/migrations/cascade-delete.ts writes two this way
      // (the set-null UPDATE and the orphan DELETE): the scans read
      // `UPDATE … SET ${sets}` with no WHERE at all, and `DELETE … AND NOT EXISTS`
      // with the subquery that makes it safe cut off. The concatenation is written
      // ACROSS LINES, which is why the single-line `git grep` that looked for this
      // shape reported the tree clean.
      //
      // A `+` whose right side is NOT a literal (`"SELECT " + col + " FROM x"`)
      // still stops here: the scan cannot know what the expression holds, and
      // guessing would be worse than reading a prefix. That remains a stated limit.
      for (;;) {
        let k = end + 1;
        while (k < src.length && /\s/.test(src[k])) k++;
        if (src[k] !== "+") break;
        k++;
        while (k < src.length && /\s/.test(src[k])) k++;
        const q2 = src[k];
        if (q2 !== "`" && q2 !== '"' && q2 !== "'") break;
        const next = readLiteral(src, k, q2);
        buf += next.text;
        end = next.end;
      }
      out.push(
        /^\s*\$\{/.test(buf)
          ? { kind: "sql", text: buf, composed: true }
          : { kind: "sql", text: buf }
      );
      re.lastIndex = end + 1;
    } else {
      // Non-literal expression argument: capture up to the matching ')'.
      let depth = 1;
      let j = i;
      let buf = "";
      while (j < src.length && depth > 0) {
        const c = src[j];
        if (c === "(") depth++;
        else if (c === ")") {
          depth--;
          if (depth === 0) break;
        }
        buf += c;
        j++;
      }
      out.push({ kind: "expr", text: buf.trim() });
      re.lastIndex = j;
    }
  }
  return out;
}

// The `.prepare(` and `.exec(` argument extractors (both parametrize firstStringArgs).
//
// `hoistedStatement(` counts as a prepare site: it IS a prepared statement, just one
// whose compilation is deferred so it can survive a connection swap (lib/db.ts). It
// carries no leading dot, so a `.prepare`-only pattern would silently drop every SQL
// literal declared that way — and silently dropping statements is exactly how an
// owned-table scan starts passing for the wrong reason.
// The `function hoistedStatement(` DECLARATION in lib/db.ts is not a call site;
// without the lookbehind the scan reads its parameter list as an unverifiable SQL
// expression.
export const prepareArgs = (src: string) =>
  firstStringArgs(src, /(?:\.prepare|(?<!function\s)\bhoistedStatement)\s*\(/g);
export const execArgs = (src: string) => firstStringArgs(src, /\.exec\s*\(/g);

export const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export const readSource = (file: string) => fs.readFileSync(file, "utf8");
