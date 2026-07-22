import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static guard for the ONE grey-border language (issue #794 cluster 9a). Grey
// STRUCTURAL borders — dividers, box/card frames, toggle-container outlines, the
// default grey outline of a button — speak ONE vocabulary: the alpha pair
// `border-black/10` + `dark:border-white/10` (structural), or `border-black/5` +
// `dark:border-white/5` (a subtle divider), matching the .card / .input /
// .btn-ghost primitives in globals.css. The app also carried a SECOND vocabulary —
// literal `border-slate-100` / `border-slate-200` — for the same structural job;
// those ~46 dividers/frames were swept to the alpha pair (slate-200 → /10, the
// subtler slate-100 → /5). This test reads the repo's own TSX as TEXT (no DB, no
// network, so it stays "pure" in the vitest sense) and fails the build if a new
// literal-slate STRUCTURAL border reappears.
//
// It does NOT touch tinted borders (amber/rose/emerald, the Notice family),
// focus/selected `border-brand-*` borders, or `.input` borders — those are their
// own token set. It looks ONLY at `border-slate-{100,200}`. The genuine survivors
// are the handful of NEUTRAL members of a semantic tone set (a grey chip/card whose
// SIBLING branch is a tinted tone), where a slate border is the tone, not chrome —
// converting it to alpha would clash with its tinted siblings. Those files are
// allowlisted with justification + a staleness check.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components"];

// Files permitted to keep a literal border-slate-{100,200}, with justification.
const ALLOWLIST = new Map<string, string>([
  [
    "components/Notice.tsx",
    "NOTICE_TONE 'slate' tone — the Notice primitive's tone map (tinted-tone family)",
  ],
  [
    "app/(app)/trends/TrendingDigest.tsx",
    "neutral trend-chip tone — sibling to the rose/emerald tinted tones in the same tone map",
  ],
  [
    "app/(app)/results/TrajectoryFindings.tsx",
    "'info' finding tone — sibling to the amber 'warning' tone in the same ternary (moved from Trends → Biomarkers to Results, #1164)",
  ],
  [
    "components/FindingsList.tsx",
    "'info' finding tone — sibling to the amber 'warning' tone in the same ternary",
  ],
  [
    "components/CoverageGaps.tsx",
    "uncovered-gap status border — sibling to the emerald-tinted 'covered' branch (line 215; the structural row frame on line 132 was swept)",
  ],
]);

// A literal slate structural border: border-slate-100 / -200, optionally a side
// variant (border-t/-b/-l/-r/-x/-y). Excludes -300+ (out of the sweep's scope).
const SLATE_BORDER = /\bborder(?:-[xytblr])?-slate-(?:100|200)\b/;

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
        rel: path.relative(REPO, full).split(path.sep).join("/"),
        text: fs.readFileSync(full, "utf8"),
      });
    }
  }
  return files;
}

describe("border alpha-language guard (issue #794 cluster 9a)", () => {
  it("no component uses a literal border-slate-{100,200} for a structural border", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (ALLOWLIST.has(rel)) continue;
      text.split("\n").forEach((line, i) => {
        if (SLATE_BORDER.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `Use the alpha border pair (border-black/10 + dark:border-white/10, or /5 ` +
        `for a subtle divider) instead of a literal border-slate-{100,200}. A ` +
        `NEUTRAL member of a semantic tone set (grey sibling of a tinted tone) ` +
        `gets an ALLOWLIST entry with justification:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("every allowlisted file still exists and still carries the signature (no stale entries)", () => {
    const stale: string[] = [];
    for (const rel of ALLOWLIST.keys()) {
      const abs = path.join(REPO, rel);
      if (!fs.existsSync(abs)) {
        stale.push(rel);
        continue;
      }
      const text = fs.readFileSync(abs, "utf8");
      if (!text.split("\n").some((line) => SLATE_BORDER.test(line)))
        stale.push(rel);
    }
    expect(
      stale,
      `These ALLOWLIST entries no longer carry a literal border-slate-{100,200} ` +
        `and should be removed from the allowlist:\n${stale.join("\n")}`
    ).toEqual([]);
  });
});
