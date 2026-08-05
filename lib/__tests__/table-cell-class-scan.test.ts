import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static guard for the shared table cell classes (issue #1491, guard 12a).
//
// globals.css defines ONE header/cell typography for data tables — `.th`
// (uppercase micro-header, matching .section-label) and `.td` (the standard
// cell padding + text) — but the audit found 12+ files hand-rolling their own
// header/cell strings, including one that re-declared `.td`'s exact CSS inline.
// Two cell vocabularies drift apart silently: paddings diverge, dark-mode
// colors diverge, and a phone's tighter `px-2` never reaches the hand-rolls.
//
// This test reads the repo's TSX as TEXT (no DB, no browser — "pure" in the
// vitest sense) and fails any `<th>`/`<td>` whose className does not carry the
// shared `th`/`td` token. A table with a DELIBERATE different cell treatment
// (a sticky matrix, an input grid that only borrows table layout) is declared
// below with its reason — an allowlist entry, not silent drift.
//
// The scan strips comments first, then parses each JSX opening tag with a tiny
// brace/quote-aware walker so `=>` inside an attribute expression doesn't end
// the tag early. `className` is matched as a string/template literal; the
// token must appear as a standalone word (the `td ${className}` template in
// components/ResponsiveTable.tsx counts, `td-like` would not).

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components"];

// Files allowed to style `<th>`/`<td>` without the shared tokens, each with the
// reason the shared cell vocabulary deliberately does not apply. Everything
// else must use `.th`/`.td` (directly or via `Td` / `SortableHeader`).
const ALLOWLIST = new Map<string, string>([
  [
    "app/(app)/immunizations/ScheduleGrid.tsx",
    "sticky-left dose matrix (#1491 item 13 non-goal): cells are compact grid " +
      "coordinates with their own sticky/border treatment, not record cells",
  ],
  [
    "app/(app)/records/specialty/hearing/AudiogramForm.tsx",
    "threshold INPUT grid — a form that borrows table layout for its " +
      "frequency axes; cells hold inputs, not styled data",
  ],
  [
    "app/(app)/records/specialty/hearing/AudiogramList.tsx",
    "audiogram threshold matrix: compact numeric grid keyed by frequency, " +
      "same deliberate treatment as its input-grid twin AudiogramForm",
  ],
  [
    "components/illness/EpisodeTimeline.tsx",
    "pre-#1426 hand-rolled card mode: its mobile grid re-lays cells with its " +
      "own paddings and print/mobile group-collapse rules; migrating it onto " +
      "ResponsiveTable is #1491 item 2 (deferred there, not silent drift)",
  ],
]);

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
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (rel.includes("__tests__")) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

// Blank out `//`, `/* */`, and JSX `{/* */}` comments, preserving offsets so
// reported line numbers stay real. Good enough for a scan: string literals
// containing `//` (URLs) survive because we only blank `//` outside strings.
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// The opening tag's text starting at `start` (the `<`), ended by the first `>`
// outside braces and string literals — so `onClick={() => …}` doesn't cut it.
function tagText(text: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length && i < start + 2000; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start, start + 2000);
}

// The full source text of the tag's className value — a plain string literal,
// or the balanced `{…}` expression (template literals with nested `${…}`
// included). Token matching runs over this raw text, so a token contributed by
// any literal part of the expression counts.
function classNameText(tag: string): string | null {
  const at = tag.search(/className=/);
  if (at === -1) return null;
  const rest = tag.slice(at + "className=".length);
  if (rest[0] === '"' || rest[0] === "'") {
    const end = rest.indexOf(rest[0], 1);
    return end === -1 ? rest : rest.slice(1, end);
  }
  if (rest[0] !== "{") return null;
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "{") depth++;
    else if (rest[i] === "}") {
      depth--;
      if (depth === 0) return rest.slice(1, i);
    }
  }
  return rest;
}

function hasToken(cls: string, token: string): boolean {
  return new RegExp(`(?:^|[\\s\`$}'"])${token}(?:[\\s\`$'"{]|$)`).test(cls);
}

function fileOffenses(text: string): string[] {
  const stripped = stripComments(text);
  const out: string[] = [];
  const re = /<(th|td)(?=[\s/>])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const tag = tagText(stripped, m.index);
    const cls = classNameText(tag);
    if (cls == null || !hasToken(cls, m[1])) {
      const line = stripped.slice(0, m.index).split("\n").length;
      out.push(`<${m[1]}> at line ${line}`);
    }
  }
  return out;
}

describe("shared table cell classes (.th/.td) — issue #1491 guard 12a", () => {
  it("every <th>/<td> carries the shared th/td token (or its file declares why not)", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (ALLOWLIST.has(rel)) continue;
      for (const off of fileOffenses(text)) offenders.push(`${rel}: ${off}`);
    }
    expect(
      offenders,
      `These table cells hand-roll their header/cell styling instead of the ` +
        `shared .th/.td classes (or <Td> from components/ResponsiveTable). ` +
        `Use the shared classes, or — for a deliberately different grid — add ` +
        `an ALLOWLIST entry here with the reason:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("every allowlist entry still names a file with a non-token cell (no stale exemptions)", () => {
    for (const [rel, reason] of ALLOWLIST) {
      const abs = path.join(REPO, rel);
      expect(
        fs.existsSync(abs),
        `${rel} allowlisted (${reason}) but missing`
      ).toBe(true);
      expect(
        fileOffenses(fs.readFileSync(abs, "utf8")).length,
        `${rel} is allowlisted but every cell now uses the shared tokens — ` +
          `remove its entry`
      ).toBeGreaterThan(0);
    }
  });

  it("the .th/.td primitives are defined in globals.css", () => {
    const css = fs.readFileSync(path.join(REPO, "app/globals.css"), "utf8");
    expect(css).toMatch(/\.th\s*\{/);
    expect(css).toMatch(/\.td\s*\{/);
  });
});
