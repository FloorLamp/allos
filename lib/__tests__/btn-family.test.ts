import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static guard for the .btn button family (issue #794 cluster 2). Action buttons
// used to be hand-rolled with `bg-brand-600 … hover:bg-brand-700` (primaries) and
// `bg-rose-600 … hover:bg-rose-700` (danger) in ~6 inconsistent shapes (rounded-lg
// vs rounded-md, drifting padding/disabled/transition) alongside the shared .btn /
// .btn-danger primitives. They now compose the primitives (+ the .btn-sm size
// modifier for dense contexts). This test reads the repo's own TSX as TEXT (no DB,
// no network, so it stays "pure" in the vitest sense) and fails the build if a
// component re-hand-rolls a primary or danger action button instead of using .btn.
//
// The signature is deliberately narrow — the FILLED button look: a real
// `bg-brand-600`/`bg-rose-600` utility (NOT a `file:`/`dark:`/`hover:`-prefixed
// variant), its matching `hover:bg-brand-700`/`hover:bg-rose-700`, AND horizontal
// padding (`px-`) in the same className. That catches padded rectangular buttons
// while letting the legitimate non-button uses of the color through untouched:
//   - progress/scale fills and status dots (bg-rose-500, no hover/px),
//   - toggle/tab/segmented `? "bg-brand-600 text-white"` fragments (no hover+px),
//   - icon-only round controls sized with h-/w- (no px),
//   - `file:bg-brand-600 … hover:file:bg-brand-700` file-input chrome (prefixed).
// The one intentional pill variant is allowlisted below.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components"];

// Deliberate leaves — true action buttons kept off the .btn family on purpose.
// SavedViewsBar's "Save" is a compact rounded-full pill inside an h-7 inline
// mini-form (next to an h-7 text-xs input); the .btn/.btn-sm rectangle would
// tower over its row. Reviewed under #794 cluster 2 and left as-is.
const ALLOWLIST = new Set(["components/SavedViewsBar.tsx"]);

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

// A real `bg-brand-600`/`bg-rose-600` utility is preceded by a class-string
// boundary (space, quote, backtick) — NOT by `:` (which would make it a
// `file:`/`dark:`/`hover:` variant) or another class char.
const PRIMARY_FILL = /(?<![\w:-])bg-brand-600\b/;
const PRIMARY_HOVER = /hover:bg-brand-700\b/;
const DANGER_FILL = /(?<![\w:-])bg-rose-600\b/;
const DANGER_HOVER = /hover:bg-rose-700\b/;
const HAS_PADDING = /\bpx-/;

function isHandRolledButton(line: string): boolean {
  if (HAS_PADDING.test(line)) {
    if (PRIMARY_FILL.test(line) && PRIMARY_HOVER.test(line)) return true;
    if (DANGER_FILL.test(line) && DANGER_HOVER.test(line)) return true;
  }
  return false;
}

describe("btn family guard (issue #794 cluster 2)", () => {
  it("no component hand-rolls a bg-brand-600/bg-rose-600 action button", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (ALLOWLIST.has(rel)) continue;
      text.split("\n").forEach((line, i) => {
        if (isHandRolledButton(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `Use the .btn / .btn-danger primitives (+ .btn-sm for dense contexts) ` +
        `instead of hand-rolling a filled brand/rose action button:\n` +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("the .btn family + .btn-sm modifier are defined with a focus ring", () => {
    const css = fs.readFileSync(path.join(REPO, "app/globals.css"), "utf8");
    expect(css).toMatch(/\.btn\s*\{/);
    expect(css).toMatch(/\.btn-ghost\s*\{/);
    expect(css).toMatch(/\.btn-danger\s*\{/);
    expect(css).toMatch(/\.btn-sm\s*\{/);
    // 8c: every button in the family carries the shared focus-visible ring.
    for (const cls of [".btn", ".btn-ghost", ".btn-danger"]) {
      const block = css.slice(css.indexOf(cls + " {"));
      const body = block.slice(0, block.indexOf("}"));
      expect(body, `${cls} needs focus-visible:ring-brand-500`).toMatch(
        /focus-visible:ring-2 focus-visible:ring-brand-500/
      );
    }
  });
});
