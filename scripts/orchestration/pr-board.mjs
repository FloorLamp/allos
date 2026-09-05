// The orchestrator's PR glance (plain Node, no deps).
//
// WHY THIS IS NOT ci-watch.mjs. That script answers "is THIS pr settled, and may
// I merge it" — a verdict about one PR, derived from two matching polls, blocking
// until it can say. This one answers a different question, the one asked twenty
// times a night: "what is the state of everything open right now, and if
// something is red, WHY". It samples once, never blocks, and issues no verdict.
// Same reason the repo keeps `getDailySleepSessionsSince` beside the stream read:
// two questions that look alike and are not.
//
// WHAT IT REPLACES, and what that cost. Both halves were hand-run all night as
// throwaway curl-plus-python pipelines:
//
//   1. The status glance. Rewritten from memory each time, which is how `$?`
//      after a pipe got read as the script's exit code twice — the pipeline
//      reports `tail`'s status, so a settled-red run was announced as green
//      until the correction. A script cannot make that mistake on your behalf.
//
//   2. The failure detail, which is the expensive one. The obvious route is the
//      job log, and it is a trap: the raw-log endpoint 302s to a blob host the
//      agent proxy refuses (curl exit 56, `CONNECT tunnel failed, 403`), and the
//      MCP log reader returns the tail of a ~1,900-line file — which on a green-
//      but-for-one-spec shard is ninety lines of artifact-upload chatter and no
//      failure at all. Two fetches, ~10k tokens, nothing learned.
//
//      The check-run ANNOTATIONS endpoint carries exactly the failing spec, its
//      assertion, and the source excerpt, in a few hundred bytes. Everything a
//      diagnosis needs and nothing else. That is the whole trick, and finding it
//      by accident after burning the context is why it is written down here.
//
//   3. Both CI endpoints, together. A commit's check runs and its commit statuses
//      are disjoint sets on separate endpoints, and the merge gate lives only in
//      the second — see the comment on the status read below for how that printed
//      GREEN over a closed gate.
//
// Usage:
//   node scripts/orchestration/pr-board.mjs                 # every open PR
//   node scripts/orchestration/pr-board.mjs 2634 2639       # just these
//   node scripts/orchestration/pr-board.mjs --why           # + annotations for red
//
// Exit 0 always: a glance is not a verdict. Use ci-watch.mjs for the merge gate.

import { execFileSync } from "node:child_process";
import { helpGuard } from "./usage.mjs";
import { resolveReadToken } from "./host.mjs";
import { ciRows, rowName } from "./merge-gate-core.mjs";
helpGuard(process.argv, import.meta.url);

const token = resolveReadToken();
if (!token) {
  // The unauthenticated read returns an error body that parses to nothing, which
  // renders as "no failures" — a lie in the reassuring direction (ci-watch.mjs
  // carries the same assertion for the same reason).
  console.error(
    'BLOCKED: no GH_TOKEN/GITHUB_TOKEN and no authenticated gh. Refusing to poll — an\nunauthenticated read reads as "nothing is wrong". Re-mint with add_repo access:"push".'
  );
  process.exit(3);
}

const args = process.argv.slice(2);
const why = args.includes("--why");
const wanted = args.filter((a) => /^\d+$/.test(a)).map(Number);
const repoArg = args.indexOf("--repo");
const repo = repoArg >= 0 ? args[repoArg + 1] : "FloorLamp/allos";

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
        `https://api.github.com/repos/${repo}/${pathname}`,
      ],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }
    );
  } catch (err) {
    console.error(`GET ${pathname} failed: ${err.message}`);
    return null;
  }
  try {
    return JSON.parse(out);
  } catch {
    console.error(`GET ${pathname} returned a non-JSON body`);
    return null;
  }
}

const open = gh("pulls?state=open&per_page=50");
if (!Array.isArray(open)) process.exit(3);
const prs = wanted.length
  ? open.filter((p) => wanted.includes(p.number))
  : open;
// Missing numbers are said out loud rather than silently dropped — asking about a
// merged PR and getting a clean empty board is the reassuring-lie shape again.
for (const n of wanted) {
  if (!prs.some((p) => p.number === n)) {
    console.log(`#${n} — not open (merged, closed, or wrong number)`);
  }
}

