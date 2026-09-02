// Does this PR need its CI re-run before it can merge? (plain Node, no deps)
//
// Merges are serial; PRs are not. Every merge stales the CI of every other
// open PR, and re-running each one serialises the day at ~16 minutes a merge.
// The runbook's escape has always been "write down why the two file sets
// cannot interact"; this script writes it down. Exit 0 means the candidate's
// changed paths are disjoint from everything that landed on main since its CI
// base, and neither side touched a shared file (landing-independence-core.mjs
// lists them) — merge on the checks it has. Exit 1 means rebase and re-run.
//
// Reads: unauthenticated REST for the PR head (environment.md §GitHub access)
// and git against origin — it fetches main and the head itself.
//
// Usage:
//   node scripts/work/landing-independence.mjs <pr-number> [--repo owner/name]
//
// Exit codes: 0 independent (or nothing landed) · 1 not independent ·
//   2 could not judge (PR unreadable, fetch failed).

import { execFileSync } from "node:child_process";
import { helpGuard } from "./usage.mjs";
import {
  judgeIndependence,
  independenceNotice,
} from "./landing-independence-core.mjs";

helpGuard(process.argv, import.meta.url);

const args = process.argv.slice(2);
const pr = args.find((a) => /^\d+$/.test(a));
const repoIdx = args.indexOf("--repo");
const repo = repoIdx >= 0 ? args[repoIdx + 1] : "FloorLamp/allos";
if (!pr) {
  console.error(
    "usage: landing-independence.mjs <pr-number> [--repo owner/name]"
  );
  process.exit(2);
}

const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const lines = (s) => s.split("\n").filter(Boolean);

let head;
try {
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  head = data.head.sha;
  if (data.merged_at) {
    console.log(`#${pr} is already merged.`);
    process.exit(0);
  }
} catch (e) {
  console.error(`could not read PR #${pr}: ${e.message}`);
  process.exit(2);
}

try {
  git("fetch", "-q", "origin", "main", head);
} catch (e) {
  console.error(`git fetch failed: ${e.message}`);
  process.exit(2);
}
const base = git("merge-base", "origin/main", head);
const landedCommits = lines(
  git("log", "--format=%h %s", `${base}..origin/main`)
);
const landed = lines(git("diff", "--name-only", base, "origin/main"));
const candidate = lines(git("diff", "--name-only", base, head));
const verdict = judgeIndependence({ candidate, landed });

console.log(
  `#${pr} head ${head.slice(0, 9)} · CI base ${base.slice(0, 9)} · ${landedCommits.length} merge(s) since:`
);
for (const c of landedCommits) console.log(`  ${c}`);
console.log(independenceNotice(pr, verdict, landedCommits.length));
process.exit(landedCommits.length === 0 || verdict.independent ? 0 : 1);
