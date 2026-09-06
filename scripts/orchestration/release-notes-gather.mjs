// Release-notes gathering (plain Node, no deps). The CURATION is prose and
// stays human; the GATHERING — which merges since the newest entry are
// user-visible — is bookkeeping.
//
// Usage:
//   node scripts/orchestration/release-notes-gather.mjs [--since YYYY-MM-DD]
//   node scripts/orchestration/release-notes-gather.mjs --check
//
// --check prints ONE line — how many user-visible merges the notes have not
// covered — and always exits 0. The batch used to fall behind silently (#4077
// caught four uncovered merges by hand), and a lag nobody is shown is a lag
// nobody closes.
//
// Default --since is the newest day in lib/release-notes.json, INCLUSIVE —
// same-day merges after that batch shipped would otherwise be dropped, so the
// output also prints that day's existing entry titles for an overlap check by
// eye.
//
// Which merges are user-visible is merge-window.mjs's answer, from the PATHS a
// merge touched — the same enumeration and the same verdict pm-digest.sh ranks
// its product merges by. This script used to guess it a second time from the
// TITLE; the header said so, and the guess was wrong on 19 of 63 merges.

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
