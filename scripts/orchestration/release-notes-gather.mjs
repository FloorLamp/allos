// Gather release-note candidates from merged paths; the PM curates the result.
// Format and cadence: docs/orchestration/dispatch.md §Release notes.
//
// Usage:
//   node scripts/orchestration/release-notes-gather.mjs [--since YYYY-MM-DD]
//   node scripts/orchestration/release-notes-gather.mjs --check
//
// Default window starts on the newest release-note day, inclusive. Print that
// day's existing titles for overlap review. --check reports uncovered candidates
// and exits 0 on success even when notes are due. Read fetch/history caveats;
// merge-window.mjs owns path classification and clipped-history detection.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { helpGuard } from "./usage.mjs";
import { mergeWindow } from "./merge-window.mjs";
helpGuard(process.argv, import.meta.url);

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

const args = process.argv.slice(2);
const check = args.includes("--check");
const sinceFlag = args.indexOf("--since");
const notes = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "lib/release-notes.json"), "utf8")
);
const newestDay = notes.days?.[0];
const since = sinceFlag !== -1 ? args[sinceFlag + 1] : newestDay?.date;
if (!/^\d{4}-\d{2}-\d{2}$/.test(since ?? "")) {
  console.error(
    "could not determine a since-date — pass --since YYYY-MM-DD (lib/release-notes.json has no days?)"
  );
  process.exit(2);
}

try {
  execFileSync("git", ["-C", repoRoot, "fetch", "-q", "origin", "main"], {
    stdio: "ignore",
  });
} catch {
  console.error("  (git fetch failed — the window may be stale)");
}
const { merges, floor } = mergeWindow(repoRoot, since);
const merged = merges.filter((m) => m.pr).reverse();
const candidates = merged.filter((m) => m.userVisible);

/** The sentence every count below is a floor of. Empty when history reached back. */
const boundary = floor
  ? ` — FLOOR, not a total: this checkout's history begins at ${floor}, so` +
    ` nothing merged between ${since} and that instant was read`
  : "";

if (check) {
  // Covered = named by ANY day's entries — a same-day batch that already
  // shipped must not re-flag its own PRs.
  const covered = new Set(
    (notes.days ?? []).flatMap((d) => d.entries.map((e) => e.pr))
  );
  const uncovered = candidates.filter((m) => !covered.has(Number(m.pr)));
  console.log(
    uncovered.length
      ? `release notes: ${uncovered.length} user-visible merge(s) ` +
          `uncovered since ${since} (#${uncovered.map((m) => m.pr).join(", #")}) ` +
          `— batch them (docs/orchestration/dispatch.md, Release notes)${boundary}`
      : // "current through" is the one claim a clipped read must never make: it
        // is read as the lag being closed, and the unread part of the window is
        // where the lag lives.
        `release notes: ${floor ? `nothing uncovered in what was read${boundary}` : `current through ${since}`}`
  );
  process.exit(0);
}

console.log(
  `${merged.length} PRs merged to main since ${since} (inclusive) — ` +
    `${candidates.length} release-note candidates, ${merged.length - candidates.length} internal by the paths they touched.${boundary}\n`
);
let day = "";
for (const m of merged) {
  if (m.day !== day) {
    day = m.day;
    console.log(`### ${day}`);
  }
  console.log(`  #${m.pr}  ${m.subject}${m.userVisible ? "" : "  [internal]"}`);
}
if (newestDay && since === newestDay.date) {
  console.log(
    `\nOverlap check — ${newestDay.date} already has ${newestDay.entries.length} entries:`
  );
  for (const e of newestDay.entries) console.log(`  covered: ${e.title}`);
}
console.log(
  `\nCuration stays yours — the rules are in docs/orchestration/dispatch.md,
Release notes, and are not restated here. [internal] is what the merge's own
paths say; overrule it in either direction.`
);
