import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The repo's source-scan reader, shared by the guards that ask "where does this
// JSX tag still get hand-rolled" (`time-input-scan.test.ts`,
// `media-input-scan.test.ts`). It reads TSX as TEXT — no DB, no network, so the
// scans stay "pure".
//
// WHY TOKENIZE RATHER THAN GREP. Three shapes defeat a line-keyed regex and all
// three are in this tree: an attribute value spans lines (so `type` and the tag
// are not on one line), an `onChange` arrow's `=>` looks exactly like the tag's
// closing `>`, and a tag written inside a comment or a string is not a tag at
// all. A scan that miscounts in either direction is worse than none, because the
// work it invents looks justified.

export const REPO = path.resolve(
  fileURLToPath(new URL("../..", import.meta.url))
);

function skipString(s: string, i: number): number {
  const q = s[i];
  i++;
  while (i < s.length) {
    if (s[i] === "\\") i += 2;
    else if (s[i] === q) return i + 1;
    else if (q === "`" && s[i] === "$" && s[i + 1] === "{") {
      i = skipBraces(s, i + 1);
    } else i++;
  }
  return i;
}

function skipBraces(s: string, i: number): number {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") i = skipString(s, i);
    else if (c === "/" && s[i + 1] === "/") {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? s.length : nl;
    } else if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i);
      i = end === -1 ? s.length : end + 2;
    } else {
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
  }
  return i;
}

/**
 * Line numbers of every `<tag …>` opening tag whose attribute text satisfies
 * `matches`. The attribute text handed to the predicate has braced expressions
 * removed (their contents are code, not attributes) and quoted values kept.
 */
export function findTags(
  text: string,
  tag: string,
  matches: (attrs: string) => boolean
): number[] {
  const open = `<${tag}`;
  const out: number[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i);
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (
      c === "<" &&
      text.startsWith(open, i) &&
      !/\w/.test(text[i + open.length])
    ) {
      const start = i;
      let j = i + open.length;
      let attrs = "";
      let closed = false;
      while (j < text.length) {
        const a = text[j];
        if (a === '"' || a === "'" || a === "`") {
          const end = skipString(text, j);
          attrs += text.slice(j, end);
          j = end;
        } else if (a === "{") {
          j = skipBraces(text, j);
        } else if (a === ">") {
          closed = true;
          j++;
          break;
        } else {
          attrs += a;
          j++;
        }
      }
      if (closed && matches(attrs)) {
        out.push(text.slice(0, start).split("\n").length);
      }
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

/** Every `.tsx` under `dir`, recursively, skipping node_modules and .next. */
export function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walkTsx(full));
    } else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * repo-relative path → matching line numbers, over `dirs`. Absent files map to
 * nothing rather than throwing, so a scan's dir list can outlive a rename.
 */
export function scanDirs(
  dirs: readonly string[],
  find: (text: string, rel: string) => number[]
): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const d of dirs) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walkTsx(abs)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      const lines = find(fs.readFileSync(full, "utf8"), rel);
      if (lines.length > 0) found.set(rel, lines);
    }
  }
  return found;
}
