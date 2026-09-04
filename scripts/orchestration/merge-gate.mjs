// Merge gate — the checked-in version of review-merge.md §Merge's exact-head
// invariant (owner 2026-08-26, #3710): merge only a green exact head that a
// non-author reviewed, with zero unresolved findings. Until now that gate was
// a paragraph the orchestrator remembered; this makes it a script it runs.
//
// READ-ONLY by construction: no write verb leaves this script (pinned in
// lib/__tests__/merge-gate-script.test.ts). It answers one question — "may
// this PR merge RIGHT NOW?" — by checking, on the CURRENT head SHA:
//   1. the PR is open and READY (never draft — environment.md §GitHub access),
//      and its TITLE holds the rule the squash subject inherits (#4983):
//      72 characters, one clause, no colon or dash tail;
//   2. the RECEIPT: a review from a NON-AUTHOR whose body states this exact
//      head SHA (8+ hex chars of its prefix). A receipt naming any other SHA
//      is a review of a head that no longer exists — void, not evidence.
//      Where the orchestrator and its lanes share ONE account (#4258), a
//      same-account review passes instead by stating the SHA AND asserting
//      the reviewer did not author the change — with one identity,
//      independence can only ever be a stated claim, so that is what is
//      checked;
//   3. no standing CHANGES_REQUESTED review on this head;
//   4. every check run on the head is completed and green. This is a single
//      sample — settlement (registration still growing) is ci-watch.mjs's
//      job, so run that first; incomplete CI here exits 2, not 0;
//   5. zero unresolved review threads (a GraphQL read; outdated-but-unresolved
//      still counts, because the finding may still apply to the new head).
//      Where this host's proxy refuses GraphQL outright (#4231), zero REST
//      comment threads proves the same thing; any threads fail the gate as
//      resolution-unknown rather than blocking every merge on exit 2.
//
// It also PRINTS, without gating on it, what `e2e-main` says about the base
// branch (#4722): that workflow reports on main, never on a PR head, so main
// stayed red there for eight merges while every PR read green.
//
// Usage:
//   node scripts/orchestration/merge-gate.mjs <pr-number> [--repo owner/name]
//     [--ignore-check <name>]
//
// --ignore-check excludes one check run by name from step 4. It exists for
// the CI wrapper (.github/workflows/merge-gate.yml), whose own job is a
// pending check run on the very head it is evaluating — without excluding
// itself it would read CI as incomplete forever. Interactive runs never need
// it.
//
// Exit codes: 0 gate OPEN — this head may merge · 1 gate CLOSED (every
//   failure listed; fix, re-review, or record the override in the thread) ·
//   2 cannot evaluate (CI incomplete or transient API trouble; NOT a verdict —
//   re-invoke) · 3 blocked (no/bad token: an unauthenticated gate that
//   silently passes reads as safe — the ci-watch lesson).

import { execFileSync } from "node:child_process";
import { helpGuard } from "./usage.mjs";
import { resolveReadToken } from "./host.mjs";
import {
  baseDetectorNotice,
  checkRunsVerdict,
  closedStatusDescription,
  readinessVerdict,
  receiptVerdict,
} from "./merge-gate-core.mjs";
import { titleLength, titleRuleRefusal } from "./title-rule.mjs";
helpGuard(process.argv, import.meta.url);

const token = resolveReadToken();
if (!token) {
  console.error(
    "BLOCKED: no GH_TOKEN/GITHUB_TOKEN and no authenticated gh. Refusing to\n" +
      "evaluate — an unauthenticated gate reports empty review and thread sets,\n" +
      "which reads as 'nothing blocks'. Re-mint the token\n" +
      "(recovery.md §Lost credentials), then re-run."
  );
  process.exit(3);
}

const args = process.argv.slice(2);
const prNumber = args.find((a) => /^\d+$/.test(a));
if (!prNumber) {
  console.error("usage: merge-gate.mjs <pr-number> [--repo owner/name]");
  process.exit(2);
}
const repoFlag = args.indexOf("--repo");
const repo = repoFlag === -1 ? "FloorLamp/allos" : args[repoFlag + 1];
const ignoreFlag = args.indexOf("--ignore-check");
const ignoreCheck = ignoreFlag === -1 ? null : args[ignoreFlag + 1];

