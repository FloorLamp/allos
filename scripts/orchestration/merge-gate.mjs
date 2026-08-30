// Merge gate — the checked-in version of review-merge.md §Merge's exact-head
// invariant (owner 2026-08-26, #3710): merge only a green exact head that a
// non-author reviewed, with zero unresolved findings. Until now that gate was
// a paragraph the orchestrator remembered; this makes it a script it runs.
//
// READ-ONLY by construction: no write verb leaves this script (pinned in
// lib/__tests__/merge-gate-script.test.ts). It answers one question — "may
// this PR merge RIGHT NOW?" — by checking, on the CURRENT head SHA:
//   1. the PR is open and READY (never draft — environment.md §GitHub access);
//   2. the RECEIPT: a review from a NON-AUTHOR whose body states this exact
//      head SHA (8+ hex chars of its prefix). A receipt naming any other SHA
//      is a review of a head that no longer exists — void, not evidence;
//   3. no standing CHANGES_REQUESTED review on this head;
//   4. every check run on the head is completed and green. This is a single
//      sample — settlement (registration still growing) is ci-watch.mjs's
//      job, so run that first; incomplete CI here exits 2, not 0;
//   5. zero unresolved review threads (a GraphQL read; outdated-but-unresolved
//      still counts, because the finding may still apply to the new head).
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

function gh(pathname) {
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
    console.error(`GET ${pathname} -> ${status} — cannot evaluate; re-invoke.`);
    process.exit(2);
  }
}

// The one POST in this script, and it is a READ: a GraphQL query (never a
// mutation — pinned by test) for review-thread resolution, which REST does
// not expose.
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
  return nodes.filter((t) => !t.isResolved);
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

if (pr.state !== "open") fail(`PR is ${pr.merged ? "merged" : pr.state}`);
if (pr.draft)
  fail("PR is DRAFT — PRs open READY (environment.md §GitHub access)");
else pass("PR is READY");

// The receipt: a stated-SHA review, because stating the SHA is what the
// review contract requires — review.commit_id records where GitHub filed it,
// but the RECEIPT is the reviewer's own claim about what they reviewed.
const reviews = paged(`repos/${repo}/pulls/${prNumber}/reviews`);
const statesHead = (body) =>
  [...(body ?? "").matchAll(/[0-9a-f]{8,40}/g)].some((m) =>
    head.startsWith(m[0])
  );
const receipt = reviews.find(
  (r) =>
    r.user?.login !== pr.user?.login &&
    ["COMMENTED", "APPROVED"].includes(r.state) &&
    statesHead(r.body)
);
if (receipt)
  pass(`exact-head receipt: ${receipt.user.login} states ${head.slice(0, 8)}`);
else {
  const staleReceipt = reviews.find(
    (r) =>
      r.user?.login !== pr.user?.login && /[0-9a-f]{8,40}/.test(r.body ?? "")
  );
  fail(
    staleReceipt
      ? `no receipt for ${head.slice(0, 8)} — the head changed since ` +
          `${staleReceipt.user.login}'s review, which VOIDS it; re-review this head`
      : "no exact-head receipt: no non-author review states this head SHA"
  );
}

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
const check_runs = all_runs.filter((r) => r.name !== ignoreCheck);
const total_count = check_runs.length;
if (ignoreCheck && all_runs.length !== check_runs.length) {
  console.log(`(ignoring check "${ignoreCheck}" — the gate's own wrapper)`);
}
const pending = check_runs.filter((r) => r.status !== "completed");
const red = check_runs.filter(
  (r) =>
    r.status === "completed" &&
    !["success", "neutral", "skipped"].includes(r.conclusion)
);
if (total_count === 0 || pending.length) {
  console.log(
    `CI INCOMPLETE on ${head.slice(0, 8)}: ${total_count} registered, ` +
      `${pending.length} pending. Not a verdict — run ci-watch.mjs to settlement.`
  );
  process.exit(2);
}
if (red.length) {
  fail(`red checks on this head: ${red.map((r) => r.name).join(", ")}`);
} else pass(`all ${total_count} checks green on this head`);

const [owner, name] = repo.split("/");
const open = unresolvedThreads(owner, name);
if (open.length) {
  fail(`${open.length} unresolved review thread(s):`);
  for (const t of open)
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
  process.exit(1);
}
console.log(
  `GATE OPEN — head ${head.slice(0, 8)} may merge. Re-read head.sha in the ` +
    "same breath as the merge call (review-merge.md §Merge)."
);
process.exit(0);
