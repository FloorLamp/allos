import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static guard for the free-text notes convention (issue #794 cluster 11a). The
// app renders user- and import-sourced notes (conditions, encounters, allergies,
// appointments, care plans, biomarker/body-metric rows, …) as multi-line free text
// that can carry long unbroken tokens (a pasted URL). Rendered BARE — a plain
// `{x.notes}` JSX child — CCD/extraction notes flatten to one run-on line and a URL
// overflows a min-w-0 flex/table cell. The fix routes every notes surface through
// <NotesText notes={…} /> (components/NotesText.tsx), which applies
// `whitespace-pre-wrap break-words`.
//
// NotesText takes the note as a PROP precisely so this scan has a reliable
// signature to ban: a `.notes` value rendered as a bare JSX child (`{x.notes}` or
// `{x.notes ?? ""}`). Passing it as a prop (`notes={x.notes}`) or interpolating it
// in a template (`${x.notes}`) is fine — those don't render it directly. This test
// reads the repo's own source as TEXT (no DB, no network, so it stays "pure") and
// fails the build if a new notes surface renders a note bare instead of via
// NotesText.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Directories scanned for rendered notes (React lives here).
const SCAN_DIRS = ["app", "components"];

// A `.notes` (or a dotted path ending in `.notes`) rendered as the direct child of
// a JSX expression container, optionally with a `?? ""` fallback. The leading
// look-behind excludes a prop assignment (`notes={x.notes}` — `{` after `=`) and a
// template interpolation (`${x.notes}` — `{` after `$`), both of which are allowed.
const BARE_NOTES =
  /(?<![=$])\{\s*[A-Za-z_$][\w$.]*\.notes\s*(?:\?\?\s*(['"]).*?\1)?\s*\}/;

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
      if (rel.includes("__tests__") || rel.endsWith(".test.tsx")) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

// Strip line/block comments so prose mentioning `{x.notes}` (e.g. NotesText's own
// doc comment) can't trip the scanner — only real code counts.
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("notes rendering convention (issue #794 cluster 11a)", () => {
  it("no notes surface renders a note bare — all go through <NotesText />", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      const code = stripComments(text);
      const lines = code.split("\n");
      lines.forEach((line, i) => {
        if (BARE_NOTES.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `These render a note as a bare JSX child. Route free-text notes through ` +
        `<NotesText notes={…} /> (components/NotesText.tsx) so they get ` +
        `whitespace-pre-wrap + break-words:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the NotesText component exists and applies the pre-wrap + break treatment", () => {
    const src = fs.readFileSync(
      path.join(REPO, "components/NotesText.tsx"),
      "utf8"
    );
    expect(/export default function NotesText\b/.test(src)).toBe(true);
    expect(src.includes("whitespace-pre-wrap break-words")).toBe(true);
  });
});
