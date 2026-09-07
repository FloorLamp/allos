// Dependabot major-bump evaluation brief (plain Node, no deps).
// Usage: node scripts/orchestration/dependabot-eval-brief.mjs <pr-number>
// Prints a recommendation brief. Exit 2 means unreadable or non-Dependabot PR.
// Evaluate majors within a day. HOLD requires a blocker and revisit trigger;
// ADOPT returns to the orchestrator's normal review/merge flow.

import { execFileSync } from "node:child_process";
import { helpGuard } from "./usage.mjs";
import { resolveReadToken } from "./host.mjs";
helpGuard(process.argv, import.meta.url);

const token = resolveReadToken();
const prNumber = process.argv[2];
function fail(what) {
  console.error(`dependabot-eval-brief: ${what}`);
  process.exit(2);
}
if (!prNumber || !/^\d+$/.test(prNumber)) {
  fail("usage: dependabot-eval-brief.mjs <pr-number>");
}
if (!token) {
  fail(
    'no GH_TOKEN/GITHUB_TOKEN and no authenticated gh — re-mint via add_repo access:"push".'
  );
}

function gh(pathname) {
  let out;
  try {
    out = execFileSync(
      "curl",
      [
        "-sS",
        "-H",
        `Authorization: Bearer ${token}`,
        "-H",
        "Accept: application/vnd.github+json",
        `https://api.github.com/repos/FloorLamp/allos/${pathname}`,
      ],
      { encoding: "utf8", timeout: 30_000 }
    );
  } catch (err) {
    fail(`GET ${pathname} failed (${err.message})`);
  }
  try {
    return JSON.parse(out);
  } catch {
    fail(`GET ${pathname} returned a non-JSON body`);
  }
}

const pr = gh(`pulls/${prNumber}`);
if (!pr || typeof pr.number !== "number") {
  fail(`PR #${prNumber} did not resolve (${pr?.message ?? "no number"})`);
}
if (pr.user?.login !== "dependabot[bot]") {
  fail(
    `PR #${prNumber} is by ${pr.user?.login}, not dependabot[bot] — this brief is for dependency bumps.`
  );
}
// "Bump <pkg> from <a> to <b>" — dependabot's stable title shape.
const m = /^Bump (\S+) from (\S+) to (\S+)/.exec(pr.title);
const pkg = m?.[1] ?? "(parse the package from the PR title)";
const from = m?.[2] ?? "?";
const to = m?.[3] ?? "?";

console.log(`Evaluate FloorLamp/allos dependency PR #${prNumber}: ${pr.title}.
Package: ${pkg} ${from} -> ${to}.
Follow AGENTS.md and docs/change-policy.md. Return an ADOPT or HOLD
recommendation; keep the report focused on this repo's compatibility.

EVALUATE
1. Read the PR's release notes and upstream migration guide. Check every breaking
   change against actual imports and API use; group irrelevant changes briefly.
2. Use a fresh worktree at the merge ref:
   git fetch origin pull/${prNumber}/merge && git worktree add $SCRATCH/wt-depeval-${prNumber} FETCH_HEAD
   Install from its lockfile with npm ci, using an independent node_modules tree.
   Run lint, typecheck, and unit tests; add DB tests and build when the package
   affects runtime behavior. Diagnose failures as bump-related or pre-existing.
   Record exact commands and outcomes; include failure output needed to explain them.
3. Assess the cost of holding: security support for ${from}, peer dependencies,
   and migration work that grows with delay. Do not implement a migration or
   create tests merely to produce an evaluation.

DELIVER
- Post a concise PR comment through REST:
  POST /repos/FloorLamp/allos/issues/${prNumber}/comments
  Include verdict and reason, relevant breaking changes versus usage, gate results,
  and, for HOLD, the blocker and a concrete revisit trigger. End with the
  Claude Code attribution footer.
- Label ADOPT with recommend-adopt; label HOLD with recommend-hold and parked
  (POST /repos/FloorLamp/allos/issues/${prNumber}/labels).
  A completed verdict needs no human assignment. Only when unable to decide,
  state the specific unresolved question, apply needs-human, and assign FloorLamp
  (POST /repos/FloorLamp/allos/issues/${prNumber}/assignees).
- Return verdict, one-line reason, and material surprises to the orchestrator.

Do not push, close, or merge the PR. The orchestrator owns adoption through
its normal review-and-merge flow.`);
