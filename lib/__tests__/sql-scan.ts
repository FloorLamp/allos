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
    if (rel.includes("__tests__") || f.endsWith(".test.ts")) return false;
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

export const readSource = (file: string) => fs.readFileSync(file, "utf8");
