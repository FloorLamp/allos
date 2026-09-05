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
// THROUGH `curl`, NOT `fetch`. Node's fetch ignores HTTP(S)_PROXY and the
// managed environments route GitHub through an agent proxy, which answers it
// 403 while curl to the identical URL gets 200 — merge-gate.mjs and
// ci-watch.mjs both say so and this script did not. It therefore returned
// exit 2, "could not judge", on EVERY invocation here: safe in direction, and
// it meant the re-run exemption this script exists to grant was unavailable
// the whole time. A tool that cannot read fails closed and looks like a tool
// with nothing to say.
//
// Usage:
//   node scripts/orchestration/landing-independence.mjs <pr-number> [--repo owner/name]
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

// merge-gate.mjs's argument shape, kept local: extracting one shared reader is
// #5022's job, and a second copy of five curl flags is cheaper here than a new
// shared surface this change would have to design.
function readPr() {
  const out = execFileSync(
    "curl",
    [
      "-sS",
      "-w",
      "\n%{http_code}",
      "-H",
      "Accept: application/vnd.github+json",
      `https://api.github.com/repos/${repo}/pulls/${pr}`,
    ],
    { encoding: "utf8", timeout: 30_000 }
  );
  const cut = out.lastIndexOf("\n");
  const status = Number(out.slice(cut + 1));
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
  return JSON.parse(out.slice(0, cut));
}

let head;
try {
  const data = readPr();
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
