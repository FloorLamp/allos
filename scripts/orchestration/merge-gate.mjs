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
//   4. every check run AND every commit status on the head is completed and
//      green (#5022) — two disjoint endpoints, one verdict, each row naming
//      which endpoint it came from. The gate's own `merge-gate` status is the
//      one exception: it is this script's own last answer, so it is recomputed
//      here rather than read back (merge-gate-core.mjs says why). This is a
//      single sample — settlement (registration still growing) is
//      ci-watch.mjs's job, so run that first; incomplete CI here exits 2, not 0;
//   5. zero unresolved review threads (a GraphQL read; outdated-but-unresolved
//      still counts, because the finding may still apply to the new head).
//      Where this host's proxy refuses GraphQL outright (#4231), zero REST
//      comment threads proves the same thing; any threads fail the gate as
//      resolution-unknown rather than blocking every merge on exit 2;
//   6. no MERGE-HOLD standing, and — when
//      `adversarial-review-brief.mjs --check` says MANDATORY — a falsifying
//      pass that SURVIVED this exact head (#5126). Both are notes on the PR,
//      in merge-gate-core.mjs's one marker grammar, read from reviews AND PR
//      comments because that is where the #5112 hold was actually written;
//   7. that the PR belongs to the SESSION running the gate (#5177), where the
//      host says which session that is. Two orchestrators post as one GitHub
//      account, so the body's session footer is the only discriminator there
//      is; a PR with no footer is reported as UNKNOWN, never as yours;
//   8. that the tree which will LAND has been checked (#5235). Every check
//      above is about ONE head; this one is about the merge. When the base has
//      moved since this head's CI base by a commit that could carry a type,
//      only a MERGED-TREE-CHECKED receipt on this exact head opens the gate.
//      The core holds that judgment and states its own limit.
//
// It also PRINTS, without gating on it, what `e2e-main` says about the base
// branch (#4722): that workflow reports on main, never on a PR head, so main
// stayed red there for eight merges while every PR read green.
//
// Usage:
//   node scripts/orchestration/merge-gate.mjs <pr-number> [--repo owner/name]
//     [--ignore-check <name>] [--session <id>] [--adopt-pr]
//
// --session names the running orchestrator session for check 7; without it the
// gate reads $CLAUDE_CODE_REMOTE_SESSION_ID, and where neither exists it says
// the check went UNRUN rather than reporting a pass it never computed.
// --adopt-pr is the deliberate escape for landing the other session's PR — the
// shape #5152's --adopt-claim already established. Landing it is sometimes
// right; the point is that it be a decision someone takes.
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

