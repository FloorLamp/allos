// Dependabot major-bump evaluation brief (plain Node, no deps).
//
// The policy this encodes (owner, 2026-08-13): PARKED IS NOT A RESTING STATE
// for a dependency bump. Minor/patch groups merge on green against current
// main, same day, no evaluation needed. A MAJOR gets an evaluation agent
// within a day of arrival, and its deliverable is a RECOMMENDATION with a
// verdict that CLOSES ITS OWN LOOP (owner, same day): `recommend-hold` pairs
// with `parked` and the revisit trigger lives in the eval comment;
// `recommend-adopt` means the orchestrator reviews and merges it like any
// green PR. Neither needs a human — `needs-human` + assignment is reserved
// for an eval that cannot reach a verdict, stated as the specific question.
// The rule exists because the alternative was measured: a TypeScript 5.9→7.0
// major sat `parked` for 35 days with no evaluation at all —
// parked-without-a-recommendation is a decision deferred to nobody.
//
// Usage:
//   node scripts/orchestration/dependabot-eval-brief.mjs <pr-number>
//
// Prints the evaluation brief to stdout — paste it verbatim as the eval
// agent's prompt. Exits 2 when it cannot know (missing token, PR not found,
// not a dependabot PR); it never guesses a brief.

import { execFileSync } from "node:child_process";

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const prNumber = process.argv[2];
function fail(what) {
  console.error(`dependabot-eval-brief: ${what}`);
  process.exit(2);
}
if (!prNumber || !/^\d+$/.test(prNumber)) {
  fail("usage: dependabot-eval-brief.mjs <pr-number>");
}
if (!token) {
  fail('GH_TOKEN/GITHUB_TOKEN missing — re-mint via add_repo access:"push".');
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

console.log(`You are the DEPENDENCY EVALUATOR for FloorLamp/allos PR #${prNumber}:
${pr.title}. Your deliverable is a RECOMMENDATION the owner can act on in one
read — not a merge (the owner decides majors) and not a summary of the
changelog. Majors sit unevaluated forever without this; your report is what
un-parks them.

EVALUATE ${pkg} ${from} -> ${to}:

1. What changed upstream. Dependabot's PR body carries the release notes —
   read them ALL, plus the package's migration guide for the major if one
   exists. List every BREAKING change, not the highlights.
2. What this repo actually touches. Grep the codebase for the package's
   imports and every API the breaking list names. A breaking change in an API
   this repo never calls is noise; say so explicitly rather than hedging.
3. Prove it, don't predict it. Fresh worktree at the PR's merge ref
   (git fetch origin pull/${prNumber}/merge && git worktree add $SCRATCH/wt-depeval-${prNumber} FETCH_HEAD),
   hardlink node_modules from the canonical tree, then npm install so the lock
   matches the bump, then run the gates that can SEE this package break:
   lint + typecheck ALWAYS; the pure tier; the DB tier and \`npm run build\`
   when the package is runtime-load-bearing. Report verbatim results — a
   failure IS evidence, not a reason to stop evaluating (diagnose whether it
   is the bump or pre-existing).
4. Cost of holding. Majors age badly: note whether ${from} still receives
   security fixes, and what compounds if this waits (peer-dep pressure, a
   growing diff of deprecations).

THEN DELIVER, in this order:
- POST the recommendation as a comment on PR #${prNumber} (REST:
  POST /repos/FloorLamp/allos/issues/${prNumber}/comments). Structure: verdict
  first (ADOPT or HOLD, one sentence of why); breaking changes vs this repo's
  actual usage; verbatim gate results; if HOLD — the specific blocker and the
  revisit trigger (an upstream fix, a repo change, a date). End the comment
  with the Claude Code attribution footer.
- Apply the labels (REST: POST /repos/FloorLamp/allos/issues/${prNumber}/labels):
  \`recommend-adopt\`, or \`recommend-hold\` plus \`parked\`. NOT
  \`needs-human\` and no assignment — a verdict closes its own loop (hold
  parks with its revisit trigger in the comment; adopt means the orchestrator
  merges it). Only if you genuinely CANNOT reach a verdict: state the specific
  question in the comment, apply \`needs-human\`, and assign the owner (REST:
  POST /repos/FloorLamp/allos/issues/${prNumber}/assignees,
  {"assignees":["FloorLamp"]}).
- Return to the orchestrator: the verdict, the one-line reason, and anything
  that surprised you.

Do NOT merge, close, or push to the PR yourself. On ADOPT the merge is the
ORCHESTRATOR's, through its normal review-and-merge flow — your comment is the
evidence it reads first.`);
