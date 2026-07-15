import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static guard for the .section-label primitive (issue #794 cluster 1). The
// uppercase micro-heading — the app's ubiquitous "SECTION LABEL" eyebrow — used
// to be hand-rolled ~60 times in 8 typography variants. It now lives once in
// globals.css as `.section-label` (text-xs font-semibold uppercase tracking-wide
// text-slate-500 dark:text-slate-400, matching .th). This test reads the repo's
// own TSX as TEXT (no DB, no network, so it stays "pure" in the vitest sense) and
// fails the build if a component re-hand-rolls the MUTED section label — a
// className pairing `uppercase tracking-wide` with the section-label color
// (text-slate-500/400) — instead of using the primitive.
//
// Scope is deliberately the muted-slate signature, so it needs no allowlist:
//   - pill/badges (bg-* + text-amber/emerald/slate-600) are a different token set,
//   - the dim RPE placeholder (slate-300/600) and brand/accent/rose eyebrows use a
//     color override on top of `.section-label` (or are intentional one-offs),
//   - the bold Emergency Card headers use tracking-widest / font-bold + accents.
// All of those pass; a regrown muted hand-roll — the exact drift #794 removed — is
// caught. A brand/rose/tone section label is written as `section-label
// text-brand-600 dark:text-brand-400` (the utility color trails, and wins over the
// component layer), so it also carries no inline `uppercase tracking-wide`.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components"];

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

// A hand-rolled MUTED section label: `uppercase`, `tracking-wide` as a whole token
// (so `tracking-widest` is excluded), and the section-label color slate-500/400 —
// all within one className string (no line break between them).
const HAND_ROLL =
  /uppercase[^"'`\n]*\btracking-wide\b[^"'`\n]*text-slate-(?:400|500)|text-slate-(?:400|500)[^"'`\n]*uppercase[^"'`\n]*\btracking-wide\b/;

describe("section-label primitive guard (issue #794 cluster 1)", () => {
  it("no component hand-rolls the muted uppercase section label", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      text.split("\n").forEach((line, i) => {
        if (HAND_ROLL.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `Use the .section-label primitive instead of hand-rolling ` +
        `"uppercase tracking-wide text-slate-500 dark:text-slate-400":\n` +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("the .section-label primitive is defined in globals.css", () => {
    const css = fs.readFileSync(path.join(REPO, "app/globals.css"), "utf8");
    expect(css).toMatch(/\.section-label\s*\{/);
    expect(css).toMatch(
      /\.section-label[\s\S]*?text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400/
    );
  });
});
