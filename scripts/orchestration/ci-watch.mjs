// PR CI watcher (plain Node, no deps) — the checked-in version of the
// runbook's "CI watchers" rules, so they stop being advice that rots.
//
// Every rule here was an incident (docs/orchestration.md):
//   - NEVER hardcode the expected check count. A watcher written at 8 checks
//     silently accepted a 14-check repo the moment 9 registered; the CI shape
//     moved four times on 2026-08-10 alone. This watcher DERIVES settlement:
//     the registered check set must be identical across two consecutive polls
//     with nothing queued or in progress before any verdict is issued.
//   - A fresh push registers `gitleaks` first and alone for a window — a
//     sampled "all green" then is a false green. Wait for this head's CI
//     workflow run to complete before evaluating settlement.
//   - A conflict-dirty PR starts NO CI at all, so "1-2 runs registered" for many
//     polls means check `mergeable`, not wait longer. BUT `mergeable_state` is a
//     CACHED field that goes stale as a settled `dirty` (not `null`, so it does
//     not read as "computing"), and on 2026-08-29 a stale one made this script
//     report "NO CI will ever start" two minutes after all 18 checks had passed
//     on that exact head. So dirty is evaluated AFTER the checks and never
//     overrides a settled green — it blocks only while they are unsettled.
//   - An unauthenticated poll silently reports nothing (the curl 401s and the
//     parse yields empty), which reads as "no failures" — a lie in the
//     reassuring direction. The token is asserted before the first request.
//   - CHECK RUNS and COMMIT STATUSES are disjoint sets on two endpoints
//     (#5022). This watcher read only the first and printed GREEN on a head
//     whose `merge-gate` status said the gate was closed. Both are read now,
//     and every row names its endpoint — `merge-gate` the status and
//     `merge-gate-job` the check run differ by one word.
//   - Two matching fingerprints can BOTH land before a check registers, and
//     the late one is the merge gate (#5317). Settlement now also requires
//     that an `unstable` `mergeable_state` be EXPLAINED by something we see.
//
// Usage:
//   node scripts/orchestration/ci-watch.mjs <pr-number> \
//     [--repo owner/name] [--interval 30] [--max-minutes 9] [--once]
//
// --once takes two samples a few seconds apart (settlement needs two matching
// polls) and reports; without it, the watcher polls until settled or timeout.
//
// Exit codes: 0 settled green · 1 settled red (failures listed) ·
//   2 unsettled at timeout or --once (re-invoke; NOT a verdict) ·
//   3 blocked (no token, or conflict-dirty WITH unsettled checks, so no CI will
//     arrive; a dirty flag over a settled green prints a NOTE and exits 0).
//
// Run it as one blocking Bash call; --max-minutes defaults to 9 to fit under
// a 10-minute tool cap — exit 2 means "invoke me again", not "green".

import { execFileSync } from "node:child_process";
import { helpGuard } from "./usage.mjs";
import { resolveReadToken } from "./host.mjs";
import {
  ciRows,
  GATE_STATUS_CONTEXT,
  reachedAVerdict,
  rowName,
} from "./merge-gate-core.mjs";
helpGuard(process.argv, import.meta.url);

const token = resolveReadToken();
if (!token) {
  console.error(
    "BLOCKED: no GH_TOKEN/GITHUB_TOKEN and no authenticated gh. Refusing to\n" +
      "poll — an unauthenticated poll reads as 'no failures'. If a container\n" +
      'restart wiped the token, re-mint with add_repo access:"push" (see the\n' +
      "runbook's credential-loss section), then re-run."
  );
  process.exit(3);
}

const args = process.argv.slice(2);
const prNumber = args.find((a) => /^\d+$/.test(a));
if (!prNumber) {
  console.error(
    "usage: ci-watch.mjs <pr-number> [--repo owner/name] [--interval 30] [--max-minutes 9] [--once]"
  );
  process.exit(2);
}
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const repo = flag("--repo", "FloorLamp/allos");
const intervalSec = Number(flag("--interval", "30"));
const maxMinutes = Number(flag("--max-minutes", "9"));
const once = args.includes("--once");