// curl, not fetch: node's fetch ignores HTTP(S)_PROXY and the managed
// environments route GitHub through an agent proxy (ci-watch.mjs says why).
function curl(curlArgs) {
  const out = execFileSync(
    "curl",
    ["-sS", "-w", "\n%{http_code}", ...curlArgs],
    {
      encoding: "utf8",
      timeout: 30_000,
    }
  );
  const cut = out.lastIndexOf("\n");
  return { status: Number(out.slice(cut + 1)), body: out.slice(0, cut) };
}

// `soft` is for reads whose failure must not become the gate's verdict: it
// answers null instead of exiting, so an advisory read can go dark on its own.
function gh(pathname, soft = false) {
  for (let attempt = 1; ; attempt++) {
    const { status, body } = curl([
      "-H",
      `Authorization: Bearer ${token}`,
      "-H",
      "Accept: application/vnd.github+json",
      `https://api.github.com/${pathname}`,
    ]);
    if (status === 401) {
      console.error("BLOCKED: 401 — the token exists but is bad/expired.");
      process.exit(3);
    }
    if (status >= 200 && status < 300) return JSON.parse(body);
    if (status >= 500 && attempt < 4) continue;
    if (soft) return null;
    console.error(`GET ${pathname} -> ${status} — cannot evaluate; re-invoke.`);
    process.exit(2);
  }
}