import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { helpGuard } from "./usage.mjs";
import { resolveReadToken } from "./host.mjs";
import {
  baseDetectorNotice,
  ciVerdict,
  closedStatusDescription,
  falsifyingPassVerdict,
  holdVerdict,
  markerLines,
  normaliseSession,
  ownershipVerdict,
  readinessVerdict,
  receiptVerdict,
  RECEIPT_MARKER,
  baseMovedVerdict,
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
const sessionFlag = args.indexOf("--session");
const selfSession = normaliseSession(
  sessionFlag === -1
    ? process.env.CLAUDE_CODE_REMOTE_SESSION_ID
    : args[sessionFlag + 1]
);
const adoptPr = args.includes("--adopt-pr");

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

// WHOSE PR IS THIS (#5177). Checked here for the same reason the title is:
// it is a property of the PR itself, and it is the question that has to be
// answered BEFORE any of the evidence below is worth gathering. `note` covers
// the two cases that are not answers — no session link in the body, and no
// running session to compare it to — and neither prints as a PASS.
const ownership = ownershipVerdict(pr, selfSession, adoptPr);
if (ownership.severity === "fail") fail(ownership.message);
else if (ownership.severity === "note")
  console.log(`NOTE: ${ownership.message}`);
else pass(ownership.message);

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

// The markers (#5126). Reviews AND top-level PR comments, because the #5112
// hold was written in both and reading only one would have missed it in
// exactly the case the issue is about.
const prComments = paged(`repos/${repo}/issues/${prNumber}/comments`);
const notes = [
  ...reviews.map((r) => ({
    body: r.body,
    at: r.submitted_at ?? "",
    user: r.user?.login ?? "someone",
  })),
  ...prComments.map((c) => ({
    body: c.body,
    at: c.created_at ?? "",
    user: c.user?.login ?? "someone",
  })),
];

const hold = holdVerdict(notes);
if (hold.held) fail(hold.message);
else if (hold.message) pass(hold.message);

// The MANDATORY verdict, computed HERE rather than remembered. `--check` is the
// same tool the runbook tells the orchestrator to run; running it from inside
// the gate is what turns its answer from a thing someone has to act on into a
// precondition that cannot be skipped.
//
// A GUARD MUST NOT FAIL INTO ITS PERMISSIVE ANSWER — the rule
// adversarial-review-brief.mjs states for its own exit codes governs the
// caller too. Exit 2 there means "I could not read the PR", which is not
// "ordinary": it closes this gate with that named as the reason. #4231 is why
// it closes rather than exiting 2 for a re-invoke that may never terminate.
function mandatoryGrounds() {
  if (repo !== "FloorLamp/allos")
    return {
      grounds: null,
      refusal:
        `adversarial-review-brief.mjs reads FloorLamp/allos only, and this run ` +
        `is --repo ${repo} — the MANDATORY question is UNANSWERED here, which ` +
        "is not the same as answered 'ordinary' (#5126)",
    };
  const script = fileURLToPath(
    new URL("./adversarial-review-brief.mjs", import.meta.url)
  );
  const run = spawnSync(process.execPath, [script, prNumber, "--check"], {
    encoding: "utf8",
    timeout: 120_000,
  });
  const said = (run.stderr ?? "").trim();
  if (run.status === 0)
    return {
      grounds: said.split("\n").slice(0, 6).join(" · ") || "MANDATORY",
      refusal: null,
    };
  if (run.status === 1 || run.status === 3)
    return { grounds: null, refusal: null };
  return {
    grounds: null,
    refusal:
      `adversarial-review-brief.mjs --check could not answer (exit ` +
      `${run.status ?? "no exit code"}${said ? `: ${said.split("\n")[0]}` : ""}) — ` +
      "so whether a falsifying pass is mandated is UNKNOWN, and unknown is not " +
      "ordinary (#5126). Re-run it by hand and merge on what it says",
  };
}

const mandate = mandatoryGrounds();
if (mandate.refusal) fail(mandate.refusal);
const falsifying = falsifyingPassVerdict(notes, head, mandate.grounds);
if (falsifying.kind === "not-required") {
  if (!mandate.refusal)
    console.log(
      "NOTE: adversarial-review-brief.mjs --check does not say MANDATORY on " +
        "this head — no falsifying pass is required"
    );
} else if (falsifying.ok) pass(falsifying.message);
else fail(falsifying.message);

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

// HAS THE LANDING TREE BEEN CHECKED? (#5235) One comparison, three-dot, which
// answers all of it at once: `merge_base_commit` is the head's CI base, the
// `commits` are what the base branch gained since, and `files` is what they
// touched. A `soft` read, because a comparison that goes dark must reach the
// verdict as "cannot tell" rather than exiting the gate — and cannot-tell
// REFUSES there, since a base-moved check that fails open licenses the merge it
// was written to question.
// The ref goes in unencoded, as it does in the base-detector read above: a
// branch name with a slash is a path segment to this endpoint, not an escape.
const comparison = gh(`repos/${repo}/compare/${head}...${baseRef}`, true);
const landedCommits = comparison?.commits ?? [];
const receipts = markerLines(notes, RECEIPT_MARKER);
const baseMoved = baseMovedVerdict({
  head,
  baseRef,
  // The last commit of a three-dot comparison IS the target's tip, so a
  // truncated page would silently name the wrong one — which `truncated`
  // refuses on rather than reporting a base that was never checked.
  baseTip: landedCommits.length
    ? landedCommits[landedCommits.length - 1].sha
    : comparison?.merge_base_commit?.sha,
  ciBase: comparison?.merge_base_commit?.sha,
  landed: landedCommits.map((c) => ({ sha: c.sha })),
  landedFiles: (comparison?.files ?? []).map((f) => f.filename),
  truncated:
    !comparison ||
    landedCommits.length < (comparison.total_commits ?? 0) ||
    (comparison.files ?? []).length >= 300,
  marks: receipts.found,
  unread: receipts.ignored.length
    ? ` NOTE: ${receipts.ignored.length} ${RECEIPT_MARKER} line(s) here QUOTE and were NOT read (#5183).`
    : "",
});
if (baseMoved.ok) pass(baseMoved.message);
else fail(baseMoved.message);

// BOTH ENDPOINTS, ONE VERDICT (#5022). A commit's statuses live on their own
// endpoint and are invisible to `/check-runs`; this gate read only the first
// until now, so a red posted by anything other than Actions could not close it.
// A read that FAILS exits 2 through `gh` rather than answering `[]` — an
// unreadable status must refuse, because "I could not see it" reading as
// "there was nothing there" is the reassuring-lie direction this gate exists
// to refuse. The gate's own `merge-gate` context is excluded inside `ciVerdict`
// (see GATE_STATUS_CONTEXT) and recomputed by every check above.
const combined = gh(`repos/${repo}/commits/${head}/status`);
const checks = ciVerdict({
  checkRuns: all_runs,
  statuses: combined.statuses ?? [],
  ignoreCheck,
  head,
});
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
