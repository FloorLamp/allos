// Advise whether a PR's changed paths overlap changes since its checked base.
// Path independence is not a semantic proof; docs/orchestration/review-merge.md
// owns merged-tree verification and merge requirements.
//
// Usage:
//   node scripts/orchestration/landing-independence.mjs <pr-number> [--repo owner/name]
//
// Reads the PR through REST/curl and fetches main and the head for comparison.
// Exit codes: 0 independent (or nothing landed), 1 not independent,
// 2 could not judge. Never treat an unreadable PR or failed fetch as independent.

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
