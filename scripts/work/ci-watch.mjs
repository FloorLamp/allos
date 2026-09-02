// PR CI watcher (plain Node, no deps) — the checked-in version of the
// runbook's "CI watchers" rules, so they stop being advice that rots.
//
// Every rule here was an incident (docs/work.md):
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
//
// Usage:
//   node scripts/work/ci-watch.mjs <pr-number> \
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

function snapshot(runs) {
  const pending = runs.filter((r) => r.status !== "completed");
  const failed = runs.filter(
    (r) =>
      r.status === "completed" &&
      !["success", "neutral", "skipped"].includes(r.conclusion)
  );
  // Identity of the registered set: names + ids, order-independent. Two equal
  // consecutive fingerprints with zero pending = registration has settled.
  const fingerprint = runs
    .map((r) => `${r.name}#${r.id}`)
    .sort()
    .join("|");
  return { pending, failed, fingerprint, total: runs.length };
}

const deadline = Date.now() + maxMinutes * 60_000;
let lastFingerprint = null;
let polls = 0;

for (;;) {
  polls++;
  const pr = await gh(`repos/${repo}/pulls/${prNumber}`);
  const s = snapshot(await checkRuns(pr.head.sha));

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
  if (pr.mergeable_state === "dirty") {
    if (s.total > 0 && s.pending === 0 && s.failed === 0) {
      console.error(
        `NOTE: PR #${prNumber} reads mergeable_state=dirty, but all ${s.total} checks on\n` +
          `head ${pr.head.sha.slice(0, 8)} have settled and passed. The flag is stale —\n` +
          "verify with `git merge-tree --write-tree origin/main <head>` before treating it\n" +
          "as a conflict; a push to the branch clears a stale flag."
      );
    } else {
      console.error(
        `BLOCKED: PR #${prNumber} is conflict-dirty and its checks have not settled\n` +
          `(${s.total} registered, ${s.pending} pending, ${s.failed} failed). GitHub cannot build\n` +
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
  if (
    ci?.status === "completed" &&
    ci.conclusion !== "success" &&
    s.failed.length === 0
  )
    s.failed.push(ci);
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(
    `[${stamp}] ${s.total} checks registered, ${s.pending.length} pending, ${s.failed.length} failed` +
      ` (head ${pr.head.sha.slice(0, 8)}, mergeable_state=${pr.mergeable_state})`
  );

  const settled =
    ci?.status === "completed" &&
    s.pending.length === 0 &&
    s.total > 0 &&
    s.fingerprint === lastFingerprint;
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
      // The worker nearly merged a red head on that log. A verdict that can be
      // dropped by the plumbing is not a verdict — print it where the log will keep
      // it, and keep stderr's copy for a human watching live.
      console.log(`RED — ${s.failed.length} failing check(s):`);
      for (const r of s.failed) console.log(`  ${r.conclusion}: ${r.name}`);
      console.error(`RED — ${s.failed.length} failing check(s):`);
      for (const r of s.failed)
        console.error(`  ${r.conclusion}: ${r.name}  ${r.html_url}`);
      console.error(
        "Before diagnosing the branch: a job can be stamped `failure` with every step green —\n" +
          "read the STEPS; a red with no failing step is infrastructure, and a rerun —\n" +
          "only once ALL jobs completed — is the answer:\n" +
          '  curl -X POST -H "Authorization: Bearer $GH_TOKEN" \\\n' +
          "    https://api.github.com/repos/<owner>/<repo>/actions/runs/<run-id>/rerun-failed-jobs"
      );
      process.exit(1);
    }
    console.log(
      `GREEN — all ${s.total} registered checks settled and passing.`
    );
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
    console.log(
      "UNSETTLED — CI workflow incomplete or registration/pending not yet stable. This is NOT a verdict; re-invoke."
    );
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, (once ? 5 : intervalSec) * 1000));
}