// curl, not fetch: node's fetch ignores HTTP(S)_PROXY, and the managed
// environments route GitHub through an agent proxy — the identical token 401s
// through fetch and succeeds through curl. curl is also what every other
// runbook tool uses, so proxy/CA behavior stays uniform.
async function gh(pathname) {
  // Transient 5xxs are routine (a 503 was measured on this script's first real
  // run) and must never masquerade as a verdict: retry briefly, then exit 2
  // (re-invoke) — the exit-1 lane is reserved for a SETTLED RED.
  for (let attempt = 1; ; attempt++) {
    const out = execFileSync(
      "curl",
      [
        "-sS",
        "-w",
        "\n%{http_code}",
        "-H",
        `Authorization: Bearer ${token}`,
        "-H",
        "Accept: application/vnd.github+json",
        `https://api.github.com/${pathname}`,
      ],
      { encoding: "utf8", timeout: 30_000 }
    );
    const cut = out.lastIndexOf("\n");
    const status = Number(out.slice(cut + 1));
    if (status === 401) {
      console.error(
        "BLOCKED: GitHub answered 401 — the token exists but is bad/expired. Re-mint before trusting any poll."
      );
      process.exit(3);
    }
    if (status >= 200 && status < 300) return JSON.parse(out.slice(0, cut));
    if (status >= 500 && attempt < 4) {
      console.error(
        `GET ${pathname} -> ${status} (transient; retry ${attempt}/3)`
      );
      await new Promise((r) => setTimeout(r, attempt * 5_000));
      continue;
    }
    console.error(
      `GET ${pathname} -> ${status} — cannot poll right now. This is NOT a verdict; re-invoke.`
    );
    process.exit(2);
  }
}

async function checkRuns(sha) {
  const runs = [];
  for (let page = 1; ; page++) {
    const body = await gh(
      `repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`
    );
    runs.push(...body.check_runs);
    if (runs.length >= body.total_count) return runs;
  }
}

// THE OTHER ENDPOINT (#5022). One page, because the combined endpoint returns
// the NEWEST status per context and this repo cannot produce 100 of them. The
// top-level `state` is NOT read: it is `pending` for a commit with no statuses
// at all, which would leave every ordinary head unsettled forever. The
// per-context rows are the evidence, and an empty list is the "absent" case
// that must go on behaving exactly as it did.
const commitStatuses = async (sha) =>
  (await gh(`repos/${repo}/commits/${sha}/status?per_page=100`)).statuses ?? [];

// SETTLEMENT IS DERIVED FROM THE RAW SET AND THE VERDICT FROM THE FILTERED ONE,
// and that split is the whole design decision here. The fingerprint's job is to
// notice that the registered set has STOPPED MOVING, and a cancelled run
// arriving IS movement — it is a check suite registering, which is the one
// signal that more runs may still be coming. A cancelled run is `completed`, so
// it holds nothing pending; drop it from the fingerprint too and a suite that
// registers and is cancelled between two polls becomes invisible, and this
// watcher settles green in the middle of registration. Keeping it costs one
// extra poll on a superseded head and buys back the only thing watching for
// that — and being unsettled a poll too long is the safe direction, where a
// premature green is not.
function snapshot(runs, statuses) {
  const { rows, noVerdict } = ciRows({ checkRuns: runs, statuses });
  // THE GATE'S OWN STATUS IS REPORTED, NEVER RED HERE. The runbook posts the
  // receipt `merge-gate` asks for AFTER this watcher runs (dispatch.md steps
  // 3-6), so that context is legitimately `failure` on every healthy PR at the
  // moment anyone asks whether CI is green — reddening on it would red every
  // PR, every time, which is how a check gets ignored and then deleted. It
  // rides its own line instead, which is what #5022 asked for: not a different
  // exit code, but that `GREEN` stop meaning "the endpoint I read agrees".
  const echo = (row) =>
    row.source === "status" && row.name === GATE_STATUS_CONTEXT;
  const checks = rows.filter((row) => row.source === "check-run");
  return {
    rows,
    pending: rows.filter((row) => row.state === "pending"),
    failed: rows.filter((row) => row.state === "failed" && !echo(row)),
    gateClosed: rows.filter((row) => echo(row) && row.state !== "success"),
    noVerdict,
    // Identity of the registered set: names + ids, order-independent. Two equal
    // consecutive fingerprints with zero pending = registration has settled.
    // STATUSES ARE DELIBERATELY OUT OF IT: a status is REPLACED in place under
    // its context rather than registered alongside, so folding it in would make
    // the fingerprint move every time the gate re-posts the same verdict.
    fingerprint: runs
      .map((r) => `${r.name}#${r.id}`)
      .sort()
      .join("|"),
    total: runs.length,
    decided: checks.length,
    statuses: rows.length - checks.length,
  };
}

const deadline = Date.now() + maxMinutes * 60_000;
let lastFingerprint = null;
let polls = 0;

