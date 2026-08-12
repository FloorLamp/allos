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
//     sampled "all green" then is a false green. Same fix: settlement first.
//   - A conflict-dirty PR starts NO CI at all. "1-2 runs registered" for many
//     polls means check `mergeable`, not wait longer — so mergeable_state is
//     checked FIRST and dirty exits immediately.
//   - An unauthenticated poll silently reports nothing (the curl 401s and the
//     parse yields empty), which reads as "no failures" — a lie in the
//     reassuring direction. The token is asserted before the first request.
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
//   3 blocked (no token, or conflict-dirty so no CI will ever arrive).
//
// Run it as one blocking Bash call; --max-minutes defaults to 9 to fit under
// a 10-minute tool cap — exit 2 means "invoke me again", not "green".

import { execFileSync } from "node:child_process";

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
if (!token) {
  console.error(
    "BLOCKED: neither GH_TOKEN nor GITHUB_TOKEN is set. Refusing to poll —\n" +
      "an unauthenticated poll reads as 'no failures'. If a container restart\n" +
      'wiped the token, re-mint with add_repo access:"push" (see the runbook\'s\n' +
      "credential-loss section), then re-run."
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
  if (pr.mergeable_state === "dirty") {
    console.error(
      `BLOCKED: PR #${prNumber} is conflict-dirty — GitHub cannot build the merge ref, so NO CI\n` +
        "will ever start. Reconcile the conflict in a worktree; do not wait on checks."
    );
    process.exit(3);
  }

  const s = snapshot(await checkRuns(pr.head.sha));
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(
    `[${stamp}] ${s.total} checks registered, ${s.pending.length} pending, ${s.failed.length} failed` +
      ` (head ${pr.head.sha.slice(0, 8)}, mergeable_state=${pr.mergeable_state})`
  );

  const settled =
    s.pending.length === 0 && s.total > 0 && s.fingerprint === lastFingerprint;
  lastFingerprint = s.fingerprint;

  if (settled) {
    if (s.failed.length) {
      console.error(`RED — ${s.failed.length} failing check(s):`);
      for (const r of s.failed)
        console.error(`  ${r.conclusion}: ${r.name}  ${r.html_url}`);
      console.error(
        "Before diagnosing the branch: a job can be stamped `failure` with every step green —\n" +
          "read the STEPS; a red with no failing step is infrastructure, and a rerun (via MCP\n" +
          "rerun_failed_jobs, only once all jobs completed) is the answer."
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
      "UNSETTLED — registration/pending not yet stable. This is NOT a verdict; re-invoke."
    );
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, (once ? 5 : intervalSec) * 1000));
}
