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

export type SqlArg = { kind: "sql" | "expr"; text: string };

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
      let j = i + 1;
      let buf = "";
      while (j < src.length) {
        const c = src[j];
        if (c === "\\") {
          buf += src[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (c === q) break;
        buf += c;
        j++;
      }
      out.push({ kind: "sql", text: buf });
      re.lastIndex = j + 1;
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

// ── Composed statements ───────────────────────────────────────────────────────
//
// A prepared statement is often assembled from module-scope SQL consts:
//
//     const ACTIVITIES_SELECT = `SELECT … FROM activities WHERE profile_id = ?`;
//     db.prepare(`${ACTIVITIES_SELECT} LIMIT ? OFFSET ?`)
//
// The extracted literal is then `${ACTIVITIES_SELECT} LIMIT ? OFFSET ?` — text that
// names no table, so a scan asking "does this touch an owned table" answers no and
// DROPS the statement. Silently: no violation, no allowlist entry, nothing to read.
// That is how the activities page read stopped being checked when it was hoisted
// (#5117), and the fix is not a new allowlist entry but reading what was written:
// substitute the consts and scan the statement the code actually prepares.
//
// MODULE SCOPE ONLY (`const` at column 0), because that is what makes the
// substitution sound — a function-local const is indented and could be rebound per
// call, so it stays unresolved and the caller decides what to do with an unresolved
// statement. Same reason only a BARE IDENTIFIER is substituted: `${a.b}`,
// `${f(x)}` and `${xs.join(",")}` are runtime values, not text this scan can read.
//
// SUBSTITUTING THE WRONG TEXT IS WORSE THAN SUBSTITUTING NOTHING. An unresolved
// statement is refused by its reader, out loud; a WRONGLY resolved one is a census
// that reports "checked" about a statement it never read. So resolution refuses on
// any doubt about which text a name stands for:
//
//   - the declaration must be CODE. `codeSpans` marks the offsets inside comments
//     and inside other strings, so a `const X = ...;` that only LOOKS like a
//     declaration — sitting at column 0 inside a block comment, or inside a
//     multi-line template — is not read as one.
//   - the name must mean ONE thing in the file. A name RE-DECLARED anywhere at
//     non-zero indentation is a local SHADOW: at the `.prepare` site it may carry
//     the local's text rather than the module const's, and substituting the module
//     const there asserts a predicate the running statement need not have.
//     `redeclaredLocally` looks for that in the RAW source (comments included) and
//     drops the name — deliberately eager, because a false positive costs one
//     refusal and a false negative costs the invariant. Two column-0 declarations
//     of one name drop it for the same reason.
//
// What this does NOT see is a shadow introduced by a PARAMETER (`function
// f(ACTIVITIES_SELECT)`) or by a destructuring form the pattern below misses: a bare
// name in a parameter list cannot be told from the same name passed as an argument,
// and refusing every const that is ever passed to a function would refuse nearly all
// of them. No such shadow exists on the tree, and eslint has no `no-shadow` rule.
export function sqlConsts(src: string): Map<string, string> {
  const code = codeSpans(src);
  const consts = new Map<string, string>();
  const dropped = new Set<string>();
  const re =
    /(?:^|\n)const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:`([^`]*)`|"([^"\\]*)")\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const at = m.index + (src[m.index] === "\n" ? 1 : 0);
    if (!code.isCode(at) || code.depthAt(at) !== 0) continue;
    const name = m[1];
    if (dropped.has(name)) continue;
    if (consts.has(name) || redeclaredLocally(src, name)) {
      consts.delete(name);
      dropped.add(name);
      continue;
    }
    consts.set(name, m[2] ?? m[3]);
  }
  return consts;
}

// Is `name` declared anywhere other than at the start of a line — indented, which in
// this prettier-formatted codebase means inside a function, block or class body?
// Read off the raw source, comments included: the answer only ever REMOVES a const
// from the map, and a refusal is always the safe direction.
function redeclaredLocally(src: string, name: string): boolean {
  const n = name.replace(/[$]/g, "\\$&");
  return new RegExp(
    `[^\\n]\\b(?:const|let|var|function|class)\\s+(?:${n}\\b|\\{[^}\\n]*\\b${n}\\b)`
  ).test(src);
}

// Which offsets of a source file are CODE (outside every comment and string), and how
// deeply braced each one is. A small state machine, not a parser: the only question
// asked of it is whether a `const NAME = ...;` at column 0 is a real module-scope
// declaration.
//
// The two ways of being wrong are NOT symmetric, and the asymmetry is worth stating
// exactly. Mistaking code for a string or comment drops a const, and the statement
// composed from it then goes unresolved and is refused by its reader — the safe
// direction. Mistaking a string for code ADDS a candidate name, and that candidate is
// dropped again the moment the name is declared anywhere else — but `redeclaredLocally`
// looks for const/let/var/function/class and NEVER for an IMPORT, so a name bound by an
// import escapes the drop.
//
// So the hole is real and it is narrow: a depth-0 `/` misread by the regex heuristic
// (a `/` opens a regex only where an operand cannot precede it) desyncs the scan into a
// block comment, a commented-out `const NAME = `…`;` at column 0 is then read as a
// declaration, and NAME is really bound by an import — at which point a statement gets
// SUBSTITUTED with text it never runs and the census reports "checked" about a statement
// it never read. Two things bound it: the depth counter refuses the same shape anywhere
// inside a function body (only column 0 at depth 0 is read), and no scanned file today
// contains it — every name this map holds is declared in the file that uses it, none is
// also bound by an import there. That is "does not happen on this tree", not "cannot
// happen", and the second sentence is the one this comment used to make.
function codeSpans(src: string): {
  isCode: (i: number) => boolean;
  depthAt: (i: number) => number;
} {
  const code = new Uint8Array(src.length);
  const depth = new Int32Array(src.length);
  // The brace depth at which each enclosing template's `${` opened, so its matching
  // `}` returns to template TEXT instead of closing a block.
  const tplExpr: number[] = [];
  let mode: "code" | "line" | "block" | "sq" | "dq" | "tpl" | "re" = "code";
  let d = 0;
  let prev = ""; // last non-space code character, for the regex heuristic
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    if (mode === "code") {
      code[i] = 1;
      depth[i] = d;
      if (c === "/" && c2 === "/") {
        mode = "line";
        i += 2;
        continue;
      }
      if (c === "/" && c2 === "*") {
        mode = "block";
        i += 2;
        continue;
      }
      if (c === "/" && prev !== "" && !/[\w$)\]]/.test(prev)) {
        mode = "re";
        i++;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") {
        mode = c === "'" ? "sq" : c === '"' ? "dq" : "tpl";
        i++;
        continue;
      }
      if (c === "{") d++;
      else if (c === "}") {
        if (tplExpr.length > 0 && d === tplExpr[tplExpr.length - 1]) {
          tplExpr.pop();
          mode = "tpl";
          i++;
          continue;
        }
        d = Math.max(0, d - 1);
      }
      if (!/\s/.test(c)) prev = c;
      i++;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") mode = "code";
      i++;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && c2 === "/") {
        mode = "code";
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    // Inside a string, template or regex body: an escape consumes the next char.
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (mode === "tpl" && c === "$" && c2 === "{") {
      tplExpr.push(d);
      mode = "code";
      i += 2;
      continue;
    }
    if (
      (mode === "sq" && c === "'") ||
      (mode === "dq" && c === '"') ||
      (mode === "tpl" && c === "`") ||
      (mode === "re" && (c === "/" || c === "\n"))
    ) {
      mode = "code";
      if (c !== "\n") prev = c;
      i++;
      continue;
    }
    i++;
  }
  return {
    isCode: (at: number) => code[at] === 1,
    depthAt: (at: number) => depth[at],
  };
}

// Substitute every `${IDENT}` that names one of `consts`, recursively (a const may
// itself be composed). `resolved` is false when any interpolation survives — the
// statement is then only PARTLY readable, and its reader must say so out loud rather
// than treat the remaining text as the whole statement.
export function resolveSqlConsts(
  text: string,
  consts: Map<string, string>,
  depth = 0
): { text: string; resolved: boolean } {
  if (depth > 5) return { text, resolved: false };
  let resolved = true;
  const out = text.replace(/\$\{([^}]*)\}/g, (whole, expr: string) => {
    const value = consts.get(expr.trim());
    if (value === undefined) {
      resolved = false;
      return whole;
    }
    const inner = resolveSqlConsts(value, consts, depth + 1);
    if (!inner.resolved) resolved = false;
    return inner.text;
  });
  return { text: out, resolved };
}

export const readSource = (file: string) => fs.readFileSync(file, "utf8");