for (;;) {
  polls++;
  const pr = await gh(`repos/${repo}/pulls/${prNumber}`);
  const s = snapshot(
    await checkRuns(pr.head.sha),
    await commitStatuses(pr.head.sha)
  );

  // DIRTY IS CHECKED AFTER THE CHECKS, NOT BEFORE THEM, AND NEVER OVERRIDES A SETTLED
  // GREEN. `mergeable_state` is a CACHED field: GitHub serves a stale `dirty` — not
  // `null`, so it does not read as "still computing" — and will keep serving it until
  // something pokes the PR. Measured 2026-08-29 on #4016: all 18 checks had completed
  // `success` on the exact head at 11:00Z, and this script still reported "NO CI will
  // ever start" at 11:02Z, which sent a lane to reconcile a conflict that did not exist.
  // The two commits changed 72 files each with an EMPTY intersection, and all six
  // base/head pairings merged clean. So the instrument reported something other than
  // what its own next call could see — the exact defect class this session keeps
  // meeting, in the tool written to detect it.
  //
  // A settled green on the head is therefore the stronger evidence and wins. Dirty
  // still blocks when the checks have NOT settled, because there the original reasoning
  // holds: no merge ref means no run to wait for.
  //
  // AND THE COMPARISON HERE IS `.length`, NOT THE ARRAY. `s.pending === 0` on an
  // array is always false, so this branch was unreachable and every dirty read
  // took the BLOCKED exit — the #4016 fix below was written, documented, and
  // never once executed.
  if (pr.mergeable_state === "dirty") {
    if (
      s.total > 0 &&
      s.pending.length === 0 &&
      s.failed.length === 0 &&
      s.noVerdict.length === 0
    ) {
      console.error(
        `NOTE: PR #${prNumber} reads mergeable_state=dirty, but all ${s.decided} checks on\n` +
          `head ${pr.head.sha.slice(0, 8)} have settled and passed. The flag is stale —\n` +
          "verify with `git merge-tree --write-tree origin/main <head>` before treating it\n" +
          "as a conflict; a push to the branch clears a stale flag."
      );
    } else {
      console.error(
        `BLOCKED: PR #${prNumber} is conflict-dirty and its checks have not settled\n` +
          `(${s.total} registered, ${s.pending.length} pending, ${s.failed.length} failed). GitHub cannot build\n` +
          "the merge ref, so no new CI will start. Reconcile in a worktree — but confirm the\n" +
          "conflict locally first, because this flag is cached and goes stale."
      );
      process.exit(3);
    }
  }

  const { workflow_runs: ciRuns } = await gh(
    `repos/${repo}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=100`
  );
  const ci = ciRuns
    .filter(
      (run) => run.event === "pull_request" && run.head_sha === pr.head.sha
    )
    .sort((a, b) => b.id - a.id)[0];
  // The same reading for the workflow run itself: a cancelled CI run reached no
  // verdict, so it is neither a red nor a settled green. It reads as unsettled,
  // which is exit 2 — "re-invoke" — and a re-run is what it needs.
  const ciDecided = ci?.status === "completed" && reachedAVerdict(ci);
  if (ciDecided && ci.conclusion !== "success" && s.failed.length === 0)
    s.failed.push({
      source: "workflow-run",
      name: ci.name ?? "CI",
      state: "failed",
      detail: ci.conclusion,
      url: ci.html_url,
    });
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(
    `[${stamp}] ${s.total} checks + ${s.statuses} status(es) registered, ` +
      `${s.pending.length} pending, ${s.failed.length} failed` +
      ` (head ${pr.head.sha.slice(0, 8)}, mergeable_state=${pr.mergeable_state})`
  );

  // GREEN ONE CHECK EARLY (#5317). Two matching fingerprints answer "has the
  // registered set stopped moving" — and on 2026-09-05 the answer was yes
  // twice while `merge-gate-job` was still queued and unregistered, so this
  // watcher printed GREEN at 19 checks a minute before the twentieth arrived.
  // The check that registers late is the merge gate itself, so a merger
  // trusting that line acts before the gate that exists to stop a bad merge
  // has run.
  //
  // `mergeable_state` held the contradiction the whole time and this script
  // already had it on screen: it stayed `unstable` and went `clean` only when
  // the rollup completed. But it is `unstable` for ANY non-passing status too,
  // which on this repo is every pre-review head (`merge-gate` = "no exact-head
  // receipt"), so a flat "never settle while unstable" would hang on every
  // healthy PR — the too-strict half of the same mistake. So it blocks only
  // while it is UNEXPLAINED: everything both endpoints show us is green, and
  // GitHub still says unstable, which means something we cannot see yet.
  const unexplainedUnstable =
    pr.mergeable_state === "unstable" &&
    s.failed.length === 0 &&
    s.gateClosed.length === 0;
  const settled =
    ciDecided &&
    s.pending.length === 0 &&
    s.noVerdict.length === 0 &&
    s.total > 0 &&
    s.fingerprint === lastFingerprint &&
    !unexplainedUnstable;
  const waitingOn = [
    ciDecided ? null : "this head's CI workflow run to complete",
    s.pending.length
      ? `${s.pending.length} pending: ${s.pending.map(rowName).join(", ")}`
      : null,
    s.noVerdict.length
      ? `no verdict for ${s.noVerdict.join(", ")} (every run cancelled — re-run it)`
      : null,
    s.total === 0 ? "any check to register" : null,
    s.fingerprint === lastFingerprint
      ? null
      : polls === 1
        ? "a second sample (settlement needs two matching polls)"
        : "the registered set to stop moving (it changed between these two polls)",
    unexplainedUnstable
      ? "mergeable_state=unstable while every check run and commit status we can read is green — a check has not registered yet (#5317)"
      : null,
  ].filter(Boolean);
  lastFingerprint = s.fingerprint;

  if (settled) {
    if (s.failed.length) {
      // THE VERDICT GOES TO STDOUT TOO, and that is not a cosmetic choice.
      //
      // A RED written only to stderr can be lost — a background runner that captures
      // the streams separately, or interleaves them, leaves a log holding nothing but
      // the trailing advice block, and then the EXIT CODE is the only surviving
      // signal. Measured 2026-08-20 on PR #3307: the captured log was four lines of
      // preamble, the reported exit code was 0, and the PR had two failing checks.
      // The orchestrator nearly merged a red head on that log. A verdict that can be
      // dropped by the plumbing is not a verdict — print it where the log will keep
      // it, and keep stderr's copy for a human watching live.
      console.log(`RED — ${s.failed.length} failing check(s):`);
      for (const r of s.failed) console.log(`  ${r.detail}: ${rowName(r)}`);
      console.error(`RED — ${s.failed.length} failing check(s):`);
      for (const r of s.failed)
        console.error(`  ${r.detail}: ${rowName(r)}  ${r.url ?? ""}`);
      console.error(
        "Before diagnosing the branch: a job can be stamped `failure` with every step green —\n" +
          "read the STEPS; a red with no failing step is infrastructure, and a rerun —\n" +
          "only once ALL jobs completed — is the answer:\n" +
          '  curl -X POST -H "Authorization: Bearer $GH_TOKEN" \\\n' +
          "    https://api.github.com/repos/<owner>/<repo>/actions/runs/<run-id>/rerun-failed-jobs"
      );
      process.exit(1);
    }
    // THE VERDICT NAMES ITS ENDPOINTS (#5022). "all N registered checks" was a
    // claim about `/check-runs` alone, read by everyone as "this PR is good".
    console.log(
      `GREEN — all ${s.decided} check run(s) and ${s.statuses} commit ` +
        "status(es) settled and passing."
    );
    // The gate's own context, said out loud on both streams rather than folded
    // into the verdict: it is not a CI failure and it does not red this run,
    // but a reader who stops at GREEN must not miss that this head cannot
    // merge yet. `merge-gate.mjs` recomputes it before every merge.
    for (const r of s.gateClosed) {
      const line =
        `NOT MERGEABLE YET — ${rowName(r)} ${r.state}: ${r.detail}\n` +
        "  That is a commit status, not a check run, and merge-gate.mjs " +
        "recomputes it before every merge.";
      console.log(line);
      console.error(line);
    }
    if (pr.mergeable_state === "behind") {
      console.log(
        "CAUTION: the PR is BEHIND main — this green is a claim about the base it ran on. If a\n" +
          "CODE merge landed since these checks ran on an adjacent surface, update the branch and\n" +
          "let CI re-run before merging (runbook: 'a behind-only PR's green can be stale')."
      );
    }
    process.exit(0);
  }

  if ((once && polls >= 2) || Date.now() >= deadline) {
    // WHICH CONDITION, NOT "SOMETHING" (#5317). The old line named two
    // possibilities and left the reader to guess which held, which is how a
    // watcher waiting on an unregistered merge gate read as ordinary slowness.
    console.log(
      `UNSETTLED — waiting on: ${waitingOn.join("; ")}. This is NOT a verdict; re-invoke.` +
        (ci?.status === "completed" && !ciDecided
          ? " The CI workflow run itself was cancelled — re-run it."
          : "")
    );
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, (once ? 5 : intervalSec) * 1000));
}