const red = [];
for (const p of prs.sort((a, b) => a.number - b.number)) {
  const runs = gh(`commits/${p.head.sha}/check-runs?per_page=100`);
  const list = runs?.check_runs ?? [];
  // TWO ENDPOINTS, TWO ANSWERS, AND ONLY THE SECOND ONE BLOCKS. A commit carries
  // check runs (what Actions jobs post) and COMMIT STATUSES (what an external
  // reporter posts) in two disjoint sets, and neither endpoint mentions the
  // other's rows. `merge-gate` posts a STATUS. So a board reading only check-runs
  // prints GREEN for a PR whose gate is closed — this one did, on #4739: 19/19
  // check runs success, one of them named `merge-gate-job`, beside a failing
  // `merge-gate` status saying "gate CLOSED — no exact-head receipt". The name
  // collision is the trap; the run that LOOKS like the gate is not the gate.
  // Three separate lanes were misled by this same split in a single day, so the
  // fix is not "remember to check statuses too" — it is that one row of this
  // board can no longer be green while either endpoint is red.
  const combined = gh(`commits/${p.head.sha}/status`);
  // A read that FAILED is not an empty one. `gh` answers null on a transport
  // or parse failure, and `?? []` used to turn that into "no statuses" — the
  // reassuring-lie shape this file warns about twice above. It is its own
  // state now, and it keeps the row off GREEN.
  const unreadable = combined === null;
  const ctx = Array.isArray(combined?.statuses) ? combined.statuses : [];
  // ONE READER, SHARED WITH THE GATE AND THE WATCHER (#5022): the cancelled-run
  // reading (#4800, #4802) and the `neutral`/`skipped` alignment live in
  // merge-gate-core.mjs, so the three tools cannot drift on what a row means.
  const { rows, noVerdict } = ciRows({ checkRuns: list, statuses: ctx });
  const ok = rows.filter((r) => r.state === "success").length;
  // A name whose every run was cancelled has no verdict — not green, and not
  // red either. It counts as outstanding so the row cannot read GREEN, and the
  // row says which name, because "re-run it" is the action and a bare `0/1`
  // does not say that.
  const pending =
    rows.filter((r) => r.state === "pending").length + noVerdict.length;
  const failed = rows.filter((r) => r.state === "failed");
  const total = rows.length + noVerdict.length;
  const state = failed.length
    ? `RED ${failed.length}`
    : unreadable
      ? "status?"
      : pending
        ? `run ${ok}/${total}`
        : total
          ? "GREEN"
          : "no CI";
  // Named on the row, not just counted: "RED 1" beside twenty green check runs
  // reads as a flaky shard, and the one thing it can be instead — a closed merge
  // gate — is the thing that changes what you do next.
  const gate = failed.length
    ? `  <<< ${failed
        .map((r) => `${rowName(r)} ${r.detail}`)
        .join(", ")
        .slice(0, 90)}`
    : "";
  const dark = unreadable
    ? "  <<< commit statuses UNREADABLE — this row is check-runs only"
    : "";
  const stalled = noVerdict.length
    ? `  <<< no verdict: ${noVerdict.join(", ").slice(0, 60)} (every run cancelled — re-run it)`
    : "";
  // mergeable is computed lazily by GitHub and is null on a cold read; say
  // "unknown" rather than implying a conflict that may not exist.
  const merge =
    p.mergeable === false
      ? " CONFLICT"
      : p.mergeable === null
        ? " (mergeable unknown)"
        : "";
  // AN APPROVAL IS FOR A COMMIT, NOT FOR A PR. GitHub stamps every review with
  // the `commit_id` it was written against and then keeps showing "Approved" on
  // the PR after the head moves, so the reassuring word outlives the thing it
  // was about — the same shape as the flight recorder's soothing all-clear.
  //
  // Observed on #2665: approved at 1a03b4ae after reading a diff that moved two
  // sessionStorage keys into lib/, then the author replaced the whole approach
  // with one that changes no product file at all. Everything a merge gate
  // normally looks at still said yes — approved, green, author quiet — and
  // merging would have shipped the superseded design and discarded the better
  // one. Nothing in the board could see it, which is why it is here and not in
  // a runbook: "re-read the diff before merging" is advice, and this is a check.
  const reviews = gh(`pulls/${p.number}/reviews?per_page=100`);
  let stale = "";
  if (Array.isArray(reviews)) {
    // Last verdict wins — an approval after a changes-requested supersedes it.
    const verdicts = reviews.filter(
      (r) => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED"
    );
    const last = verdicts[verdicts.length - 1];
    if (last?.state === "APPROVED" && last.commit_id !== p.head.sha) {
      stale = `  <<< APPROVAL IS STALE: approved ${String(last.commit_id).slice(0, 7)}, head is ${p.head.sha.slice(0, 7)} — RE-READ THE DIFF`;
    }
  }
  console.log(
    `#${p.number} ${p.draft ? "draft " : ""}${state.padEnd(9)} ${p.head.ref.slice(0, 34).padEnd(34)} ${p.title.slice(0, 46)}${merge}${gate}${dark}${stalled}${stale}`
  );
  if (failed.length) red.push({ pr: p.number, failed });
}

if (!why || !red.length) {
  if (red.length) console.log("\n(--why prints each failure's annotation)");
  process.exit(0);
}

// The annotations, which is the part worth having.
for (const { pr, failed } of red) {
  for (const r of failed) {
    console.log(`\n=== #${pr} ${rowName(r)} (${r.detail}) ===`);
    if (r.source === "status") {
      // Statuses have no annotations; what they have is the description line the
      // reporter wrote, which for merge-gate is the closure reason itself.
      console.log(`  ${r.detail ?? "(no description)"}`);
      if (r.url) console.log(`  ${r.url}`);
      continue;
    }
    const anns = gh(`check-runs/${r.id}/annotations`);
    if (!Array.isArray(anns) || !anns.length) {
      console.log(`  (no annotations — ${r.url})`);
      continue;
    }
    for (const a of anns) {
      // The `.github` rows are the runner's own "exit code 1" and the summary
      // notice; the file-scoped rows carry the actual assertion. Print the
      // file-scoped ones in full and keep the summary short.
      const head = a.path && a.path !== ".github" ? a.path : "(summary)";
      const body = (a.message ?? "").trim();
      console.log(
        `  --- ${head}${a.start_line ? `:${a.start_line}` : ""} [${a.annotation_level}]`
      );
      console.log(
        body
          .split("\n")
          .map((l) => `  ${l}`)
          .join("\n")
      );
    }
  }
}
