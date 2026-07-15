import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static contrast guard for the muted secondary-text pairing (issue #794, cluster
// 8a). The app's ubiquitous "quiet" text pattern used to be
// `text-slate-400 dark:text-slate-500` — but that pairing fails WCAG in BOTH
// modes, and the fix was simply to swap it:
//
//   slate-400 on white   = 2.56:1  (fails even AA-large 3:1)   <- old light base
//   slate-500 on ink-950 = 4.18:1  (fails AA 4.5:1)            <- old dark  base
//   slate-500 on white   = 4.76:1  (passes AA)                 <- new light base
//   slate-400 on ink-950 = 7.75:1  (passes AAA)                <- new dark  base
//
// The correct, passing pairing is `text-slate-500 dark:text-slate-400`. This test
// reads the repo's own UI source as TEXT (no DB, no network, so it stays "pure" in
// the vitest sense) and fails the build if the failing BASE-text pairing reappears
// in either token ordering. It is deliberately ZERO-ALLOWLIST: there is no correct
// place for base muted text at 2.56:1 / 4.18:1.
//
// It matches the BASE text color pair only — a modifier-prefixed token
// (`placeholder:`/`disabled:`/`hover:text-slate-400`, `dark:disabled:text-slate-500`,
// …) is a different-purpose color and is NOT flagged (WCAG exempts disabled/inactive
// UI, and placeholder/hover are their own affordances). Border/bg/fill/stroke slates
// are untouched because this only looks at `text-slate-*` tokens.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Directories that render UI. lib is included because color class strings live in
// shared constants there too (e.g. lib/strength-standards.ts level colors).
const SCAN_DIRS = ["app", "components", "lib"];

const EXT = [".ts", ".tsx", ".css"];

// The failing BASE pairing, in both orderings. The `(?<!:)` before the base token
// pins it to the base text color (not a `placeholder:`/`disabled:`/`hover:` prefixed
// variant); the literal `dark:text-slate-500` likewise can't match
// `dark:disabled:text-slate-500`. Intervening utility classes are allowed.
const FAILING_PATTERNS = [
  /(?<![\w:-])text-slate-400(?:\s+[^\s"'`]+)*\s+dark:text-slate-500(?![\w-])/,
  /dark:text-slate-500(?:\s+[^\s"'`]+)*\s+(?<![\w:-])text-slate-400(?![\w-])/,
];

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
      const rel = path.relative(REPO, full);
      if (isExcluded(rel)) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

describe("muted secondary-text contrast (issue #794)", () => {
  it("the WCAG-failing base pairing text-slate-400 dark:text-slate-500 appears nowhere", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (FAILING_PATTERNS.some((re) => re.test(line))) {
          offenders.push(`${rel}:${i + 1}`);
        }
      });
    }
    expect(
      offenders,
      `Found the WCAG-failing muted-text pairing (slate-400 on white = 2.56:1, ` +
        `slate-500 on ink-950 = 4.18:1). Swap to the passing pairing ` +
        `text-slate-500 dark:text-slate-400:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});
