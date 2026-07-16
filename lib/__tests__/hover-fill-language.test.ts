import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static guard for the hover-FILL language (issue #794 cluster 10a). The app's
// de-facto rule is a two-property split (documented in globals.css near the
// primitives): grey structural BORDERS use the alpha pair (border-black/10 ·
// dark:border-white/10 — guarded by border-alpha-language.test.ts), but hover
// FILLS use LITERAL slate/ink — `hover:bg-slate-100` in light,
// `dark:hover:bg-ink-750`/`ink-800` in dark. A handful of alpha stragglers
// (`hover:bg-black/5`, `hover:bg-white/10`) spoke the border vocabulary for a fill
// job and were swept to the literal form. This test reads the repo's own source as
// TEXT (no DB, no network, so it stays "pure" in the vitest sense) and fails the
// build if an alpha hover-fill reappears. It is ZERO-ALLOWLIST — a hover fill is
// always literal slate/ink.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components", "lib"];
const EXT = [".ts", ".tsx"];

// An alpha hover-fill straggler: a hover/state prefix ending in the subtle grey
// fill `bg-black/5` (light darken) or `bg-white/10` (dark lighten) — the exact
// pair that duplicates the literal grey hover. Scoped to those two opacities on
// purpose: a stronger translucent affordance like `group-hover:bg-white/70` over a
// COLORED card (timeline category chevron) is a deliberate frosted pill, not the
// grey-hover straggler, and a non-hover `bg-black/50` scrim is a different thing.
const ALPHA_HOVER_FILL =
  /(?:hover|group-hover|focus|active):bg-(?:black\/5|white\/10)(?![\d/])/;

function isExcluded(rel: string): boolean {
  return (
    rel.includes("__tests__") ||
    rel.includes("__db_tests__") ||
    rel.includes("__action_tests__") ||
    rel.endsWith(".test.ts") ||
    rel.endsWith(".test.tsx")
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (EXT.some((e) => entry.name.endsWith(e))) {
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
      if (isExcluded(rel)) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

describe("hover-fill language guard (issue #794 cluster 10a)", () => {
  it("no component uses an alpha hover fill (hover:bg-black/5 · hover:bg-white/10)", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      text.split("\n").forEach((line, i) => {
        if (ALPHA_HOVER_FILL.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `Hover fills use LITERAL slate/ink, not the alpha border vocabulary. Swap ` +
        `hover:bg-black/5 → hover:bg-slate-100 and dark:hover:bg-white/10 → ` +
        `dark:hover:bg-ink-800 (or ink-750):\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the border/fill property rule is documented in globals.css", () => {
    const css = fs.readFileSync(path.join(REPO, "app/globals.css"), "utf8");
    expect(css).toMatch(/STRUCTURAL BORDERS use the alpha pair/);
    expect(css).toMatch(/hover FILLS use LITERAL slate\/ink/);
  });
});
