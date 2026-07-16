import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static a11y guard for icon-only <button>s (issue #794 cluster 7a). An
// icon-only button — whose visible content is ONLY icon glyphs, no text —
// announces as an unnamed button to a screen reader unless it carries an
// accessible name (aria-label / aria-labelledby / title, or a visually-hidden
// `sr-only` text child). The app already labels its ~59 icon-only buttons; this
// test reads the repo's own TSX as TEXT (no DB, no network, so it stays "pure"
// in the vitest sense) and fails the build if a NEW icon-only button ships
// without a name, so the class can't regrow.
//
// WHAT THE HEURISTIC SEES (deliberately conservative — zero false positives beats
// perfect recall; a false positive would block an unrelated PR):
//   - It flags a `<button>` ONLY when, after stripping `{/* … */}` JSX comments
//     and whitespace, its children are exclusively self-closing `<Icon*/>` tags
//     (the app's Tabler icon convention). One or more icons, nothing else.
//   - It parses the opening tag brace/quote-aware, so `onClick={() => f()}` (the
//     `>` inside `=>`) doesn't truncate attribute parsing.
//   - An accessible name = `aria-label`/`aria-labelledby`/`title` on the button
//     (literal OR `{expr}`), or an `sr-only` class anywhere in the children.
//
// WHAT IT CANNOT SEE (accepted blind spots — these are NOT icon-only, so they're
// out of scope, not missed offenders):
//   - A button with ANY text child, including text from a `{ternary}` such as
//     `<IconRefresh/> {pending ? "Syncing…" : "Sync now"}` — that HAS a visible
//     name, so it's correctly skipped. (The issue's original audit over-counted
//     exactly these expression-labeled buttons as "unnamed"; on inspection all
//     nine already render visible text, so none needed an aria-label — a
//     redundant one would even fight WCAG 2.5.3 "Label in Name" and freeze the
//     live pending label. The durable fix is this guard, not label churn.)
//   - A button whose only child is a non-Icon component (`<Avatar/>`, a spinner
//     `<svg>`), or an icon rendered via a variable (`<Icon .../>` where `Icon` is
//     a prop) — skipped to stay false-positive-free.
//   - Clickable non-<button> elements (`<a>`, `role="button"` divs).
//
// Justified exceptions go in ALLOWLIST with a reason; there are none today.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components"];

// `rel:line` locations exempted with a justification. Empty by design.
const ALLOWLIST = new Set<string>([]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      files.push({
        rel: path.relative(REPO, full),
        text: fs.readFileSync(full, "utf8"),
      });
    }
  }
  return files;
}

// Index of the `>` closing a JSX opening tag that starts at `start` ('<'),
// aware of quotes and {…} nesting so `onClick={() => f()}` doesn't end the tag
// at the `>` in `=>`.
function findTagEnd(src: string, start: number): number {
  let i = start;
  let brace = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== "\\") quote = null;
    } else if (c === "'" || c === '"' || c === "`") {
      quote = c;
    } else if (c === "{") brace++;
    else if (c === "}") brace--;
    else if (c === ">" && brace === 0) return i;
    i++;
  }
  return -1;
}

function hasIcon(children: string): boolean {
  return /<Icon[A-Za-z0-9]*\b/.test(children);
}

// True when the children reduce to only self-closing <Icon*/> tags + whitespace
// (after removing JSX comments). Any residue — text, an `{expr}`, a non-Icon or
// non-self-closing tag — returns false (conservative: assume it may carry a name).
function isIconOnly(children: string): boolean {
  let c = children.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  for (;;) {
    const m = /<Icon[A-Za-z0-9]*\b/.exec(c);
    if (!m) break;
    const end = findTagEnd(c, m.index);
    if (end === -1 || c[end - 1] !== "/") return false; // not self-closing → bail
    c = c.slice(0, m.index) + c.slice(end + 1);
  }
  return c.trim().length === 0;
}

function hasAccessibleName(attrs: string, children: string): boolean {
  if (/\baria-label\b/.test(attrs)) return true;
  if (/\baria-labelledby\b/.test(attrs)) return true;
  if (/\btitle\s*=/.test(attrs)) return true;
  if (/\bsr-only\b/.test(children)) return true;
  return false;
}

interface Found {
  loc: string;
  named: boolean;
}

function findButtons(rel: string, src: string): Found[] {
  const out: Found[] = [];
  let i = 0;
  while ((i = src.indexOf("<button", i)) !== -1) {
    const after = src[i + 7];
    if (!/[\s>/]/.test(after)) {
      i += 7;
      continue;
    }
    const tagEnd = findTagEnd(src, i);
    if (tagEnd === -1) {
      i += 7;
      continue;
    }
    const attrs = src.slice(i + 7, tagEnd);
    const selfClosing = src[tagEnd - 1] === "/";
    let children = "";
    if (!selfClosing) {
      const close = src.indexOf("</button>", tagEnd);
      children = close === -1 ? "" : src.slice(tagEnd + 1, close);
    }
    if (hasIcon(children) && isIconOnly(children)) {
      const line = src.slice(0, i).split("\n").length;
      out.push({
        loc: `${rel}:${line}`,
        named: hasAccessibleName(attrs, children),
      });
    }
    i = tagEnd + 1;
  }
  return out;
}

describe("icon-only button a11y guard (issue #794 cluster 7a)", () => {
  it("every icon-only <button> has an accessible name", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      for (const { loc, named } of findButtons(rel, text)) {
        if (!named && !ALLOWLIST.has(loc)) offenders.push(loc);
      }
    }
    expect(
      offenders,
      "Icon-only <button>s must carry an accessible name — add an " +
        "aria-label (or title/aria-labelledby), or a visually-hidden " +
        '`<span className="sr-only">…</span>` label. Offenders:\n' +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("the heuristic actually finds the app's labeled icon-only buttons", () => {
    // Sanity floor: if this drops to ~0 the parser silently broke (e.g. a regex
    // change stopped matching <button>), which would make the guard above vacuous.
    let iconOnly = 0;
    for (const { rel, text } of sourceFiles())
      iconOnly += findButtons(rel, text).length;
    expect(iconOnly).toBeGreaterThan(30);
  });
});