// The one POST in this script, and it is a READ: a GraphQL query (never a
// mutation — pinned by test) for review-thread resolution, which REST does
// not expose.
//
// GraphQL is REFUSED OUTRIGHT (403, not scoped to any query) in the Claude
// Code remote container the orchestrator actually runs in — measured on
// #4223's own merge and filed as #4231, where exit 2's "re-invoke" never
// terminated. A 403 therefore returns `forbidden` and the caller degrades
// honestly over REST: zero review-comment threads is a REST-observable PROOF
// that zero threads are unresolved, and any threads at all fail the gate as
// "resolution unknown" — a human looks, or CI's wrapper (where GraphQL
// works) supplies the full verdict as the merge-gate status. Every other
// non-200 stays exit 2: transient, re-invoke.
function unresolvedThreads(owner, name) {
  const query =
    "query($owner:String!,$name:String!,$number:Int!,$cursor:String){" +
    "repository(owner:$owner,name:$name){pullRequest(number:$number){" +
    "reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor}" +
    "nodes{isResolved path comments(first:1){nodes{body}}}}}}}";
  const nodes = [];
  let cursor = null;
  for (;;) {
    const { status, body } = curl([
      "-H",
      `Authorization: Bearer ${token}`,
      "-X",
      "POST",
      "-d",
      JSON.stringify({
        query,
        variables: { owner, name, number: Number(prNumber), cursor },
      }),
      "https://api.github.com/graphql",
    ]);
    if (status === 403) return { kind: "forbidden" };
    if (status !== 200) {
      console.error(`graphql -> ${status} — cannot evaluate; re-invoke.`);
      process.exit(2);
    }
    const page = JSON.parse(body).data?.repository?.pullRequest?.reviewThreads;
    if (!page) {
      console.error("graphql returned no reviewThreads — cannot evaluate.");
      process.exit(2);
    }
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return { kind: "threads", unresolved: nodes.filter((t) => !t.isResolved) };
}

function paged(pathname) {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = gh(`${pathname}?per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

const pr = gh(`repos/${repo}/pulls/${prNumber}`);
const head = pr.head.sha;
const failures = [];
const pass = (label) => console.log(`PASS: ${label}`);
const fail = (label) => {
  failures.push(label);
  console.log(`FAIL: ${label}`);
};
console.log(`PR #${prNumber} head ${head.slice(0, 8)} (${pr.state})`);

const readiness = readinessVerdict(pr);
for (const failure of readiness.failures) fail(failure);
if (readiness.ready) pass("PR is READY");

// The title rule (#4983). Checked here, before any evidence is gathered,
// because it is a property of the PR itself and the cheapest failure to fix —
// and because a squash merge takes this title as the commit subject, so a
// title nobody refused is one `git log` carries forever. The refusal quotes
// the rule rather than pointing at it: the reader is about to rewrite the
// title and should not have to go and look it up first.
const titleRefusal = titleRuleRefusal("PR", pr.title);
if (titleRefusal) fail(titleRefusal);
else pass(`PR title is one clause of ${titleLength(pr.title)} characters`);

// The receipt: a stated-SHA review, because stating the SHA is what the
// review contract requires — review.commit_id records where GitHub filed it,
// but the RECEIPT is the reviewer's own claim about what they reviewed.
//
// THE SHARED-IDENTITY CASE (#4258): the orchestrator and every lane it
// dispatches post as one GitHub account, so on a lane's PR a genuine
// independent review is an "author review" and an identity test rejects it
// on the wrong property — a false negative on the ordinary case, which is
// how a gate gets routinely overridden. With one identity, "somebody looked
// who did not write it" can only ever be a STATED CLAIM, so that is what the
// gate checks there: the review must state the head SHA and assert the
// reviewer did not author the change. Where identities actually differ, the
// identity check still stands — it is the stronger evidence when it exists.
const reviews = paged(`repos/${repo}/pulls/${prNumber}/reviews`);
const receipt = receiptVerdict(pr, reviews, head);
if (receipt.ok) pass(receipt.message);
else fail(receipt.message);

const standing = reviews.filter(
  (r) => r.state === "CHANGES_REQUESTED" && r.user?.login !== pr.user?.login
);
if (standing.length)
  fail(
    `standing CHANGES_REQUESTED from ${standing.map((r) => r.user.login).join(", ")}`
  );

const all_runs = [];
let fetched_count = 0;
for (let page = 1; ; page++) {
  const batch = gh(
    `repos/${repo}/commits/${head}/check-runs?per_page=100&page=${page}`
  );
  fetched_count = batch.total_count;
  all_runs.push(...batch.check_runs);
  if (all_runs.length >= fetched_count) break;
}
// The base branch's own detector, said out loud where the merge is decided
// (#4722). Advisory: a soft read, and never a `fail()` — see the core.
const baseRef = pr.base?.ref ?? "main";
const baseRuns = gh(
  `repos/${repo}/commits/${baseRef}/check-runs?per_page=100`,
  true
);
console.log(
  baseRuns
    ? `NOTE: ${baseDetectorNotice(baseRuns.check_runs ?? [], baseRef)}`
    : `NOTE: could not read ${baseRef}'s check runs — e2e-main standing unknown`
);

const checks = checkRunsVerdict(all_runs, ignoreCheck, head);
if (checks.ignored) {
  console.log(`(ignoring check "${ignoreCheck}" — the gate's own wrapper)`);
}
if (checks.kind === "incomplete") {
  console.log(checks.message);
  process.exit(2);
}
if (checks.kind === "fail") fail(checks.message);
else pass(checks.message);

const [owner, name] = repo.split("/");
const threads = unresolvedThreads(owner, name);
if (threads.kind === "forbidden") {
  // The #4231 degrade: REST review comments cannot say RESOLVED, but a
  // top-level count of zero proves zero threads are unresolved.
  const comments = paged(`repos/${repo}/pulls/${prNumber}/comments`);
  const topLevel = comments.filter((c) => !c.in_reply_to_id);
  if (topLevel.length === 0) {
    pass(
      "zero review-comment threads (GraphQL 403; proven over REST — no " +
        "thread exists to be unresolved)"
    );
  } else {
    fail(
      `GraphQL refused (403) and ${topLevel.length} review-comment thread(s) ` +
        "exist — resolution UNKNOWN from this host. Verify each by eye and " +
        "record the override in the PR thread, or read the merge-gate commit " +
        "status, which CI computes where GraphQL works."
    );
    for (const c of topLevel)
      console.log(
        `  ${c.path ?? "(no file)"}: ${(c.body ?? "").split("\n")[0].slice(0, 100)}`
      );
  }
} else if (threads.unresolved.length) {
  fail(`${threads.unresolved.length} unresolved review thread(s):`);
  for (const t of threads.unresolved)
    console.log(
      `  ${t.path ?? "(no file)"}: ${(t.comments.nodes[0]?.body ?? "")
        .split("\n")[0]
        .slice(0, 100)}`
    );
} else pass("zero unresolved review threads");

if (failures.length) {
  console.log(
    `GATE CLOSED — ${failures.length} failure(s) on ${head.slice(0, 8)}.`
  );
  // Machine-readable for the workflow wrapper. The first failure is the first
  // clause the evaluator found, and the description stays inside GitHub's limit.
  console.log(`STATUS: ${closedStatusDescription(failures[0])}`);
  process.exit(1);
}
console.log(
  `GATE OPEN — head ${head.slice(0, 8)} may merge. Re-read head.sha in the ` +
    "same breath as the merge call (review-merge.md §Merge)."
);
process.exit(0);
