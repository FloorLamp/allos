import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The repo's source-scan reader, shared by the guards that ask "where does this
// JSX tag still get hand-rolled" (`time-input-scan.test.ts`,
// `media-input-scan.test.ts`, `menu-item-role-scan.test.ts`). It reads TSX as
// TEXT — no DB, no network, so the scans stay "pure".
//
// WHY TOKENIZE RATHER THAN GREP. Three shapes defeat a line-keyed regex and all
// three are in this tree: an attribute value spans lines (so `type` and the tag
// are not on one line), an `onChange` arrow's `=>` looks exactly like the tag's
// closing `>`, and a tag written inside a comment or a string is not a tag at
// all. A scan that miscounts in either direction is worse than none, because the
// work it invents looks justified.
//
// TWO MORE SHAPES, AND BOTH WERE HIDING REAL POPULATION (#5181). A census blind
// to part of its own population reads as a clean bill of health, so these are
// worth naming:
//
//   * A COMMENT INSIDE THE ATTRIBUTE LIST. `<OverflowMenu` … `// (\`Actions for
//     entry from ${label}\`)` … `>` is legal JSX and this tree writes it
//     (app/(app)/trends/BodyMetricRowMenu.tsx). The tokenizer only skipped
//     comments BETWEEN tags, so a backtick inside one opened a template string
//     that ran to the next backtick — swallowing the tag and everything after it
//     until the tokenizer resynchronised. Two whole ⋯ menus went unseen.
//   * JSX NESTED IN A BRACED ATTRIBUTE. `<PageHeader action={<div><OverflowMenu
//     …>}` puts a real subtree inside an attribute value
//     (app/(app)/protocols/ProtocolControls.tsx, app/(app)/wellness/PracticeCard.tsx).
//     Braces were skipped wholesale, so those tags were invisible — and worse,
//     their attributes leaked into the OUTER tag's attribute text, which invents
//     population as readily as it hides it.
//
// `jsxTags` handles both: it skips comments wherever they may appear and
// descends into any braced attribute value that turns out to hold JSX.

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

/** End of the comment starting at `i`, or -1 when `i` does not start one. */
function skipComment(s: string, i: number): number {
  if (s[i] !== "/") return -1;
  if (s[i + 1] === "/") {
    const nl = s.indexOf("\n", i);
    return nl === -1 ? s.length : nl;
  }
  if (s[i + 1] === "*") {
    const end = s.indexOf("*/", i);
    return end === -1 ? s.length : end + 2;
  }
  return -1;
}

function skipBraces(s: string, i: number): number {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(s, i);
      continue;
    }
    const comment = skipComment(s, i);
    if (comment !== -1) {
      i = comment;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
}

export interface JsxTag {
  /** `button`, `Link`, `OverflowMenu` — as written. */
  name: string;
  /**
   * The tag's OWN attribute text. Quoted values are kept whole; a braced value
   * is kept when it is an expression (`className={MENU_ITEM}`) and dropped when
   * it holds JSX, whose tags are reported separately rather than folded in here.
   */
  attrs: string;
  /** `attrs` with every braced value removed — attribute names and quoted values. */
  attrsBare: string;
  selfClosing: boolean;
  /** Index of the `<`, and of the character after the `>`, in the source text. */
  start: number;
  end: number;
}

function parseTag(text: string, start: number, out: JsxTag[]): JsxTag | null {
  let j = start + 1;
  while (j < text.length && /[\w.]/.test(text[j])) j++;
  const name = text.slice(start + 1, j);
  let attrs = "";
  let attrsBare = "";
  let closed = false;
  while (j < text.length) {
    const c = text[j];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(text, j);
      attrs += text.slice(j, end);
      attrsBare += text.slice(j, end);
      j = end;
      continue;
    }
    const comment = skipComment(text, j);
    if (comment !== -1) {
      j = comment;
      continue;
    }
    if (c === "{") {
      const end = skipBraces(text, j);
      const before = out.length;
      scanRange(text, j + 1, end - 1, out);
      // A braced value holding JSX is a subtree, not this tag's attribute text.
      if (out.length === before) attrs += text.slice(j, end);
      j = end;
      continue;
    }
    if (c === ">") {
      closed = true;
      j++;
      break;
    }
    attrs += c;
    attrsBare += c;
    j++;
  }
  if (!closed) return null;
  return {
    name,
    attrs,
    attrsBare,
    selfClosing: /\/\s*$/.test(attrs),
    start,
    end: j,
  };
}

function scanRange(text: string, from: number, to: number, out: JsxTag[]): void {
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i);
      continue;
    }
    const comment = skipComment(text, i);
    if (comment !== -1) {
      i = comment;
      continue;
    }
    if (c === "<" && /[A-Za-z]/.test(text[i + 1] ?? "")) {
      const tag = parseTag(text, i, out);
      if (tag) {
        out.push(tag);
        i = tag.end;
        continue;
      }
    }
    i++;
  }
}

/**
 * Every opening tag in `text`, in source order — including tags nested inside a
 * braced attribute value. Offsets are into `text`, so a caller can ask which
 * tags fall inside a region it has already located.
 */
export function jsxTags(text: string): JsxTag[] {
  const out: JsxTag[] = [];
  scanRange(text, 0, text.length, out);
  return out.sort((a, b) => a.start - b.start);
}

/** 1-based line number of `index` in `text`. */
export function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
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
  return jsxTags(text)
    .filter((t) => t.name === tag && matches(t.attrsBare))
    .map((t) => lineAt(text, t.start));
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
